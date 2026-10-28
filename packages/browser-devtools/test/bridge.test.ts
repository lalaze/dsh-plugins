import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { DebuggerBridge, createHandler } from '../src/bridge.js';
import type { Command, PageState } from '../src/protocol.js';

const page: PageState = { url: 'https://page.test/', title: 'Page', revision: 0, ready: true, locale: 'en', dark: false };
async function setup(t: TestContext) {
  let url = '', closed = 0, now = 0;
  const bridge = new DebuggerBridge(async value => { url = value; return { async close() { closed++; } }; }, () => now, async () => '// fixture');
  t.after(() => bridge.dispose());
  const key = await bridge.create(page), parsed = new URL(url), windowToken = parsed.hash.slice(1).split('.')[1];
  const rpc = (action: string, extra: Record<string, unknown> = {}) => bridge.windowRequest({ action, id: key.id, ...extra }, `Bearer ${windowToken}`);
  const exchange = (extra: Record<string, unknown> = {}) => bridge.ownerRequest({ action: 'exchange', ...key, page, replies: [], ...extra }) as Promise<{ commands: Command[] }>;
  return { bridge, key, parsed, rpc, exchange, closed: () => closed, advance: (ms: number) => { now += ms; bridge.expire(); } };
}

test('window commands round-trip through the owner and credentials cannot swap roles', async t => {
  const { bridge, key, rpc, exchange } = await setup(t);
  const pending = rpc('execute', { code: '6 * 7', gesture: true, revision: 0 });
  const { commands } = await exchange();
  assert.equal(commands.length, 1); assert.equal(commands[0].gesture, true);
  await exchange({ replies: [{ id: commands[0].id, value: 42 }] });
  assert.equal(await pending, 42);
  await assert.rejects(bridge.windowRequest({ id: key.id, action: 'status' }, `Bearer ${key.token}`), /Forbidden/);
  await assert.rejects(bridge.ownerRequest({ id: key.id, token: 'wrong', action: 'close' }), /Forbidden/);
});

test('navigation rejects pending work and clears queued commands', async t => {
  const { rpc, exchange } = await setup(t);
  const pending = assert.rejects(rpc('execute', { code: 'document.title', gesture: false, revision: 0 }), /Page navigated/);
  const result = await exchange({ page: { ...page, revision: 1, ready: false } });
  await pending; assert.deepEqual(result.commands, []);
  await assert.rejects(rpc('execute', { code: '1', gesture: false, revision: 0 }), /Page navigated or is loading/);
});

test('closing or losing the owner rejects commands and cleans up the process', async t => {
  const { rpc, advance, closed } = await setup(t);
  const pending = assert.rejects(rpc('execute', { code: '1', gesture: false, revision: 0 }), /closed/);
  advance(21_000);
  await pending; assert.equal(closed(), 1);
  await assert.rejects(rpc('status'), /closed/);
});

test('local HTTP bridge serves assets but rejects foreign origins, hosts, missing auth and oversized bodies', async t => {
  const { parsed, key } = await setup(t);
  const base = parsed.origin;
  const html = await fetch(base); assert.equal(html.status, 200); assert.match(await html.text(), /window.js/);
  assert.match(html.headers.get('Content-Security-Policy')!, /frame-ancestors 'none'/);
  const js = await fetch(`${base}/window.js`); assert.equal(await js.text(), '// fixture');
  assert.equal((await fetch(base, { headers: { Origin: 'https://foreign.test' } })).status, 403);
  // Fetch normalizes Host; use a raw HTTP request to exercise DNS-rebinding defense.
  const badHost = await new Promise<number | undefined>((resolve, reject) => {
    const req = httpRequest(base, { headers: { Host: 'foreign.test' } }, response => { response.resume(); resolve(response.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(badHost, 403);
  const post = (body: string, headers = {}) => fetch(`${base}/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
  assert.equal((await post(JSON.stringify({ id: key.id, action: 'status' }))).status, 403);
  assert.equal((await post(' '.repeat(4 * 1024 * 1024 + 1))).status, 413);
});

test('owner HTTP handler requires its custom header and reports launcher failures', async t => {
  const bridge = new DebuggerBridge(async () => { throw new Error('Install Chrome or Edge to open a desktop debugger window.'); }, Date.now, async () => '');
  t.after(() => bridge.dispose());
  const handler = createHandler(bridge);
  const req = (headers = {}) => new Request('http://dsh.test/api/browser-devtools', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ action: 'create', page }) });
  assert.equal((await handler(req())).status, 403);
  const response = await handler(req({ 'X-DSH-Debugger': '1' }));
  assert.equal(response.status, 500); assert.match((await response.json()).error, /Install Chrome/);
});
