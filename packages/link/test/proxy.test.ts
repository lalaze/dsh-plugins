import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import net from 'node:net';
import { after, test } from 'node:test';
import zlib from 'node:zlib';
import { Admission, sameSite } from '../src/listener.js';
import { forwardHttp, forwardUpgrade, HOP_HEADER, locationUnder, request, requestHeaders, responseHeaders } from '../src/proxy.js';
import type { TailnetStatus } from '../src/tailscale.js';

const servers: http.Server[] = [];
const sockets = new Set<net.Socket>();
after(() => {
  for (const socket of sockets) socket.destroy();
  for (const server of servers) { server.closeAllConnections(); server.close(); }
});

async function serve(handler: http.RequestListener, upgrade?: (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => void): Promise<string> {
  const server = http.createServer(handler);
  if (upgrade) server.on('upgrade', (req, socket: net.Socket, head) => { sockets.add(socket); upgrade(req, socket, head); });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test('a hop forwards no browser credentials or markers, and passes no cookie back', () => {
  const headers = requestHeaders({ host: 'a', cookie: 'dsh-auth-x=1', origin: 'https://evil', referer: 'r', 'sec-fetch-site': 'same-origin', connection: 'keep-alive, x-secret', 'x-secret': '1', [HOP_HEADER]: '1', accept: 'text/html', 'sec-websocket-key': 'k' }, { host: 'b' });
  assert.deepEqual(headers, { accept: 'text/html', 'sec-websocket-key': 'k', host: 'b' });
  const back = responseHeaders({ 'set-cookie': ['a=1'], location: '/x?y', 'content-type': 'text/plain', 'transfer-encoding': 'chunked' }, locationUnder(new URL('http://100.1.1.1:7390'), '/dsh-link/peer/m1'));
  assert.deepEqual(back, { location: '/dsh-link/peer/m1/x?y', 'content-type': 'text/plain' });
  const rewrite = locationUnder(new URL('http://100.1.1.1:7390'), '/p');
  assert.equal(rewrite('http://100.1.1.1:7390/a#b'), '/p/a#b');
  assert.equal(rewrite('./'), './');
  assert.equal(rewrite('https://example.com/'), 'https://example.com/');
  assert.equal(rewrite('//example.com/'), '//example.com/');
});

test('an HTML document is rewritten (gzip undone), other bodies and event streams pass as they come', async () => {
  const upstream = await serve((req, res) => {
    if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip', etag: '"1"', 'set-cookie': 'x=1' }); res.end(zlib.gzipSync('<html><head></head><body>hi</body></html>')); return; }
    if (req.url === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: one\n\n');
      setTimeout(() => res.end('data: two\n\n'), 150);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ path: req.url, cookie: req.headers.cookie ?? null, hop: req.headers[HOP_HEADER] ?? null }));
  });
  const front = await serve((req, res) => forwardHttp(req, res, { target: new URL(req.url!, upstream), headers: requestHeaders(req.headers, { cookie: 'login=1', [HOP_HEADER]: '1' }), html: html => html.replace('<head>', '<head><script>x</script>') }));
  const page = await request(new URL('/', front), { headers: { accept: 'text/html' } });
  assert.equal(page.body.toString(), '<html><head><script>x</script></head><body>hi</body></html>');
  assert.equal(page.headers['content-encoding'], undefined);
  assert.equal(page.headers.etag, undefined);
  assert.equal(page.headers['set-cookie'], undefined);
  const api = JSON.parse((await request(new URL('/api/x?y=1', front), { headers: { cookie: 'browser=1' } })).body.toString());
  assert.deepEqual(api, { path: '/api/x?y=1', cookie: 'login=1', hop: '1' });
  const chunks: { at: number; text: string }[] = [];
  const start = Date.now();
  await new Promise<void>((resolve, reject) => http.get(new URL('/events', front), res => {
    res.setEncoding('utf8');
    res.on('data', text => chunks.push({ at: Date.now() - start, text }));
    res.on('end', resolve);
  }).on('error', reject));
  assert.equal(chunks.map(chunk => chunk.text).join(''), 'data: one\n\ndata: two\n\n');
  assert.ok(chunks[0]!.at < 120, `the first event came after ${chunks[0]!.at} ms`);
});

