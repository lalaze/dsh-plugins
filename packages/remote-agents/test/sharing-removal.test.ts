import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Store } from '../src/core/store.js';

const INSTANCE = { id: 'dsh-11111111-2222-4333-8444-555555555555', label: "Lin's MacBook" };
const HOST = { id: 'host-0001', label: 'Build box', connection: 'ssh://box', serverId: 'ssh-box' };
const OTHER = { id: 'host-0002', label: 'Other', connection: 'ssh://other', serverId: 'ssh-other' };

/** A task as 0.2.138 saved it. */
function saved(id: string, extra: Record<string, unknown> = {}) {
  return { id, hostId: HOST.id, serverId: HOST.serverId, cwd: '/srv/project', provider: 'codex', model: 'remote-model', prompt: 'hello', title: id, state: 'ready',
    agentId: `native-${id}`, createdAt: '2026-11-01T00:00:00.000Z', native: { protocol: 'codex', sessionId: id, argv: ['codex'], initialSent: true }, ...extra };
}
/** State written by 0.2.138 with sessions shared on a host: two started here, two copies of another DSH's. */
async function state(t: TestContext, change: (state: Record<string, unknown>) => void = () => {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ra-unshare-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'state.json');
  const value: Record<string, unknown> = { version: 1, hosts: [HOST, { ...OTHER, share: false }], instance: INSTANCE,
    tasks: [
      saved('task-own-0001', { shared: { rev: 4 }, relay: { id: 'relay-own-0001' }, chat: { sessionId: 'chat-own', route: 'route', delivered: { messageId: 'm1', cursor: null, done: true } } }),
      saved('task-copy-0001', { shared: { rev: 2, imported: true, creator: 'Mac mini' }, chat: { sessionId: 'chat-copy', route: 'route', history: 'pending' } }),
      saved('task-copy-0002', { shared: { rev: 9, imported: true } }),
      saved('task-never-0001'),
      saved('task-other-0001', { hostId: OTHER.id, serverId: OTHER.serverId, shared: { rev: 1 } }),
    ],
    seenWorkspaces: { [HOST.id]: ['/srv/project'] }, sharedDeletions: [{ hostId: HOST.id, id: 'task-gone-0001' }], tagSync: { [`${HOST.id}\0/srv/project`]: { names: ['web'] } } };
  change(value);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
  return { directory, path };
}

test('state saved while sessions were shared opens with this DSH\'s own sessions only', async t => {
  const { path } = await state(t);
  const store = new Store(path); await store.open(); t.after(() => store.close());
  assert.deepEqual(store.tasks(() => true).map(task => task.id), ['task-own-0001', 'task-never-0001', 'task-other-0001'], 'copies of another DSH\'s sessions are dropped');
  const own = store.task(task => task.id === 'task-own-0001')! as unknown as Record<string, unknown>;
  assert.equal(own.shared, undefined);
  assert.deepEqual(own.relay, { id: 'relay-own-0001' }, 'its CLI is still found');
  assert.deepEqual(own.chat, { sessionId: 'chat-own', route: 'route', delivered: { messageId: 'm1', cursor: null, done: true } }, 'its conversation stays bound');
  assert.equal((store.hosts().find(host => host.id === OTHER.id) as { share?: unknown }).share, false, 'what the removed switch saved is left as it was');
  // The first save drops what the removed feature kept.
  await store.update(next => { next.chatFast = ['chat-own']; });
  const written = JSON.parse(await readFile(path, 'utf8'));
  for (const key of ['seenWorkspaces', 'sharedDeletions', 'tagSync']) assert.equal(written[key], undefined, key);
  // Opening again adds nothing: the markers are gone.
  const again = new Store(path); await again.open(); t.after(() => again.close());
  assert.equal(again.tasks(() => true).length, 3);
});

test('what 0.2.139 to 0.2.142 kept for withdrawing shared sessions is dropped on the next save, not refused', async t => {
  const { path } = await state(t, value => { value.sharedWithdrawals = { 'host-gone': ['task-old-0001'], [HOST.id]: ['task-old-0002'] }; });
  const store = new Store(path); await store.open(); t.after(() => store.close());
  assert.equal(store.tasks(() => true).length, 3);
  await store.update(next => { next.chatFast = ['chat-own']; });
  const written = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual([written.instance, written.sharedWithdrawals], [undefined, undefined]);
  assert.deepEqual(written.hosts.map((host: { id: string }) => host.id), [HOST.id, OTHER.id]);
});
