import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { installWorkspaceSidebar, workspaceFileAddress } from '../src/client/workspace-sidebar.js';
import type { Client } from '../src/client/index.js';

test('native file addresses preserve remote relative and absolute paths and reject other scopes', () => {
  assert.deepEqual(workspaceFileAddress('dsh-resource://file/session/session-id/src%2Fa.ts'), { sessionId: 'session-id', path: 'src/a.ts' });
  assert.deepEqual(workspaceFileAddress('dsh-resource://file/session/session-id/%2Fsrv%2Fapp%2Fa.ts'), { sessionId: 'session-id', path: '/srv/app/a.ts' });
  for (const address of ['https://file/session/x/a', 'dsh-resource://file/absolute/a', 'dsh-resource://file/session/%zz/a', 'invalid']) assert.equal(workspaceFileAddress(address), undefined);
});
test('native sidebar claims only verified remote sessions, invalidates workspace changes and disposes registrations', async t => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
  t.after(() => { if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else Reflect.deleteProperty(globalThis, 'window'); });
  let cwd = '/dsh/remote-workspaces/box/app', inView = 'remote';
  const listeners = new Set<() => void>(), effects: (() => void)[] = [], requested: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
    const { sessionId } = JSON.parse(String(init?.body)); requested.push(sessionId);
    return sessionId === 'remote' && cwd.includes('remote-workspaces') ? Response.json({ hostId: 'host-test', label: 'Box', cwd: '/srv/app' }) : Response.json({ error: 'not remote' }, { status: 409 });
  });
  // The registry in force: DSH's own Workspace files type, plus whatever the plugin registers on top.
  const NativeIcon = () => null;
  const nativeFiles = { id: '@deepseek-ai/dsh-client-ui-sidebar-files', kind: 'files', priority: 'builtin', title: () => 'Files',
    guide: [{ id: 'workspace', commandId: 'workspace.files', order: 10, title: () => 'Workspace files', description: () => 'Browse the session workspace', icon: NativeIcon }] };
  type Definition = Record<string, unknown> & { id: string; kind: string; guide?: Record<string, unknown>[] };
  const types = new Map<string, Definition>(), slots = new Set<string>();
  const services = {
    sidebarRightTabs: {
      register(spec: Definition) { assert.ok(!types.has(spec.id), `${spec.id} registered twice`); types.set(spec.id, spec); return () => { types.delete(spec.id); }; },
      get: (kind: string) => [...types.values()].find(type => type.kind === kind) ?? (kind === 'files' ? nativeFiles : undefined),
    },
    sessions: { list: {
      getSnapshot: () => ({ byId: {
        remote: { cwd, retainedBy: { mainView: inView === 'remote' ? 1 : 0 } }, local: { cwd: '/local/project', retainedBy: { mainView: inView === 'local' ? 1 : 0 } },
        idle: { cwd: '/dsh/remote-workspaces/box/idle' },
      } }),
      subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    } },
  };
  const ctx = {
    get: (name: keyof typeof services) => services[name],
    inject: (_names: string[], factory: (ctx: unknown) => void) => factory(ctx),
    effect: (factory: () => () => void) => { effects.push(factory()); },
    slots: { inject: (_name: string, factory: () => () => void) => { effects.push(factory()); }, register: ({ key }: { key: string }) => { slots.add(key); return () => { slots.delete(key); }; } },
  } as unknown as Client;
  const show = async (session: string) => { inView = session; for (const listener of listeners) listener(); await setImmediate(); await setImmediate(); };
  installWorkspaceSidebar(ctx); await setImmediate(); await setImmediate();
  const claim = types.get('remote-agents/file')!.canOpen as (address: string) => boolean;
  assert.equal(claim('dsh-resource://file/session/remote/src/a.ts'), true);
  assert.equal(claim('dsh-resource://file/session/local/src/a.ts'), false);
  assert.equal(claim('dsh-resource://file/session/idle/src/a.ts'), false);
  assert.deepEqual(requested, ['remote'], 'warming does not probe local or inactive sessions');
  assert.deepEqual([...slots].sort(), ['remote-agents/file', 'remote-agents/files', 'remote-agents/workspace']);
  // A verified remote conversation: Workspace files (and its shortcut) open the remote files, in the native entry's place.
  const files = types.get('remote-agents/files')!;
  assert.equal(files.kind, 'files'); assert.equal(files.priority, 'extension');
  assert.deepEqual(files.guide!.map(({ id, commandId, order, icon }) => ({ id, commandId, order, icon })), [{ id: 'workspace', commandId: 'workspace.files', order: 10, icon: NativeIcon }]);
  assert.equal((files.title as () => string)(), 'Files');
  assert.equal(types.get('remote-agents/workspace')!.guide?.length, 1, 'Remote workspace is offered in a remote conversation');
  // A local conversation gets DSH's own Workspace files back, and no Remote workspace entry.
  await show('local');
  assert.equal(types.has('remote-agents/files'), false);
  assert.equal(types.get('remote-agents/workspace')!.guide, undefined);
  await show('remote');
  assert.equal(types.has('remote-agents/files'), true);
  assert.deepEqual(requested, ['remote'], 'switching back reuses the verified workspace');
  // A workspace that is no longer remote releases the takeover.
  cwd = '/local/changed'; for (const listener of listeners) listener(); await setImmediate();
  assert.equal(claim('dsh-resource://file/session/remote/src/a.ts'), false);
  assert.equal(types.has('remote-agents/files'), false);
  for (const dispose of effects.reverse()) dispose();
  assert.equal(listeners.size, 0); assert.equal(types.size, 0); assert.equal(slots.size, 0);
});
