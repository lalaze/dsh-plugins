import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';

interface Route { path: string; methods: string[]; requestBody: 'buffered' | 'streaming'; fetch(request: Request): Promise<Response> }

/** How DSH's connection bridge turns a node request into the one a route receives. */
const bridged = (route: Route, method: string, query = '', headers: Record<string, string> = {}) => new Request(`http://dsh.internal${route.path}${query}`,
  route.requestBody === 'streaming' ? { method, headers, body: Readable.toWeb(Readable.from([])) as ReadableStream, duplex: 'half' } as RequestInit : { method, headers });

test('every route survives DSH’s request bridge: file downloads and the editor bundle have buffered GET routes, uploads a streaming POST one', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-remote-routes-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const plugin = await import('../src/index.js');
  const ctx = new Context(), routes: Route[] = [];
  const dispose = ctx.provide('connection', { fetch: { register: (route: Route) => { routes.push(route); return () => {}; } } });
  const mounted = ctx.plugin(plugin, { stateDir: directory }); await mounted.await();
  t.after(async () => { await mounted.dispose(); await dispose(); });
  assert.deepEqual(routes.map(r => `${r.methods.join('/')} ${r.path} ${r.requestBody}`).sort(), [
    'GET /api/remote-agents/download buffered',
    'GET /api/remote-agents/editor.js buffered',
    'GET/POST /api/remote-agents buffered',
    'POST /api/remote-agents/files streaming',
  ]);
  for (const route of routes) for (const method of route.methods) assert.doesNotThrow(() => bridged(route, method), `${method} ${route.path}`);
  // A download reaches the handler, which answers with a JSON error rather than an empty body.
  const download = routes.find(r => r.path === '/api/remote-agents/download')!;
  const response = await download.fetch(bridged(download, 'GET', '?sessionId=s&hostId=host-test-1&cwd=/srv/app&path=a.png&revision=' + 'a'.repeat(64), { 'X-DSH-Remote-Agents': '1' }));
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /verified remote workspace/);
});
