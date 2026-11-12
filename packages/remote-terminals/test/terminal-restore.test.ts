import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { isRemoteLauncher, restoreRemoteTerminals } from '../src/client/terminal-restore.js';
import { tabHolder, TERMINAL_ID_ENV } from '../src/holder-protocol.js';
import { endClosedTerminals, followMovedLaunchers, installWorkspaceTerminal, passTerminalId } from '../src/terminal.js';

const storage = new Map<string, string>();
Object.assign(globalThis, { localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); } } });

interface FakeModel { id: string; shellPath?: string; createWhenMissing: boolean; state: { getSnapshot(): { info?: { shell?: { path?: string; name?: string } } }; subscribe(listener: () => void): () => void } }
function model(id: string, createWhenMissing: boolean, shell?: { path: string; name: string }) {
  let snapshot: { info?: { shell?: { path?: string; name?: string } } } = shell ? { info: { shell } } : {};
  const listeners = new Set<() => void>();
  const value: FakeModel = { id, createWhenMissing, state: { getSnapshot: () => snapshot, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); } } };
  return { value, set(info: { shell: { path: string; name: string } }) { snapshot = { info }; for (const listener of listeners) listener(); } };
}

test('a sidebar terminal that ran a launcher starts it again in place of saying it no longer exists', () => {
  storage.clear();
  const running = model('one', true);
  const views = { view: (() => running.value) as (...args: unknown[]) => unknown };
  const undo = restoreRemoteTerminals(views as never);
  const first = views.view('session', 'key', 'content') as FakeModel;
  running.set({ shell: { path: '/state/terminal/Remote workspace', name: 'Remote workspace' } });
  assert.equal(first.createWhenMissing, true, 'a new terminal is left as it is');

  // After a restart DSH knows the saved terminal and would never replace it.
  const saved = model('one', false);
  views.view = (() => saved.value) as never;
  const restoring = restoreRemoteTerminals(views as never);
  const again = views.view('session', 'key', 'content') as FakeModel;
  assert.equal(again.createWhenMissing, true);
  assert.equal(again.shellPath, '/state/terminal/Remote workspace');
  restoring(); undo();
});

test('a local terminal stays as DSH leaves it', () => {
  storage.clear();
  const local = model('two', false, { path: '/bin/zsh', name: 'zsh' });
  const views = { view: (() => local.value) as (...args: unknown[]) => unknown };
  const undo = restoreRemoteTerminals(views as never);
  const shown = views.view('session', 'key', 'content') as FakeModel;
  assert.equal(shown.createWhenMissing, false);
  assert.equal(shown.shellPath, undefined);
  assert.equal(storage.size, 0);
  undo();
  assert.equal(typeof views.view, 'function');
});

test('every launcher counts, on Windows too', () => {
  for (const name of ['Remote workspace', 'Remote Claude', 'Remote Codex', 'Remote Claude.cmd']) assert.equal(isRemoteLauncher(name), true, name);
  for (const name of ['zsh', undefined]) assert.equal(isRemoteLauncher(name), false, String(name));
});

test('a terminal is told which one it is, and only that call sees the change', async () => {
  const spawned: { env?: Record<string, string> }[] = [];
  const subprocess = { other: () => 'other', spawnTerminal(this: unknown, options: { env?: Record<string, string> }) { assert.equal(this, subprocess); spawned.push(options); return 'handle'; } };
  const controller = {
    execution() { return { subprocess, workingDirectory: 'dir' }; },
    async spawn(this: { execution(agent: unknown): { subprocess: typeof subprocess } }, agent: unknown) {
      const { subprocess: used } = this.execution(agent);
      await Promise.resolve();
      assert.equal(used.other(), 'other');
      return used.spawnTerminal({ env: { DSH_SESSION_ID: 'session' } });
    },
  };
  const original = controller.spawn;
  const stop = passTerminalId(controller as never);
  const a = (controller.spawn as unknown as (...args: unknown[]) => Promise<unknown>)({}, {}, { id: 'terminal-a' }, AbortSignal.timeout(1000));
  const b = (controller.spawn as unknown as (...args: unknown[]) => Promise<unknown>)({}, {}, { id: 'terminal-b' }, AbortSignal.timeout(1000));
  assert.equal(Object.hasOwn(controller, 'execution'), true, 'its own method stays');
  assert.deepEqual(await Promise.all([a, b]), ['handle', 'handle']);
  assert.deepEqual(spawned.map(item => item.env), [{ DSH_SESSION_ID: 'session', [TERMINAL_ID_ENV]: 'terminal-a' }, { DSH_SESSION_ID: 'session', [TERMINAL_ID_ENV]: 'terminal-b' }]);
  stop();
  assert.equal(controller.spawn, original);
});

