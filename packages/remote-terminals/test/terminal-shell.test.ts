import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { installTerminalPreference } from '../src/client/terminal-shell.js';
import { preferTerminalShell } from '../src/client/terminal-preference.js';
import { closeArchived, tuiTheme } from '../src/client/tui.js';
import type { Client } from '../src/client/index.js';

/** The browser's storage, holding the shell DSH remembers. */
function storage(t: TestContext) {
  const saved = new Map<string, string>([['dsh.terminal.shell', '/bin/zsh']]), previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => { saved.set(key, value); }, removeItem: (key: string) => { saved.delete(key); },
  } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else Reflect.deleteProperty(globalThis, 'localStorage'); });
  return saved;
}

test('New terminal opens the remote shell while a verified remote conversation is in view, and the user\'s own elsewhere', async t => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
  t.after(() => { if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else Reflect.deleteProperty(globalThis, 'window'); });
  const saved = storage(t), shell = () => saved.get('dsh.terminal.shell'), launcher = '/dsh/storages/dsh-remote-terminals/terminal/Remote workspace';
  let cwd = '/dsh/remote-workspaces/box/app', inView = 'remote', verified = true;
  const listeners = new Set<() => void>(), effects: (() => void)[] = [], requested: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const { action, sessionId } = JSON.parse(String(init?.body));
    assert.equal(String(input), '/api/remote-terminals'); assert.equal(action, 'terminalShell'); requested.push(sessionId);
    // The server answers without a shell for a conversation that is not in a verified remote workspace.
    return Response.json(sessionId === 'remote' && verified ? { shell: launcher } : {});
  });
  const sessions = { list: {
    getSnapshot: () => ({ byId: {
      remote: { cwd, retainedBy: { mainView: inView === 'remote' ? 1 : 0 } }, local: { cwd: '/local/project', retainedBy: { mainView: inView === 'local' ? 1 : 0 } },
      idle: { cwd: '/dsh/remote-workspaces/box/idle' },
    } }),
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
  } };
  const ctx = {
    get: (name: string) => (name === 'sessions' ? sessions : undefined),
    inject: (_names: string[], factory: (ctx: unknown) => void) => factory(ctx),
    effect: (factory: () => () => void) => { effects.push(factory()); },
  } as unknown as Client;
  const show = async (session: string) => { inView = session; for (const listener of listeners) listener(); await setImmediate(); await setImmediate(); };
  installTerminalPreference(ctx); await setImmediate(); await setImmediate();
  assert.deepEqual(requested, ['remote'], 'local and inactive conversations are not asked about');
  assert.equal(shell(), launcher);
  await show('local'); assert.equal(shell(), '/bin/zsh');
  await show('remote'); assert.equal(shell(), launcher);
  // A shell chosen in the menu of a remote conversation stays remembered after leaving it.
  saved.set('dsh.terminal.shell', '/bin/bash'); await show('local'); assert.equal(shell(), '/bin/bash');
  await show('remote'); assert.equal(shell(), launcher); await show('local'); assert.equal(shell(), '/bin/bash');
  await show('remote');
  assert.deepEqual(requested, ['remote'], 'switching back reuses the answer');
  // A workspace that is no longer remote gives the user's shell back.
  cwd = '/local/changed'; for (const listener of listeners) listener(); await setImmediate();
  assert.equal(shell(), '/bin/bash');
  cwd = '/dsh/remote-workspaces/box/app'; await show('remote'); assert.equal(shell(), launcher);
  // A machine removed in Remote Agents is asked about again, and the workspace is not verified any more.
  verified = false; window.dispatchEvent(new Event('remote-agents-updated')); await setImmediate(); await setImmediate();
  assert.equal(shell(), '/bin/bash');
  verified = true; window.dispatchEvent(new Event('remote-agents-updated')); await setImmediate(); await setImmediate();
  assert.equal(shell(), launcher);
  for (const dispose of effects.reverse()) dispose();
  assert.equal(shell(), '/bin/bash', 'unloading the plugin gives back the user\'s shell');
  assert.equal(listeners.size, 0);
});

test('Remote Claude and Remote Codex count as remote launchers when remembering the user\'s shell', t => {
  const saved = storage(t), shell = () => saved.get('dsh.terminal.shell');
  for (const [workspace, claude] of [['/dsh/terminal/Remote workspace', '/dsh/terminal/Remote Claude'], ['/dsh/terminal/Remote workspace', '/dsh/terminal/Remote Codex'], ['C:\\dsh\\terminal\\Remote workspace.cmd', 'C:\\dsh\\terminal\\Remote Claude.cmd'], ['C:\\dsh\\terminal\\Remote workspace.cmd', 'C:\\dsh\\terminal\\Remote Codex.cmd']] as const) {
    saved.set('dsh.terminal.shell', '/bin/zsh');
    preferTerminalShell(workspace); assert.equal(shell(), workspace);
    // Chosen in the menu: a reload in the remote conversation keeps it, and leaving gives the user's shell back.
    saved.set('dsh.terminal.shell', claude);
    preferTerminalShell(workspace); assert.equal(shell(), claude);
    preferTerminalShell(undefined); assert.equal(shell(), '/bin/zsh');
    // Coming back opens the plain remote shell again, and the user's own shell is still the one remembered.
    preferTerminalShell(workspace); assert.equal(shell(), workspace);
    preferTerminalShell(undefined); assert.equal(shell(), '/bin/zsh');
  }
});

test('archiving a TUI conversation closes its terminal once, and only a TUI one', () => {
  const closed = new Set<string>(), ended: string[] = [], isTui = (id: string) => id !== 'chat';
  const sync = (archived: string[]) => closeArchived(archived, isTui, id => ended.push(id), closed);
  sync(['chat']); assert.deepEqual(ended, []);
  sync(['chat', 'tui']); sync(['chat', 'tui']); assert.deepEqual(ended, ['tui']);
  // Unarchived, it runs again in a new terminal, which archiving it again ends too.
  sync(['chat']); sync(['chat', 'tui']); assert.deepEqual(ended, ['tui', 'tui']);
});

test('a TUI puts the scaled CJK font ahead of DSH\'s terminal fonts, without changing other terminals', () => {
  const plain = { fontFamilies: { terminal: '', ui: 'sans' }, fontSizes: { terminal: 13 } };
  const shown = tuiTheme(plain) as typeof plain;
  assert.deepEqual(shown, { fontFamilies: { terminal: '"RA TUI CJK"', ui: 'sans' }, fontSizes: { terminal: 13 } });
  assert.equal(plain.fontFamilies.terminal, '');
  assert.equal(tuiTheme(plain), shown, 'the same theme gives the same object, as the terminal compares them');
  assert.equal((tuiTheme({ fontFamilies: { terminal: 'Sarasa Mono SC' } }) as typeof plain).fontFamilies.terminal, 'Sarasa Mono SC, "RA TUI CJK"', 'a font the user chose comes first');
  assert.equal(tuiTheme(undefined), undefined);
});
