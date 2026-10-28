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
  let cwd = '/dsh/remote-workspaces/box/app';
  const listeners = new Set<() => void>(), types: Record<string, unknown>[] = [], effects: (() => void)[] = [], requested: string[] = [];
  let disposed = 0;
  t.mock.method(globalThis, 'fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
    const { sessionId } = JSON.parse(String(init?.body)); requested.push(sessionId);
    return sessionId === 'remote' && cwd.includes('remote-workspaces') ? Response.json({ hostId: 'host-test', label: 'Box', cwd: '/srv/app' }) : Response.json({ error: 'not remote' }, { status: 409 });
  });
  const services = {
    sidebarRightTabs: { register(spec: Record<string, unknown>) { types.push(spec); return () => { disposed++; }; } },
    sessions: { list: {
      getSnapshot: () => ({ byId: { remote: { cwd, retainedBy: { mainView: 1 } }, local: { cwd: '/local/project', retainedBy: { mainView: 1 } }, idle: { cwd: '/dsh/remote-workspaces/box/idle' } } }),
      subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    } },
  };
  const ctx = {
    get: (name: keyof typeof services) => services[name],
    inject: (_names: string[], factory: (ctx: unknown) => void) => factory(ctx),
    effect: (factory: () => () => void) => { effects.push(factory()); },
    slots: { inject: (_name: string, factory: () => () => void) => { effects.push(factory()); }, register: () => () => { disposed++; } },
  } as unknown as Client;
  installWorkspaceSidebar(ctx); await setImmediate();
  const claim = types.find(type => type.id === 'remote-agents/file')!.canOpen as (address: string) => boolean;
  assert.equal(claim('dsh-resource://file/session/remote/src/a.ts'), true);
  assert.equal(claim('dsh-resource://file/session/local/src/a.ts'), false);
  assert.equal(claim('dsh-resource://file/session/idle/src/a.ts'), false);
  assert.deepEqual(requested, ['remote'], 'warming does not probe local or inactive sessions');
  cwd = '/local/changed'; for (const listener of listeners) listener();
  assert.equal(claim('dsh-resource://file/session/remote/src/a.ts'), false);
  for (const dispose of effects.reverse()) dispose();
  assert.equal(listeners.size, 0); assert.equal(disposed, 4);
});
