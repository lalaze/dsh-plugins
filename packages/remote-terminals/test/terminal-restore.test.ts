import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isRemoteLauncher, restoreRemoteTerminals } from '../src/client/terminal-restore.js';
import { tabHolder, TERMINAL_ID_ENV } from '../src/holder-protocol.js';
import { endClosedTerminals, passTerminalId } from '../src/terminal.js';

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
  assert.deepEqual(Object.keys(controller), []);
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