test('a DSH with a different controller leaves terminals as they were', () => {
  const controller = {};
  passTerminalId(controller)();
  followMovedLaunchers(controller, ['/state/terminal/Remote workspace'])();
  assert.deepEqual(Object.keys(controller), []);
});

/** DSH 0.2.2-rc.2: `userLaunch` chooses the shell, and `spawn` runs what it prepared under the terminal's ID. */
function rc2Controller(candidates: string[]) {
  const started: { id: string; shellPath?: string; env?: Record<string, string>; aborted: boolean }[] = [];
  const subprocess = { spawnTerminal(options: { env?: Record<string, string> }) { return options.env; } };
  type Launch = { argv: string[]; env: Record<string, string>; info: { id: string } };
  const controller = {
    config: { shellCandidates: candidates },
    execution() { return { subprocess }; },
    async userLaunch(this: { config: { shellCandidates: string[] } }, agent: { id: string }, request: { id: string; shellPath?: string }, signal: AbortSignal): Promise<Launch> {
      signal.throwIfAborted();
      if (request.shellPath !== undefined && !this.config.shellCandidates.includes(request.shellPath)) throw new Error('Selected shell is not available in this execution environment');
      return { argv: [request.shellPath ?? 'sh'], env: { DSH_SESSION_ID: agent.id }, info: { id: request.id } };
    },
    async spawn(this: { execution(agent: unknown): { subprocess: typeof subprocess } }, agent: unknown, _owner: unknown, id: string, prepare: (signal: AbortSignal) => Promise<Launch>, signal: AbortSignal) {
      const { argv, env } = await prepare(signal);
      const used = this.execution(agent).subprocess.spawnTerminal({ env });
      signal.throwIfAborted();
      started.push({ id, shellPath: argv[0], env: used, aborted: signal.aborted });
    },
    /** DSH's `create`. */
    async create(agent: { id: string }, request: { id: string; shellPath?: string }, signal: AbortSignal) {
      await this.spawn(agent, {}, request.id, launchSignal => this.userLaunch(agent, request, launchSignal), signal);
    },
  };
  return { started, controller };
}

test('DSH 0.2.2-rc.2 starts a terminal with its ID, its signal and today\'s launcher', async () => {
  const { started, controller } = rc2Controller(['/new/terminal/Remote workspace']);
  const original = { spawn: controller.spawn, userLaunch: controller.userLaunch };
  const stopPassing = passTerminalId(controller as never), stopFollowing = followMovedLaunchers(controller as never, ['/new/terminal/Remote workspace']);
  await controller.create({ id: 'session' }, { id: 'terminal-a', shellPath: '/old/terminal/Remote workspace' }, AbortSignal.timeout(1000));
  await controller.create({ id: 'session' }, { id: 'terminal-b' }, AbortSignal.timeout(1000));
  assert.deepEqual(started, [
    { id: 'terminal-a', shellPath: '/new/terminal/Remote workspace', env: { DSH_SESSION_ID: 'session', [TERMINAL_ID_ENV]: 'terminal-a' }, aborted: false },
    { id: 'terminal-b', shellPath: 'sh', env: { DSH_SESSION_ID: 'session', [TERMINAL_ID_ENV]: 'terminal-b' }, aborted: false },
  ]);
  await assert.rejects(controller.create({ id: 'session' }, { id: 'terminal-c', shellPath: '/elsewhere/zsh' }, AbortSignal.timeout(1000)), /Selected shell is not available/);
  await assert.rejects(controller.create({ id: 'session' }, { id: 'terminal-d' }, AbortSignal.abort(new Error('gone'))), /gone/);
  stopFollowing(); stopPassing();
  assert.equal(controller.spawn, original.spawn);
  assert.equal(controller.userLaunch, original.userLaunch);
});

