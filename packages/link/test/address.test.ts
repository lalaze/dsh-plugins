import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cookieDomain, guestOrigin, isTargetLocal, needsGuest, parseGuestHost, parseGuestHostname, rewriteLoopbackUrls, toDisplayUrl, toGuestUrl } from '../src/forward/address.js';

const P = 7389;

test('addresses of the machine and its network, and public sites', () => {
  for (const host of ['localhost', 'LOCALHOST', 'app.localhost', '127.0.0.1', '127.8.9.1', '0.0.0.0', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.10', '169.254.1.1', '100.96.195.115', 'nas', 'printer.local', 'git.lan', 'svc.internal', 'box.home.arpa', 'myapp.test', 'lalazemac-mini.tailcec3d.ts.net', '[::1]', '[::]', '[fd12::1]', '[fe80::1]', '[::ffff:192.168.1.2]'])
    assert.equal(isTargetLocal(host), true, host);
  for (const host of ['github.com', 'example.org', '8.8.8.8', '172.32.0.1', '100.128.0.1', '[2001:db8::1]', '[::ffff:8.8.8.8]', 'localhost.example.com', ''])
    assert.equal(isTargetLocal(host), false, host);
});

test('a machine address becomes a guest URL and reads back, path, query and hash kept', () => {
  const guest = toGuestUrl('http://localhost:5173/a/b?x=1#h', 'mabc', P);
  assert.equal(guest, 'http://p5173.x-http.localhost.mabc.localhost:7389/a/b?x=1#h');
  assert.equal(toDisplayUrl(guest!, P), 'http://localhost:5173/a/b?x=1#h');
  assert.equal(toGuestUrl('https://192.168.1.10/', 'mabc', P), 'http://p443.x-https.192.168.1.10.mabc.localhost:7389/');
  assert.equal(toDisplayUrl('http://p443.x-https.192.168.1.10.mabc.localhost:7389/', P), 'https://192.168.1.10/');
  assert.equal(toDisplayUrl('http://p80.x-http.nas.mabc.localhost:7389/', P), 'http://nas/');
  const v6 = toGuestUrl('http://[::1]:8080/', 'mabc', P)!;
  assert.equal(v6, 'http://p8080.x-http.v6-0-0-0-0-0-0-0-1.mabc.localhost:7389/');
  assert.equal(toDisplayUrl(v6, P), 'http://[::1]:8080/');
});

test('public sites, guest URLs and other schemes are left as they are', () => {
  assert.equal(toGuestUrl('https://github.com/x', 'mabc', P), 'https://github.com/x');
  const guest = 'http://p5173.x-http.localhost.mabc.localhost:7389/';
  assert.equal(toGuestUrl(guest, 'mabc', P), guest);
  assert.equal(toGuestUrl('about:blank#lease', 'mabc', P), undefined);
  assert.equal(toGuestUrl('file:///etc/hosts', 'mabc', P), undefined);
  assert.equal(toDisplayUrl('https://github.com/', P), 'https://github.com/');
  // Another port is not this listener: shown as it is.
  assert.equal(toDisplayUrl('http://p5173.x-http.localhost.mabc.localhost:9999/', P), 'http://p5173.x-http.localhost.mabc.localhost:9999/');
  assert.equal(needsGuest('http://localhost:3000/', P), true);
  assert.equal(needsGuest(guest, P), false);
  assert.equal(needsGuest('https://github.com/', P), false);
  assert.equal(needsGuest('about:blank', P), false);
});

test('guest hosts are read strictly', () => {
  assert.deepEqual(parseGuestHost('p5173.x-http.localhost.mabc.localhost:7389', P), { machine: 'mabc', origin: 'http://localhost:5173', hostname: 'localhost' });
  assert.deepEqual(parseGuestHost('P80.X-HTTP.NAS.MABC.LOCALHOST:7389', P), { machine: 'mabc', origin: 'http://nas', hostname: 'nas' });
  for (const host of ['p5173.x-http.localhost.mabc.localhost:7390', 'localhost:7389', 'p5173.x-ftp.localhost.mabc.localhost:7389', 'p0.x-http.localhost.mabc.localhost:7389', 'p70000.x-http.localhost.mabc.localhost:7389', 'p1.x-http.mabc.localhost:7389', 'evil.com:7389', 'p1.x-http.a.mabc.localhost.evil.com:7389', 'p1.x-http.a_b-.mabc.localhost:7389'])
    assert.equal(parseGuestHost(host, P), undefined, host);
  assert.equal(parseGuestHostname('p1.x-http.a.m_bad.localhost'), undefined);
});

test('cookies are shared by every port and scheme of one hostname, as on the machine', () => {
  assert.equal(cookieDomain(parseGuestHostname('p5173.x-http.localhost.mabc.localhost')!), 'localhost.mabc.localhost');
  assert.equal(cookieDomain(parseGuestHostname('p443.x-https.localhost.mabc.localhost')!), 'localhost.mabc.localhost');
  assert.equal(guestOrigin('http://localhost:3000', 'mabc', P), 'http://p3000.x-http.localhost.mabc.localhost:7389');
});

test('absolute loopback URLs in page text point at guest hosts; templates and other hosts do not', () => {
  const text = [
    'fetch("http://localhost:3000/api")',
    "new WebSocket('ws://127.0.0.1:24678')",
    'wss://localhost:8443/socket',
    'https://localhost/secure',
    'url(http://[::1]:9000/x.png)',
    '`http://localhost:${port}`',
    'http://localhost.example.com/',
    'http://example.com:3000/',
    'xhttp://localhost:1/',
  ].join('\n');
  assert.equal(rewriteLoopbackUrls(text, 'mabc', P), [
    'fetch("http://p3000.x-http.localhost.mabc.localhost:7389/api")',
    "new WebSocket('ws://p24678.x-http.127.0.0.1.mabc.localhost:7389')",
    'ws://p8443.x-https.localhost.mabc.localhost:7389/socket',
    'http://p443.x-https.localhost.mabc.localhost:7389/secure',
    'url(http://p9000.x-http.v6-0-0-0-0-0-0-0-1.mabc.localhost:7389/x.png)',
    '`http://localhost:${port}`',
    'http://localhost.example.com/',
    'http://example.com:3000/',
    'xhttp://localhost:1/',
  ].join('\n'));
  // Rewriting twice changes nothing more.
  const once = rewriteLoopbackUrls(text, 'mabc', P);
  assert.equal(rewriteLoopbackUrls(once, 'mabc', P), once);
});
