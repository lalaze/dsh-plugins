import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { SshBackend } from '../src/agents/backend.js';
import { Store } from '../src/core/store.js';
import type { SshTransport } from '@dsh-plugins/remote-core/ssh.js';

const run = promisify(execFile);
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

test('state saved while sessions were shared opens with this DSH\'s own sessions only, and lists the shared ones to withdraw', async t => {
  const { path } = await state(t);
  const store = new Store(path); await store.open(); t.after(() => store.close());
  assert.deepEqual(store.tasks(() => true).map(task => task.id), ['task-own-0001', 'task-never-0001', 'task-other-0001'], 'copies of another DSH\'s sessions are dropped');
  const own = store.task(task => task.id === 'task-own-0001')! as unknown as Record<string, unknown>;
  assert.equal(own.shared, undefined);
  assert.deepEqual(own.relay, { id: 'relay-own-0001' }, 'its CLI is still found');
  assert.deepEqual(own.chat, { sessionId: 'chat-own', route: 'route', delivered: { messageId: 'm1', cursor: null, done: true } }, 'its conversation stays bound');
  assert.deepEqual(store.sharedWithdrawals(HOST.id), ['task-own-0001'], 'a session never shared needs no withdrawal');
  assert.deepEqual(store.sharedWithdrawals(OTHER.id), ['task-other-0001']);
  assert.equal((store.hosts().find(host => host.id === OTHER.id) as { share?: unknown }).share, false, 'what the removed switch saved is left as it was');
  // The first save drops what the removed feature kept, and remembers what is still to withdraw.
  await store.update(next => { next.chatFast = ['chat-own']; });
  const written = JSON.parse(await readFile(path, 'utf8'));
  for (const key of ['seenWorkspaces', 'sharedDeletions', 'tagSync']) assert.equal(written[key], undefined, key);
  assert.deepEqual(written.sharedWithdrawals, { [HOST.id]: ['task-own-0001'], [OTHER.id]: ['task-other-0001'] });
  assert.deepEqual(written.instance, INSTANCE);
  // Opening again adds nothing: the markers are gone.
  const again = new Store(path); await again.open(); t.after(() => again.close());
  assert.deepEqual(again.sharedWithdrawals(HOST.id), ['task-own-0001']);
  assert.equal(again.tasks(() => true).length, 3);
});

test('withdrawals of a host that was removed since are not kept', async t => {
  const { path } = await state(t, value => { value.sharedWithdrawals = { 'host-gone': ['task-old-0001'], [HOST.id]: ['task-old-0002'] }; });
  const store = new Store(path); await store.open(); t.after(() => store.close());
  assert.deepEqual(store.sharedWithdrawals('host-gone'), []);
  assert.deepEqual(store.sharedWithdrawals(HOST.id), ['task-old-0002', 'task-own-0001']);
});

/** A transport that runs the backend's commands in a local shell whose HOME is a temporary folder. */
function shell(home: string): { transport: SshTransport; commands: string[]; fail: { next?: Error } } {
  const commands: string[] = [], fail: { next?: Error } = {};
  const transport = { relays: true, start: () => { throw new Error('Unexpected SSH process'); },
    exec: async (command: string) => {
      commands.push(command);
      if (fail.next) { const error = fail.next; fail.next = undefined; throw error; }
      return (await run('sh', ['-c', command], { env: { ...process.env, HOME: home } })).stdout;
    } } as unknown as SshTransport;
  return { transport, commands, fail };
}

test('sessions this DSH shared are marked withdrawn in the host\'s registry, as switching sharing off did, and nothing else is touched', async t => {
  const { path, directory } = await state(t);
  const home = join(directory, 'remote-home'), sessions = join(home, '.dsh-remote-agents', 'shared-v1', 'sessions');
  const record = async (id: string, files: Record<string, unknown>) => {
    await mkdir(join(sessions, id), { recursive: true });
    for (const [name, value] of Object.entries(files)) await writeFile(join(sessions, id, name), JSON.stringify(value));
  };
  await record('task-own-0001', { 'manifest.json': { rev: 4, title: 'Mine' }, 'lease.json': { instance: 'dsh-other' }, 'head.json': { seq: 3, bytes: 90 } });
  await record('task-copy-0001', { 'manifest.json': { rev: 2, title: 'Theirs' } });
  await record('task-elsewhere-0001', { 'manifest.json': { rev: 1 }, 'deleted.json': { by: 'someone', at: 'earlier' } });
  const store = new Store(path); await store.open(); t.after(() => store.close());
  const { transport, commands, fail } = shell(home);
  const backend = new SshBackend(store.hosts()[0], store, transport); t.after(() => backend.close());

  fail.next = new Error('ssh: connect to host box: Operation timed out');
  await backend.withdrawShared();
  assert.deepEqual(store.sharedWithdrawals(HOST.id), ['task-own-0001'], 'an unreachable host is asked again later');

  await Promise.all([backend.withdrawShared(), backend.withdrawShared()]);
  assert.equal(commands.length, 2, 'concurrent requests share one command');
  const tombstone = JSON.parse(await readFile(join(sessions, 'task-own-0001', 'deleted.json'), 'utf8'));
  assert.equal(tombstone.withdrawn, INSTANCE.id); assert.equal(tombstone.by, INSTANCE.label);
  assert.ok(Number.isFinite(Date.parse(tombstone.at)));
  assert.deepEqual((await readdir(join(sessions, 'task-own-0001'))).sort(), ['deleted.json', 'head.json', 'lease.json', 'manifest.json'], 'its record and history stay on the host');
  assert.deepEqual(await readdir(join(sessions, 'task-copy-0001')), ['manifest.json'], 'another DSH\'s session is left alone');
  assert.deepEqual(JSON.parse(await readFile(join(sessions, 'task-elsewhere-0001', 'deleted.json'), 'utf8')), { by: 'someone', at: 'earlier' });
  assert.deepEqual(store.sharedWithdrawals(HOST.id), []);
  assert.deepEqual(store.sharedWithdrawals(OTHER.id), ['task-other-0001'], 'another host waits for its own connection');

  await backend.withdrawShared();
  assert.equal(commands.length, 2, 'nothing left to withdraw sends nothing');
});

test('a host without a registry, or a DSH that never reached one, has nothing to withdraw', async t => {
  const { path, directory } = await state(t);
  const home = join(directory, 'empty-home'); await mkdir(home);
  const store = new Store(path); await store.open(); t.after(() => store.close());
  const first = shell(home), backend = new SshBackend(store.hosts()[0], store, first.transport); t.after(() => backend.close());
  await backend.withdrawShared();
  assert.equal(first.commands.length, 1);
  assert.deepEqual(await readdir(home), [], 'nothing is created on the host');
  assert.deepEqual(store.sharedWithdrawals(HOST.id), []);

  const anonymous = await state(t, value => { delete value.instance; });
  const without = new Store(anonymous.path); await without.open(); t.after(() => without.close());
  const second = shell(home), other = new SshBackend(without.hosts()[0], without, second.transport); t.after(() => other.close());
  await other.withdrawShared();
  assert.deepEqual(second.commands, [], 'no identity means no registry was ever joined');
  assert.deepEqual(without.sharedWithdrawals(HOST.id), []);
});