/** DSH's own check in `spawn`: only a path it offers now is started. */
function dshController(candidates: string[]) {
  const started: { id: string; shellPath?: string; terminal?: string }[] = [];
  const subprocess = { spawnTerminal(options: { env?: Record<string, string> }) { return options.env?.[TERMINAL_ID_ENV]; } };
  return { started, controller: {
    config: { shellCandidates: candidates },
    execution() { return { subprocess }; },
    async spawn(this: { config: { shellCandidates: string[] }; execution(agent: unknown): { subprocess: typeof subprocess } }, agent: unknown, _owner: unknown, request: { id: string; shellPath?: string }) {
      const { subprocess: used } = this.execution(agent);
      await Promise.resolve();
      if (request.shellPath !== undefined && !this.config.shellCandidates.includes(request.shellPath)) throw new Error('Selected shell is not available in this execution environment');
      started.push({ ...request, terminal: used.spawnTerminal({ env: {} }) });
    },
  } };
}

test('a launcher remembered in the folder of an earlier install starts where it is now', async t => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-moved-launcher-')); t.after(() => rm(home, { recursive: true, force: true }));
  const { started, controller } = dshController(['/bin/sh']), original = controller.spawn;
  const spawn = (shellPath?: string) => (controller.spawn as unknown as (...args: unknown[]) => Promise<void>)({}, {}, { id: 'tab', ...shellPath === undefined ? {} : { shellPath } }, AbortSignal.timeout(1000));
  // Before terminals had a plugin of their own the launchers were in Remote Agents' folder, and browsers remember that path.
  const before = join(home, 'storages', 'dsh-remote-agents', 'terminal'), now = join(home, 'storages', 'dsh-remote-terminals', 'terminal');
  await assert.rejects(spawn(join(before, 'Remote workspace')), /Selected shell is not available/, 'what DSH answers on its own');

  const { shell, dispose } = await installWorkspaceTerminal(controller, now, { hosts: join(home, 'hosts.json'), tui: join(home, 'tui.json') });
  assert.equal(shell, join(now, 'Remote workspace'));
  for (const name of ['Remote workspace', 'Remote Claude', 'Remote Codex']) await spawn(join(before, name));
  assert.deepEqual(started.map(item => item.shellPath), ['Remote workspace', 'Remote Claude', 'Remote Codex'].map(name => join(now, name)));
  assert.deepEqual(started.map(item => item.terminal), ['tab', 'tab', 'tab'], 'the terminal is still told which one it is');
  started.length = 0;
  await spawn(shell); await spawn('/bin/sh'); await spawn();
  assert.deepEqual(started.map(item => item.shellPath), [shell, '/bin/sh', undefined], 'every other choice is passed on as it is');
  await assert.rejects(spawn('/elsewhere/fish'), /Selected shell is not available/, 'a shell DSH does not offer is still refused');

  dispose();
  assert.equal(controller.spawn, original, 'DSH has its own spawn back');
  assert.deepEqual(controller.config.shellCandidates, ['/bin/sh']);
});

test('New terminal follows a restored launcher to where it is now', () => {
  storage.clear();
  storage.set('dsh.terminal.shell', '/old/terminal/Remote Claude');
  const restored = model('three', true);
  const views = { view: (() => restored.value) as (...args: unknown[]) => unknown };
  const undo = restoreRemoteTerminals(views as never);
  views.view('session', 'key', 'content');
  restored.set({ shell: { path: '/new/terminal/Remote Claude', name: 'Remote Claude' } });
  assert.equal(storage.get('dsh.terminal.shell'), '/new/terminal/Remote Claude');
  assert.equal(storage.get('remote-agents.terminal.shell.three'), '/new/terminal/Remote Claude');

  // Another launcher, or the user's own shell, is their choice for New terminal.
  for (const chosen of ['/new/terminal/Remote workspace', '/bin/zsh']) {
    storage.set('dsh.terminal.shell', chosen);
    restored.set({ shell: { path: '/new/terminal/Remote Claude', name: 'Remote Claude' } });
    assert.equal(storage.get('dsh.terminal.shell'), chosen);
  }
  undo();
});

test('closing a terminal ends its holder, even if that fails, and DSH still closes it', async () => {
  const ended: [string, string][] = [], closed: string[] = [];
  const controller = { async close(_agent: { id: string }, id: string) { closed.push(id); } };
  const original = controller.close;
  const stop = endClosedTerminals(controller as never, async (session, holder) => { ended.push([session, holder]); throw new Error('host is offline'); });
  await (controller.close as (agent: { id: string }, id: string) => Promise<void>)({ id: 'session' }, 'terminal');
  assert.deepEqual(closed, ['terminal']);
  assert.deepEqual(ended, [['session', tabHolder('session', 'terminal')]]);
  stop();
  assert.equal(controller.close, original);
});
