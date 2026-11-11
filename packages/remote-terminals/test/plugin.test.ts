import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';
import { Context } from '@deepseek-ai/cordis';
import type { RemoteAgentsWorktrees } from '../src/install.js';
import type { RemoteTerminals } from '../src/index.js';

interface Route { path: string; methods: string[]; requestBody: 'buffered' | 'streaming'; fetch(request: Request): Promise<Response> }
const until = async (done: () => boolean) => { for (const end = Date.now() + 5000; !done() && Date.now() < end;) await wait(10); return done(); };

/** Both plugins in one DSH, each with a state folder of its own, as an install has them. */
test('beside Remote Agents the plugin takes over the TUI conversations, serves its routes and offers its services; alone it waits', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-remote-terminals-plugin-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentsDir = join(root, 'dsh-remote-agents'), ownDir = join(root, 'dsh-remote-terminals');
  await mkdir(agentsDir);
  // What Remote Agents 0.2.129 saved: a machine, and two TUI conversations.
  await writeFile(join(agentsDir, 'state.json'), JSON.stringify({ version: 1, hosts: [{ id: 'host-box-1', label: 'Box', connection: 'ssh://builder@box.invalid', enabledProviders: [] }], tasks: [],
    tuiSessions: ['tui-claude', 'tui-codex'], tuiDetails: { 'tui-codex': { cli: 'codex', thread: '01a1a960-0696-7481-b86c-ea7a878c6479' } }, tuiLocalScroll: false }));
  const ctx = new Context(), routes: Route[] = [];
  const dispose = ctx.provide('connection', { fetch: { register: (route: Route) => { routes.push(route); return () => {}; } } });
  const ask = async (body: unknown) => {
    const route = routes.find(r => r.path === '/api/remote-terminals')!;
    const response = await route.fetch(new Request('http://dsh.internal/api/remote-terminals', { method: 'POST', headers: { 'content-type': 'application/json', 'X-DSH-Remote-Agents': '1' }, body: JSON.stringify(body) }));
    return { status: response.status, body: await response.json() };
  };

  // Alone: its own route answers, and says what it waits for.
  const terminals = ctx.plugin(await import('../src/index.js'), { stateDir: ownDir }); await terminals.await();
  t.after(() => terminals.dispose());
  assert.deepEqual(routes.map(r => `${r.methods.join('/')} ${r.path} ${r.requestBody}`), ['POST /api/remote-terminals buffered']);
  assert.deepEqual((await ask({ action: 'tuiSessions' })).body, { sessions: [], codex: [], localScroll: true, unavailable: true });
  assert.equal((await ask({ action: 'worktreeProjects' })).status, 501);
  assert.equal((ctx.get('remoteTerminals') as RemoteTerminals).isTui('tui-claude'), false);

  // Remote Agents arrives, as when it is installed afterwards or loads later.
  const agents = ctx.plugin(await import('../../remote-agents/src/index.js'), { stateDir: agentsDir }); await agents.await();
  t.after(async () => { await agents.dispose(); await dispose(); });
  assert.ok(await until(() => routes.some(r => r.path === '/api/remote-terminals/tui-files')), 'the plugin starts once the machines are there');
  assert.deepEqual(routes.filter(r => r.path.startsWith('/api/remote-terminals')).map(r => `${r.methods.join('/')} ${r.path} ${r.requestBody}`).sort(), [
    'GET /api/remote-terminals/tui-activity buffered',
    'POST /api/remote-terminals buffered',
    'POST /api/remote-terminals/tui-files streaming',
  ]);
  assert.deepEqual((await ask({ action: 'tuiSessions' })).body, { sessions: ['tui-claude', 'tui-codex'], codex: ['tui-codex'], localScroll: false });
  assert.equal((ctx.get('remoteTerminals') as RemoteTerminals).isTui('tui-codex'), true);
  const own = JSON.parse(await readFile(join(ownDir, 'state.json'), 'utf8'));
  assert.deepEqual([own.adopted, own.tuiSessions], [true, ['tui-claude', 'tui-codex']]);
  // A conversation that is not in a remote workspace gets no remote shell, through Remote Agents' own check.
  assert.deepEqual(await ask({ action: 'terminalShell', sessionId: 'local-session' }), { status: 200, body: {} });
  const started = await ask({ action: 'tuiStart', sessionId: 'local-session', cli: 'claude' });
  assert.equal(started.status, 409); assert.match(started.body.error, /verified remote workspace/);
  // Worktree workspaces keep the service name other plugins know.
  const worktrees = ctx.get('remoteAgentsWorktrees') as RemoteAgentsWorktrees;
  assert.equal(worktrees.version, 1); assert.deepEqual(await worktrees.projects(), []);
  assert.deepEqual((await ask({ action: 'worktreeProjects' })).body, []);

  // Remote Agents goes, as when it is switched off: the plugin stops working on its machines and says so again.
  await agents.dispose();
  assert.ok(await until(() => !ctx.get('remoteAgentsWorktrees')));
  assert.equal((await ask({ action: 'worktreeProjects' })).status, 501);
  assert.equal((ctx.get('remoteTerminals') as RemoteTerminals).isTui('tui-claude'), true, 'which conversations are TUI conversations is its own to know');
});
