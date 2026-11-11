import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RemoteError } from '@dsh-plugins/remote-core/domain.js';
import type { RemoteAgentsMachines } from '@dsh-plugins/remote-core/machines.js';
import { createHandler } from '../src/index.js';
import type { Terminals } from '../src/install.js';

const post = (handler: ReturnType<typeof createHandler>, body: unknown, headers: Record<string, string> = { 'content-type': 'application/json', 'X-DSH-Remote-Agents': '1' }) =>
  handler(new Request('http://dsh.test/api/remote-terminals', { method: 'POST', headers, body: JSON.stringify(body) }));

test('without Remote Agents the page learns there are no TUI conversations, and everything else says what is missing', async () => {
  const handler = createHandler(() => undefined);
  assert.deepEqual(await (await post(handler, { action: 'tuiSessions' })).json(), { sessions: [], codex: [], localScroll: true, unavailable: true });
  const refused = await post(handler, { action: 'tuiStart', sessionId: 's' });
  assert.equal(refused.status, 501); assert.match((await refused.json()).error, /Install or update Remote Agents/);
  assert.equal((await post(handler, { action: 'tuiSessions' }, { 'content-type': 'application/json' })).status, 403, 'another page cannot ask');
  assert.equal((await handler(new Request('http://dsh.test/api/remote-terminals'))).status, 405);
});

test('requests reach TUI conversations, worktrees and the machines, each through its own part', async () => {
  const calls: unknown[][] = [], shell = '/dsh/storages/dsh-remote-terminals/terminal/Remote workspace';
  const terminals = {
    terminal: { shell },
    tui: { list: () => ['tui-1'], codex: () => [], localScroll: () => false, setLocalScroll: async (local: boolean) => { calls.push(['scroll', local]); } },
    worktrees: { projects: async () => [{ path: '/dsh/project', title: 'Project' }] },
  } as unknown as Terminals;
  const machines = {
    target: async (sessionId: string) => { if (sessionId !== 'remote') throw new RemoteError('Select a verified remote workspace first.', 409); return { hostId: 'host-box-1', label: 'Box', cwd: '/srv/app' }; },
    createWorkspace: async (hostId: string, path: string) => { calls.push(['workspace', hostId, path]); return { path: '/dsh/remote-workspaces/box/app-fix' }; },
  } as unknown as RemoteAgentsMachines;
  const handler = createHandler(() => ({ terminals, machines })), ask = async (body: unknown) => (await post(handler, body)).json();
  assert.deepEqual(await ask({ action: 'tuiSessions' }), { sessions: ['tui-1'], codex: [], localScroll: false });
  assert.deepEqual(await ask({ action: 'tuiScroll', local: true }), { localScroll: true });
  assert.deepEqual(await ask({ action: 'worktreeProjects' }), [{ path: '/dsh/project', title: 'Project' }]);
  // The launcher is offered only where the conversation is in a verified remote workspace.
  assert.deepEqual(await ask({ action: 'terminalShell', sessionId: 'remote' }), { shell });
  assert.deepEqual(await ask({ action: 'terminalShell', sessionId: 'local' }), {});
  assert.deepEqual(await ask({ action: 'openWorktree', hostId: 'host-box-1', path: '/srv/app-fix' }), { path: '/dsh/remote-workspaces/box/app-fix' });
  assert.deepEqual(calls, [['scroll', true], ['workspace', 'host-box-1', '/srv/app-fix']]);
  const unknown = await post(handler, { action: 'workspaceFiles' });
  assert.equal(unknown.status, 400, 'files are Remote Agents\' to serve');
});
