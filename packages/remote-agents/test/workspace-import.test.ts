import assert from 'node:assert/strict';
import test from 'node:test';
import { installWorkspaceImport } from '../src/client/workspace/import.js';

test('shared remote workspaces are added to the sidebar once, and a failed addition is offered again', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const calls: { action: string; body: Record<string, unknown> }[] = [];
  let offers = [{ hostId: 'host-1', host: 'box', remotePath: '/srv/app', path: '/dsh/remote-workspaces/box/app' }, { hostId: 'host-1', host: 'box', remotePath: '/srv/web', path: '/dsh/remote-workspaces/box/web' }];
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)); calls.push({ action: body.action, body });
    return Response.json(body.action === 'sharedWorkspaces' ? offers : { ok: true });
  });
  const items = [{ path: '/home/me/local-project' }, { path: '/dsh/remote-workspaces/box/web' }], created: string[] = [];
  let fail = true;
  const dispose = installWorkspaceImport({ workspaces: {
    list: { getSnapshot: () => ({ items }), subscribe: () => () => {} },
    create: async ({ path }) => { if (path.endsWith('/app') && fail) throw new Error('not now'); created.push(path); items.push({ path }); return {}; },
  } });
  t.after(dispose);
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };
  t.mock.timers.tick(2000); await settle();
  assert.deepEqual(calls.map(c => c.action), ['publishWorkspaces', 'sharedWorkspaces', 'seeWorkspaces']);
  assert.deepEqual(calls[0].body.paths, ['/home/me/local-project', '/dsh/remote-workspaces/box/web'], 'workspaces added here are shared first');
  assert.deepEqual(created, [], 'one already in the sidebar is not added again, and a failed one is not recorded');
  assert.deepEqual(calls[2].body, { action: 'seeWorkspaces', hostId: 'host-1', paths: ['/srv/web'] });
  fail = false; offers = offers.filter(o => o.remotePath === '/srv/app'); calls.length = 0;
  t.mock.timers.tick(60_000); await settle();
  assert.deepEqual(created, ['/dsh/remote-workspaces/box/app']);
  assert.deepEqual(calls.at(-1)?.body, { action: 'seeWorkspaces', hostId: 'host-1', paths: ['/srv/app'] });
});