test('an upstream that is not there is a short 502 the caller hears about', async () => {
  const closed = await serve(() => undefined);
  const port = new URL(closed).port;
  await new Promise<void>(resolve => { servers.at(-1)!.close(() => resolve()); });
  let unreachable = 0;
  const front = await serve((req, res) => forwardHttp(req, res, { target: new URL(req.url!, `http://127.0.0.1:${port}`), headers: {}, onUnreachable: () => { unreachable++; } }));
  const answer = await request(new URL('/', front));
  assert.equal(answer.status, 502);
  assert.match(answer.body.toString(), /nothing listens there/);
  assert.equal(unreachable, 1);
});

test('a WebSocket upgrade goes through with its handshake headers and carries bytes both ways', async () => {
  const upstream = await serve(() => undefined, (req, socket) => {
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${req.headers['sec-websocket-key']}\r\nSet-Cookie: leak=1\r\nX-Cookie-Seen: ${req.headers.cookie}\r\n\r\n`);
    socket.on('data', data => socket.write(`echo:${data}`));
  });
  const front = await serve(() => undefined, (req, socket, head) => forwardUpgrade(req, socket, head, { target: new URL(req.url!, upstream), headers: requestHeaders(req.headers, { cookie: 'login=1' }) }));
  const socket = net.connect(Number(new URL(front).port), '127.0.0.1');
  socket.write('GET /api/remote.mux HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: abc\r\nSec-WebSocket-Version: 13\r\nCookie: browser=1\r\nOrigin: http://x\r\n\r\n');
  let text = '';
  await new Promise<void>(resolve => socket.on('data', data => {
    text += data.toString();
    if (text.includes('\r\n\r\n') && !text.includes('echo:')) socket.write('ping');
    if (text.includes('echo:ping')) resolve();
  }));
  socket.destroy();
  assert.match(text, /^HTTP\/1.1 101 /);
  assert.match(text, /Sec-WebSocket-Accept: abc/);
  assert.match(text, /X-Cookie-Seen: login=1/);
  assert.doesNotMatch(text, /Set-Cookie/i);
});

const STATUS: TailnetStatus = {
  running: true, peers: [],
  self: { id: 'n1', name: 'mini', dnsName: 'mini.tail.ts.net', os: 'macOS', ips: ['100.96.195.115', 'fd7a::1'], userId: '15042353428159710', online: true, tagged: false },
};
const fakeRequest = (headers: http.IncomingHttpHeaders, ip: string) => ({ headers, socket: { remoteAddress: `::ffff:${ip}` } }) as unknown as http.IncomingMessage;

test('admission: own name, same site, not from itself, the same tailnet user', async () => {
  let lookups = 0;
  const users: Record<string, string> = { '100.125.78.115': '15042353428159710', '100.1.1.1': '15042353428159711' };
  const admission = new Admission(STATUS, '100.96.195.115', false, async ip => { lookups++; return users[ip] ? { userId: users[ip]!, node: ip } : undefined; });
  const host = '100.96.195.115:7390';
  assert.equal((await admission.check(fakeRequest({ host: 'evil.example:7390' }, '100.125.78.115'))).status, 421);
  assert.equal((await admission.check(fakeRequest({ host, origin: 'http://evil.example' }, '100.125.78.115'))).status, 403);
  assert.equal((await admission.check(fakeRequest({ host, 'sec-fetch-site': 'cross-site' }, '100.125.78.115'))).status, 403);
  assert.equal((await admission.check(fakeRequest({ host }, '100.96.195.115'))).reason, 'self');
  assert.equal((await admission.check(fakeRequest({ host }, '100.1.1.1'))).reason, 'user');
  assert.equal((await admission.check(fakeRequest({ host }, '192.168.0.9'))).reason, 'user');
  assert.equal((await admission.check(fakeRequest({ host, origin: `http://${host}` }, '100.125.78.115'))).status, undefined);
  assert.equal((await admission.check(fakeRequest({ host: 'mini.tail.ts.net:7390' }, '100.125.78.115'))).status, undefined);
  assert.equal(lookups, 3, 'one whois per address');
  const self = new Admission(STATUS, '100.96.195.115', true, async () => ({ userId: '15042353428159710', node: 'mini' }));
  assert.equal((await self.check(fakeRequest({ host }, '100.96.195.115'))).status, undefined);
});

test('sameSite reads Origin and Fetch Metadata', () => {
  assert.equal(sameSite({ host: 'a:1' }), true);
  assert.equal(sameSite({ host: 'a:1', origin: 'http://a:1' }), true);
  assert.equal(sameSite({ host: 'a:1', origin: 'null' }), false);
  assert.equal(sameSite({ host: 'a:1', origin: 'http://a:2' }), false);
});
