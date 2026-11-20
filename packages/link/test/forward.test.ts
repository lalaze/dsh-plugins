import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import zlib from 'node:zlib';
import { buildPanel, PANEL_ROUTE, PanelFrames } from '../src/browser-panel.js';
import { forwardOrigin, forwardedHeaders, FORWARD_HEADER, ORIGIN_HEADER, serveForward, serveForwardUpgrade } from '../src/forward/target.js';
import { admitted, atLeast, guestCookie, WindowForwarder, type ForwardMachine } from '../src/forward/window.js';
import { Frontend } from '../src/listener.js';
import type { LoopbackSession } from '../src/login.js';
import { injectOwnsHost } from '../src/rewrite.js';

const servers: http.Server[] = [];
const sockets = new Set<net.Socket>();
const dir = mkdtempSync(join(tmpdir(), 'dl-fwd-'));
let windowForwarder: WindowForwarder | undefined;
after(async () => {
  await windowForwarder?.close();
  for (const socket of sockets) socket.destroy();
  for (const server of servers) { server.closeAllConnections(); server.close(); }
  rmSync(dir, { recursive: true, force: true });
});

async function serve(handler: http.RequestListener, upgrade?: (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => void): Promise<number> {
  const server = http.createServer(handler);
  if (upgrade) server.on('upgrade', (req, socket: net.Socket, head) => { sockets.add(socket); upgrade(req, socket, head); });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

interface Answer { status: number; headers: http.IncomingHttpHeaders; body: Buffer }
function ask(port: number, path: string, headers: http.OutgoingHttpHeaders): Promise<Answer> {
  return new Promise((resolve, reject) => {
    http.request({ host: '127.0.0.1', port, path, headers, agent: false }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject).end();
  });
}

test('a forwarded request names an HTTP(S) origin of the machine\'s own network, nothing else', () => {
  assert.equal(forwardOrigin('http://localhost:5173')?.host, 'localhost:5173');
  assert.equal(forwardOrigin('https://192.168.1.10')?.origin, 'https://192.168.1.10');
  for (const value of ['https://example.com', 'http://localhost:5173/', 'http://localhost:5173/x', 'ftp://localhost', 'http://user@localhost', 'nonsense', undefined, ['http://localhost']])
    assert.equal(forwardOrigin(value as string), undefined, String(value));
});

test('the site gets the browser\'s headers with its own Host, Origin and Referer, and no marks', () => {
  const headers = forwardedHeaders({ host: '100.96.195.115:7390', cookie: 'sid=1', accept: '*/*', connection: 'keep-alive, x-secret', 'x-secret': '1', [FORWARD_HEADER]: 'http://localhost:3000', [ORIGIN_HEADER]: 'http://localhost:5173', 'x-dsh-link-referer': 'http://localhost:5173/page', 'x-forwarded-for': '1.2.3.4' }, new URL('http://localhost:3000'));
  assert.deepEqual(headers, { cookie: 'sid=1', accept: '*/*', host: 'localhost:3000', origin: 'http://localhost:5173', referer: 'http://localhost:5173/page' });
});

test('versions, cross-site admission and cookie domains', () => {
  assert.equal(atLeast('0.1.12', '0.1.12'), true);
  assert.equal(atLeast('0.2.0', '0.1.12'), true);
  assert.equal(atLeast('0.1.11', '0.1.12'), false);
  assert.equal(atLeast(undefined, '0.1.12'), false);
  assert.equal(admitted({}, 7389), true);
  assert.equal(admitted({ 'sec-fetch-site': 'same-site' }, 7389), true);
  assert.equal(admitted({ 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' }, 7389), false);
  assert.equal(admitted({ 'sec-fetch-site': 'cross-site' }, 7389), false);
  assert.equal(admitted({ 'sec-fetch-site': 'cross-site', origin: 'http://p1.x-http.localhost.mother.localhost:7389' }, 7389), true);
  const target = { machine: 'mabc', origin: 'http://localhost:3000', hostname: 'localhost' };
  assert.equal(guestCookie('sid=1; Path=/; HttpOnly', target), 'sid=1; Path=/; HttpOnly; Domain=localhost.mabc.localhost');
  assert.equal(guestCookie('sid=1; Domain=localhost; Secure', target), 'sid=1; Secure; Domain=localhost.mabc.localhost');
});

// ---- The whole way: guest host on the window → window listener → machine listener (Frontend) → sites.
let W = 0;
let api = 0, app = 0;
const machines: Record<string, ForwardMachine> = {};
const seen: { path: string; host?: string; origin?: string; cookie?: string; marks: string[] }[] = [];
const guest = (port: number, machine = 'mabc', host = '127.0.0.1') => `p${port}.x-http.${host}.${machine}.localhost:${W}`;

before(async () => {
  const record = (req: http.IncomingMessage) => seen.push({ path: req.url!, host: req.headers.host, origin: req.headers.origin, cookie: req.headers.cookie, marks: Object.keys(req.headers).filter(name => name.startsWith('x-dsh-link')) });
  api = await serve((req, res) => {
    record(req);
    if (req.url === '/latin1') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(Buffer.from('<p>caf\xe9 http://127.0.0.1:1/</p>', 'latin1')); return; }
    if (req.url === '/gz.js') { res.writeHead(200, { 'content-type': 'application/javascript', 'content-encoding': 'gzip', etag: '"g1"' }); res.end(zlib.gzipSync(`fetch("http://127.0.0.1:${app}/x")`)); return; }
    if (req.url === '/plain.js') { res.writeHead(200, { 'content-type': 'application/javascript', 'content-encoding': 'gzip' }); res.end(zlib.gzipSync('console.log(1)')); return; }
    if (req.url === '/redirect') { res.writeHead(302, { location: `http://127.0.0.1:${app}/login` }); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': `http://127.0.0.1:${app}`, 'access-control-allow-credentials': 'true', 'set-cookie': ['sid=42; Path=/; HttpOnly'] });
    res.end(JSON.stringify({ ok: true }));
  }, (req, socket) => {
    record(req);
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${req.headers['sec-websocket-key']}\r\n\r\n`);
    socket.on('data', data => socket.write(`echo:${data}`));
  });
  app = await serve((req, res) => {
    record(req);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': `connect-src 'self' http://127.0.0.1:${api} ws://127.0.0.1:${api}` });
    res.end(`<script>fetch("http://127.0.0.1:${api}/api",{credentials:"include"});new WebSocket("ws://127.0.0.1:${api}/ws")</script>`);
  });
  const session = { get: async () => 'login=1', invalidate() {}, authority: '127.0.0.1:1' } as unknown as LoopbackSession;
  const frontend = new Frontend(session, () => 'http://127.0.0.1:1', { http: {}, forward: { http: serveForward, upgrade: serveForwardUpgrade } });
  const machinePort = await serve((req, res) => { void frontend.http(req, res); }, (req, socket, head) => { void frontend.upgrade(req, socket, head); });
  machines.mabc = { url: `http://127.0.0.1:${machinePort}`, name: 'mini', state: 'online', version: '0.1.12' };
  machines.mold = { url: `http://127.0.0.1:${machinePort}`, name: 'old', state: 'online', version: '0.1.11' };
  windowForwarder = new WindowForwarder({ machine: id => machines[id], stateFile: join(dir, 'forward.json'), warn: () => {} });
  await windowForwarder.start(40000 + Math.floor(Math.random() * 20000));
  assert.ok(windowForwarder.port, windowForwarder.error);
  W = windowForwarder.port!;
});

test('a page of the machine comes through the window listener with its loopback URLs and CSP on guest hosts', async () => {
  const page = await ask(W, '/', { host: guest(app) });
  assert.equal(page.status, 200);
  const html = page.body.toString();
  assert.match(html, new RegExp(`fetch\\("http://p${api}\\.x-http\\.127\\.0\\.0\\.1\\.mabc\\.localhost:${W}/api"`));
  assert.match(html, new RegExp(`new WebSocket\\("ws://p${api}\\.x-http\\.127\\.0\\.0\\.1\\.mabc\\.localhost:${W}/ws"`));
  assert.equal(page.headers['content-security-policy'], `connect-src 'self' http://${guest(api)} ws://${guest(api)}`);
  const hit = seen.find(entry => entry.path === '/' && entry.host === `127.0.0.1:${app}`);
  assert.ok(hit, 'the site saw its own Host');
  assert.deepEqual(hit.marks, [], 'no marks reach the site');
  assert.equal(JSON.parse(readFileSync(join(dir, 'forward.json'), 'utf8')).port, W, 'the port is kept for next time');
});

test('the API on another port gets the page\'s own Origin and cookies; CORS and cookies come back for guest hosts', async () => {
  const answer = await ask(W, '/api', { host: guest(api), origin: `http://${guest(app)}`, referer: `http://${guest(app)}/page`, 'sec-fetch-site': 'same-site', cookie: 'sid=41' });
  assert.equal(answer.status, 200);
  assert.equal(answer.headers['access-control-allow-origin'], `http://${guest(app)}`);
  assert.deepEqual(answer.headers['set-cookie'], ['sid=42; Path=/; HttpOnly; Domain=127.0.0.1.mabc.localhost']);
  const hit = seen.findLast(entry => entry.path === '/api')!;
  assert.equal(hit.origin, `http://127.0.0.1:${app}`);
  assert.equal(hit.cookie, 'sid=41');
});

test('redirects, encoded and legacy bodies', async () => {
  const redirect = await ask(W, '/redirect', { host: guest(api) });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.location, `http://${guest(app)}/login`);
  const gz = await ask(W, '/gz.js', { host: guest(api), 'accept-encoding': 'gzip' });
  assert.equal(gz.headers['content-encoding'], undefined);
  assert.equal(gz.body.toString(), `fetch("http://${guest(app)}/x")`);
  assert.equal(gz.headers.etag, '"g1"', 'the same rewrite every time keeps the validator');
  const plain = await ask(W, '/plain.js', { host: guest(api), 'accept-encoding': 'gzip' });
  assert.equal(plain.headers['content-encoding'], 'gzip', 'a body with nothing to change passes as it came');
  assert.equal(zlib.gunzipSync(plain.body).toString(), 'console.log(1)');
  const latin = await ask(W, '/latin1', { host: guest(api) });
  assert.deepEqual(latin.body, Buffer.from('<p>caf\xe9 http://127.0.0.1:1/</p>', 'latin1'), 'a body that is not UTF-8 is not touched');
});

test('an https address answered in plain HTTP (DSH\'s address bar adds https) is sent to its http address', async () => {
  const https = `p${app}.x-https.127.0.0.1.mabc.localhost:${W}`;
  const answer = await ask(W, '/docs?x=1', { host: https });
  assert.equal(answer.status, 307);
  assert.equal(answer.headers.location, `http://${guest(app)}/docs?x=1`);
  const post = await new Promise<number>((resolve, reject) => http.request({ host: '127.0.0.1', port: W, path: '/', method: 'POST', headers: { host: https }, agent: false }, res => { res.resume(); resolve(res.statusCode ?? 0); }).on('error', reject).end('x'));
  assert.equal(post, 502, 'only a page load is redirected');
});

test('a WebSocket goes the whole way', async () => {
  const socket = net.connect(W, '127.0.0.1');
  sockets.add(socket);
  socket.write(`GET /ws HTTP/1.1\r\nHost: ${guest(api)}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: abc\r\nSec-WebSocket-Version: 13\r\nOrigin: http://${guest(app)}\r\n\r\n`);
  let text = '';
  await new Promise<void>(resolve => socket.on('data', data => {
    text += data.toString();
    if (text.includes('\r\n\r\n') && !text.includes('echo:')) socket.write('ping');
    if (text.includes('echo:ping')) resolve();
  }));
  socket.destroy();
  assert.match(text, /^HTTP\/1.1 101 /);
  assert.equal(seen.findLast(entry => entry.path === '/ws')!.origin, `http://127.0.0.1:${app}`);
});

test('the window listener answers guest hosts of current machines only, and no other site', async () => {
  assert.equal((await ask(W, '/', { host: `127.0.0.1:${W}` })).status, 421);
  assert.equal((await ask(W, '/', { host: `evil.example:${W}` })).status, 421);
  assert.equal((await ask(W, '/', { host: guest(app, 'mnone') })).status, 404);
  const old = await ask(W, '/', { host: guest(app, 'mold') });
  assert.equal(old.status, 502);
  assert.match(old.body.toString(), /Update DSH Link on old to 0\.1\.12/);
  assert.equal((await ask(W, '/api', { host: guest(api), 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' })).status, 403);
});

test('the machine listener forwards only marked requests for its own network', async () => {
  const machinePort = Number(new URL(machines.mabc!.url).port);
  assert.equal((await ask(machinePort, '/', { host: 'x', [FORWARD_HEADER]: 'https://example.com' })).status, 403);
  const session = { get: async () => 'login=1', invalidate() {}, authority: '127.0.0.1:1' } as unknown as LoopbackSession;
  const closed = new Frontend(session, () => 'http://127.0.0.1:1', { http: {} });
  const port = await serve((req, res) => { void closed.http(req, res); });
  assert.equal((await ask(port, '/', { host: 'x', [FORWARD_HEADER]: `http://127.0.0.1:${app}` })).status, 403, 'forwarding off');
});

test('pages other machines get list the panel, keep it in the event stream, and the module is served', async () => {
  const boot = readFileSync(new URL('./fixtures/dsh-0.2.2-rc.3-boot.html', import.meta.url), 'utf8');
  const panel = buildPanel(readFileSync(new URL('./fixtures/sidebar-browser-client.js', import.meta.url), 'utf8'), {}).panel!;
  const dsh = await serve((req, res) => {
    if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(boot); return; }
    if (req.url === '/plugins/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': connected\n\n'); res.end(`data: ${JSON.stringify({ type: 'graph', graph: { rev: 'r', entries: [], batches: [] } })}\n\n`); return; }
    res.writeHead(404); res.end();
  });
  const session = { get: async () => 'login=1', invalidate() {}, authority: `127.0.0.1:${dsh}` } as unknown as LoopbackSession;
  const frontend = new Frontend(session, () => `http://127.0.0.1:${dsh}`, {
    http: { [PANEL_ROUTE]: (_req, res) => { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); res.end(panel.code); } },
    page: html => html.replace('</head>', '<!--panel--></head>'),
    events: () => new PanelFrames(panel),
  });
  const port = await serve((req, res) => { void frontend.http(req, res); });
  const page = (await ask(port, '/', { host: 'x', accept: 'text/html' })).body.toString();
  assert.match(page, /<!--panel--><\/head>/);
  assert.ok(page.includes(injectOwnsHost('<head>').slice('<head>'.length)), 'ownsHost still comes first');
  const events = (await ask(port, '/plugins/events', { host: 'x' })).body.toString();
  assert.ok(events.includes(`"id":"@deepseek-ai/dsh-client-ui-sidebar-browser"`));
  assert.ok(events.startsWith(': connected\n\n'));
  const module = await ask(port, PANEL_ROUTE, { host: 'x' });
  assert.equal(module.body.toString(), panel.code);
});
