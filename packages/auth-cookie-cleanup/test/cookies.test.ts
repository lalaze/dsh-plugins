import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { authCookieName, currentAuthCookieNames, expireCookie, staleAuthCookieNames } from '../src/cookies.js';
import { apply, expireStaleAuthCookies } from '../src/index.js';

const host = '127.0.0.1:51234';
const current = authCookieName(host);
const old = Array.from({ length: 71 }, (_, i) => authCookieName(`127.0.0.1:${40000 + i}`));
const header = (names: string[]) => names.map(name => `${name}=v1.payload.sig`).join('; ');

test('cookie names match the host derivation for HTTP and TLS listeners', () => {
  // sha256("127.0.0.1:51234"), base64url, as dsh-client-connection computes it.
  assert.match(current, /^dsh-auth-[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(currentAuthCookieNames('127.0.0.1:51234'), new Set([current, authCookieName('https://127.0.0.1:51234')]));
  // Default ports normalise the same way the host's URL parsing does.
  assert.ok(currentAuthCookieNames('LOCALHOST:443').has(authCookieName('https://localhost')));
  assert.equal(currentAuthCookieNames(undefined).size, 0);
});

test('only other-port auth cookies are stale, and only when the live cookie is present', () => {
  const cookie = `theme=dark; ${header([old[0]!, current, old[1]!, old[0]!])}; other=1`;
  assert.deepEqual(staleAuthCookieNames(cookie, host), [old[0], old[1]]);
  assert.deepEqual(staleAuthCookieNames(header(old), host), [], 'no live cookie: leave everything alone');
  assert.deepEqual(staleAuthCookieNames(`theme=dark; ${header([current])}`, host), []);
  assert.deepEqual(staleAuthCookieNames(undefined, host), []);
});

test('expiry mirrors the minted attributes', () => {
  assert.equal(expireCookie('dsh-auth-x', false), 'dsh-auth-x=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Strict');
  assert.ok(expireCookie('dsh-auth-x', true).endsWith('; Secure'));
});

test('connection/request listener expires 71 stale cookies on a real HTTP response and keeps existing Set-Cookie', async () => {
  let listener: ((req: IncomingMessage, res: ServerResponse, next: () => Promise<void>) => Promise<void>) | undefined;
  const infos: unknown[][] = [];
  const ctx = {
    on(event: string, cb: typeof listener) { assert.equal(event, 'connection/request'); listener = cb; return () => true; },
    logger: { info: (...args: unknown[]) => infos.push(args), warn: (error: unknown) => { throw error; } },
  };
  apply(ctx as never);
  assert.ok(listener);
  const server = createServer({ maxHeaderSize: 64 * 1024 }, (req, res) => {
    res.setHeader('set-cookie', 'keep=1');
    // Same shape as the host bridge: writeHead with a plain header object after the waterfall.
    void listener!(req, res, async () => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const live = authCookieName(`127.0.0.1:${port}`);
  try {
    const setCookie = await new Promise<string[]>((resolve, reject) => {
      request({ host: '127.0.0.1', port, path: '/api/x', headers: { cookie: header([...old, live]) } }, res => {
        res.resume(); resolve(res.headers['set-cookie'] ?? []);
      }).on('error', reject).end();
    });
    assert.equal(setCookie[0], 'keep=1');
    assert.equal(setCookie.length, 72);
    assert.deepEqual(setCookie.slice(1).map(line => line.split('=')[0]), old);
    assert.ok(!setCookie.some(line => line.startsWith(`${live}=`)));
    assert.equal(infos.length, 1);
  } finally {
    server.close();
  }
});

test('nothing is written once headers are sent', () => {
  const res = { headersSent: true, getHeader: () => undefined, setHeader: () => assert.fail('must not write') };
  const req = { headers: { host, cookie: header([old[0]!, current]) }, socket: {} };
  assert.deepEqual(expireStaleAuthCookies(req as never, res as never), []);
});
