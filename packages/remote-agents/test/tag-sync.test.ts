import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { SharedTag, SharedWorkspace } from '../src/core/domain.js';
import { Store } from '../src/core/store.js';
import { WorkspaceTagSync, type WorkspaceTagsService } from '../src/workspace/tag-sync.js';

type TagState = ReturnType<WorkspaceTagsService['snapshot']>;
/** The host's shared registry: one list per machine, stamped with the host's clock. */
function registry() {
  const lists = new Map<string, SharedWorkspace[]>();
  let clock = Date.parse('2026-11-02T12:00:00.000Z');
  return {
    lists, reachable: true,
    list(hostId: string) { return this.reachable ? structuredClone(lists.get(hostId) ?? []) : undefined; },
    set(hostId: string, path: string, tags: SharedTag[], by: string): SharedWorkspace {
      const list = lists.get(hostId) ?? []; lists.set(hostId, list);
      let entry = list.find(w => w.path === path);
      if (!entry) { entry = { path }; list.push(entry); }
      Object.assign(entry, { tags: structuredClone(tags), tagsAt: new Date(clock += 1000).toISOString(), tagsBy: by });
      return structuredClone(entry);
    },
  };
}
/** One DSH: its own Workspace Tags, store and workspace ids, mapping its anchor folders to the shared machine. */
async function dsh(t: TestContext, shared: ReturnType<typeof registry>, name: string, workspaces: Record<string, string>, initial: TagState = { tags: [], assignments: {} }) {
  const dir = await mkdtemp(join(tmpdir(), 'tag-sync-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, 'state.json')); await store.open();
  let state = structuredClone(initial), ids = 0;
  const listeners = new Set<(state: TagState) => void>();
  const tags: WorkspaceTagsService = {
    version: 1, snapshot: () => structuredClone(state),
    replace: async next => { state = structuredClone(next); for (const listener of listeners) listener(state); return structuredClone(state); },
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  const published: string[] = [];
  const sync = new WorkspaceTagSync(store, {
    tags: () => tags,
    workspaces: () => Object.entries(workspaces).map(([workspaceId, path]) => ({ workspaceId, path })),
    // `/anchors/<dir>` stands for `/srv/<dir>` on the shared machine; other folders are local.
    targets: async path => path.startsWith('/anchors/') ? [{ hostId: 'machine', remotePath: path.replace('/anchors/', '/srv/') }] : [],
    shared: async hostId => shared.list(hostId),
    publish: async (hostId, path, value) => { published.push(path); return shared.set(hostId, path, value, name); },
  }, { every: 60_000, delay: 60_000 });
  t.after(() => sync.close());
  const names = (workspaceId: string) => (state.assignments[workspaceId] ?? []).map(id => state.tags.find(tag => tag.id === id)!.name);
  const tag = (workspaceId: string, tagNames: string[]) => {
    const next = structuredClone(state);
    next.assignments[workspaceId] = tagNames.map(tagName => {
      let found = next.tags.find(candidate => candidate.name === tagName);
      if (!found) next.tags.push(found = { id: `${name}-${++ids}`, name: tagName, color: 'blue' });
      return found.id;
    });
    if (!tagNames.length) delete next.assignments[workspaceId];
    state = next;
  };
  return { sync, store, tags, names, tag, published, state: () => state };
}

test('tags follow a shared workspace between DSH instances by machine and directory, and never by local ids', async t => {
  const shared = registry();
  const macbook = await dsh(t, shared, 'MacBook', { 'mb-app': '/anchors/app', 'mb-web': '/anchors/web', 'mb-local': '/Users/me/notes' });
  const mini = await dsh(t, shared, 'Mac mini', { 'mm-app': '/anchors/app', 'mm-web': '/anchors/web', 'mm-local': '/Users/me/notes' });
  // The Mac mini starts without tags: it has nothing to share and clears nothing.
  await mini.sync.run();
  assert.equal(shared.lists.get('machine'), undefined);

  macbook.tag('mb-app', ['Dana', 'Work']); macbook.tag('mb-local', ['Private']);
  await macbook.sync.run();
  assert.deepEqual(macbook.published, ['/srv/app'], 'a local workspace is not shared');
  await mini.sync.run();
  assert.deepEqual(mini.names('mm-app'), ['Dana', 'Work']);
  assert.deepEqual(mini.state().tags.map(tag => [tag.name, tag.color]), [['Dana', 'blue'], ['Work', 'blue']], 'missing tags are created with their color');
  assert.deepEqual(mini.names('mm-local'), []);
  assert.deepEqual(mini.published, [], 'what arrived is not sent back');

  // A change on either side reaches the other; a rename arrives as the new name.
  mini.tag('mm-app', ['Work']); await mini.sync.run(); await macbook.sync.run();
  assert.deepEqual(macbook.names('mb-app'), ['Work']);
  macbook.tag('mb-app', ['Work', 'Dana Inc']); await macbook.sync.run(); await mini.sync.run();
  assert.deepEqual(mini.names('mm-app'), ['Work', 'Dana Inc']);
  macbook.tag('mb-app', []); await macbook.sync.run(); await mini.sync.run();
  assert.deepEqual(mini.names('mm-app'), [], 'removing every tag is shared too');

  // Names match ignoring case and spacing, so the same tags never ping-pong.
  const before = [...macbook.published, ...mini.published].length;
  mini.tag('mm-app', ['work']); await mini.sync.run(); await macbook.sync.run();
  assert.deepEqual(macbook.names('mb-app'), ['Work'], 'the existing tag is reused');
  await mini.sync.run(); await macbook.sync.run();
  assert.equal([...macbook.published, ...mini.published].length, before + 1, 'settled after one publish');
});

test('the first comparison combines both sides, and an unreachable registry changes nothing', async t => {
  const shared = registry();
  const macbook = await dsh(t, shared, 'MacBook', { 'mb-web': '/anchors/web' });
  const mini = await dsh(t, shared, 'Mac mini', { 'mm-web': '/anchors/web' });
  mini.tag('mm-web', ['Mini']); await mini.sync.run();
  macbook.tag('mb-web', ['Book']);
  shared.reachable = false; await macbook.sync.run();
  assert.equal(macbook.published.length, 0); assert.deepEqual(macbook.names('mb-web'), ['Book']);
  shared.reachable = true; await macbook.sync.run();
  assert.deepEqual(macbook.names('mb-web'), ['Mini', 'Book'], 'nothing either side had is lost');
  await mini.sync.run();
  assert.deepEqual(mini.names('mm-web'), ['Mini', 'Book']);
  assert.deepEqual(mini.store.tagSync('machine\0/srv/web')?.names, ['Mini', 'Book'], 'the agreement is remembered across restarts');
  // A later change on the MacBook while the Mac mini also changed: the one that publishes last wins.
  macbook.tag('mb-web', ['Book']); mini.tag('mm-web', ['Mini', 'Book', 'Extra']);
  await macbook.sync.run(); await mini.sync.run(); await macbook.sync.run();
  assert.deepEqual(macbook.names('mb-web'), ['Mini', 'Book', 'Extra']); assert.deepEqual(mini.names('mm-web'), ['Mini', 'Book', 'Extra']);
});

test('a tag change here triggers a sync on its own', async t => {
  const shared = registry();
  const macbook = await dsh(t, shared, 'MacBook', { 'mb-app': '/anchors/app' });
  await macbook.sync.run();
  const next = macbook.tags.snapshot();
  next.tags.push({ id: 'x', name: 'Fresh', color: 'green' }); next.assignments['mb-app'] = ['x'];
  await macbook.tags.replace(next);
  for (let i = 0; i < 50 && !macbook.published.length; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(shared.lists.get('machine')?.[0].tags, [{ name: 'Fresh', color: 'green' }]);
});
