import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { Backend } from '../src/agents/backend.js';
import { RemoteAgentsService } from '../src/agents/service.js';
import { RemoteError, type HostConfig, type Task } from '@dsh-plugins/remote-core/domain.js';
import { Store } from '../src/core/store.js';
import { FakeRemote } from './fakes.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

/** Real service/modules/store; only remote I/O is replaced, including deterministic concurrency barriers. */
async function setup(t: TestContext, configure: (backend: Backend, host: HostConfig) => void = () => {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ra-boundaries-'));
  const store = new Store(join(directory, 'state.json')); await store.open();
  const remote = new FakeRemote(); remote.store = store;
  const constructed: string[] = [];
  const service = new RemoteAgentsService(store, host => {
    constructed.push(host.id);
    const backend = remote.backend(host); configure(backend, host); return backend;
  });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  const hostId = (await service.addHost({ label: 'Host', connection: 'ssh://box' })).hosts[0].id;
  const saveTask = async (id: string, extra: Partial<Task> = {}) => {
    const task: Task = { id, hostId, serverId: remote.serverId, cwd: '/srv/project', provider: 'codex', model: 'remote-model',
      prompt: 'hello', title: id, state: 'ready', agentId: `native-${id}`, createdAt: new Date().toISOString(),
      native: { protocol: 'codex', sessionId: id, argv: ['codex'], resumable: true, initialSent: true }, ...extra };
    await store.update(state => { state.tasks.push(task); }); return task;
  };
  return { service, store, remote, hostId, constructed, saveTask };
}

test('concurrent host operations share initial readiness but each rechecks machine identity', async t => {
  const entered = deferred(), proceed = deferred();
  let connects = 0, sharing = 0, identity = 'remote-box-1';
  const { service, store, hostId, constructed, remote } = await setup(t, backend => {
    backend.connect = async () => { if (++connects === 1) { entered.resolve(); await proceed.promise; } return identity; };
    backend.startSharing = () => { sharing++; };
  });
  const first = service.connect(hostId); await entered.promise;
  const second = service.connect(hostId); await tick();
  assert.equal(connects, 1); assert.equal(service.hosts()[0].status, 'connecting');
  proceed.resolve(); await Promise.all([first, second]);
  assert.equal(constructed.length, 1); assert.equal(connects, 3); assert.equal(sharing, 1);
  assert.equal(store.hosts()[0].serverId, identity);
  await service.connect(hostId); assert.equal(connects, 4);
  identity = 'different-machine';
  await assert.rejects(service.connect(hostId), { status: 409, message: /identity changed/ });
  assert.equal(service.hosts()[0].status, 'error');
  assert.equal(store.hosts()[0].serverId, 'remote-box-1');
  identity = 'remote-box-1'; await service.connect(hostId);
  assert.equal(sharing, 2, 'failed identity checks clear readiness and restart sharing on recovery');
  assert.equal(service.hosts()[0].status, 'connected'); assert.equal(remote.closes, 0);
});

test('connection errors mark the host; task binding, workspace verification and action errors do not', async t => {
  let failure: Error | undefined;
  const { service, store, hostId, saveTask } = await setup(t, backend => {
    backend.connect = async () => { if (failure) throw failure; return 'remote-box-1'; };
    backend.providers = async () => { throw new Error('secret-value ' + 'x'.repeat(2200)); };
    backend.sharingError = () => 'share secret-value';
  });
  await store.update(state => { state.hosts[0].password = 'secret-value'; });
  failure = new RemoteError('connect secret-value', 401);
  await assert.rejects(service.connect(hostId), { status: 401, message: 'connect [redacted]' });
  assert.deepEqual([service.hosts()[0].status, service.hosts()[0].error], ['error', 'connect [redacted]']);
  failure = undefined; await service.connect(hostId);
  assert.equal(service.hosts()[0].shareError, 'share [redacted]');
  const task = await saveTask('task-binding', { serverId: 'another-machine' });
  await assert.rejects(service.retry(task.id), { status: 409, message: /different remote SSH machine/ });
  await assert.rejects(service.withWorkspace(hostId, async () => { throw new RemoteError('verify secret-value', 403); }, async () => assert.fail('must not act')),
    { status: 403, message: 'verify [redacted]' });
  await assert.rejects(service.providers(hostId, '/srv/project'), error => {
    assert.ok(error instanceof RemoteError); assert.equal(error.status, 502);
    assert.equal(error.message.length, 2000); assert.match(error.message, /^\[redacted\]/); return true;
  });
  assert.deepEqual([service.hosts()[0].status, service.hosts()[0].error], ['connected', undefined]);
});

for (const operation of ['discover', 'providers', 'remove', 'sharing'] as const) {
  test(`catalog discovery serializes with ${operation} across the module/facade boundary`, async t => {
    const entered = deferred(), proceed = deferred();
    let probes = 0, withdrawals = 0;
    const { service, store, hostId } = await setup(t, backend => {
      const providers = backend.providers;
      backend.providers = async (...args) => { if (++probes === 1) { entered.resolve(); await proceed.promise; } return providers(...args); };
      backend.withdrawSharing = async () => { withdrawals++; };
    });
    let changes = 0; service.onCatalogChange(() => { changes++; });
    const discovering = service.discoverHost(hostId); await entered.promise;
    let finished = false;
    const next = (operation === 'discover' ? service.discoverHost(hostId)
      : operation === 'providers' ? service.setHostProviders(hostId, [])
      : operation === 'remove' ? service.removeHost(hostId) : service.setHostSharing(hostId, false))
      .then(() => { finished = true; });
    await tick();
    assert.equal(finished, false); assert.equal(probes, 1); assert.equal(withdrawals, 0);
    assert.equal(store.hosts().length, 1); assert.equal(store.hosts()[0].enabledProviders, undefined);
    proceed.resolve(); await Promise.all([discovering, next]);
    assert.equal(changes, operation === 'providers' ? 3 : operation === 'sharing' ? 1 : 2);
    if (operation === 'providers') assert.deepEqual(store.hosts()[0].enabledProviders, []);
    if (operation === 'remove') assert.deepEqual(store.hosts(), []);
    if (operation === 'sharing') assert.equal(store.hosts()[0].share, false);
  });
}

test('catalog failures preserve the saved models and disabled discovery never constructs a backend', async t => {
  const { service, store, hostId, remote, constructed } = await setup(t);
  let changes = 0; const unsubscribe = service.onCatalogChange(() => { changes++; });
  await service.discoverHost(hostId); const catalog = store.hosts()[0].catalog;
  remote.homeError = 'offline discovery'; await service.discoverHost(hostId);
  assert.deepEqual(store.hosts()[0].catalog, catalog); assert.equal(service.hosts()[0].modelError, 'offline discovery');
  assert.equal(service.hosts()[0].status, 'connected', 'a failed home query is an action failure');
  assert.equal(changes, 2);
  const disabled = (await service.addHost({ label: 'Disabled', connection: 'ssh://disabled', enabledProviders: [] })).hosts.at(-1)!;
  await service.discoverHost(disabled.id); assert.equal(changes, 3);
  await service.setHostProviders(disabled.id, []); assert.equal(changes, 5);
  assert.deepEqual(constructed, [hostId]);
  unsubscribe(); await service.removeHost(disabled.id); assert.equal(changes, 5);
});

test('shared callbacks bind on backend creation and read the current listeners and conversation binding', async t => {
  const callbacks: { workspace?: () => void; history?: (id: string) => void; read?: (id: string) => void }[] = [];
  let connects = 0;
  const { service, store, hostId, saveTask } = await setup(t, backend => {
    const events: typeof callbacks[number] = {}; callbacks.push(events);
    backend.connect = async () => { connects++; return 'remote-box-1'; };
    backend.onSharedWorkspaces = listener => { events.workspace = listener; return () => {}; };
    backend.onSharedHistory = listener => { events.history = listener; return () => {}; };
    backend.onSharedRead = listener => { events.read = listener; return () => {}; };
  });
  const task = await saveTask('task-notify', { chat: { sessionId: 'before', route: 'route' } });
  await service.timeline(task.id); assert.equal(connects, 0);
  assert.equal(callbacks.length, 1); assert.ok(callbacks[0].workspace); assert.ok(callbacks[0].history); assert.ok(callbacks[0].read);
  const seen: string[] = [];
  const workspace = (id: string) => seen.push(`workspace:${id}`);
  service.sharedWorkspaceListeners.add(workspace);
  service.sharedHistoryListeners.add(id => seen.push(`history:${id}`));
  service.chatReadListeners.add(id => seen.push(`read:${id}`));
  await store.update(state => { state.tasks[0].chat!.sessionId = 'after'; });
  callbacks[0].workspace!(); callbacks[0].history!(task.id); callbacks[0].read!(task.id); callbacks[0].read!('missing');
  assert.deepEqual(seen, [`workspace:${hostId}`, `history:${task.id}`, 'read:after']);
  service.sharedWorkspaceListeners.delete(workspace); callbacks[0].workspace!(); assert.equal(seen.length, 3);
  await service.setHostSharing(hostId, false);
  assert.equal(callbacks.length, 2, 'the replacement backend subscribes before any connect');
  callbacks[1].history!(task.id); assert.equal(seen.at(-1), `history:${task.id}`); assert.equal(connects, 0);
});

test('host, read and sender observations stay lazy and remain safe after close', async t => {
  const { service, store, hostId, saveTask, constructed } = await setup(t);
  const task = await saveTask('task-not-started', { state: 'creating', agentId: undefined, chat: { sessionId: 'chat', route: 'route' } });
  const instance = await store.instance();
  assert.equal(service.hosts()[0].status, 'disconnected');
  assert.equal((await service.summary(task.id)).status, 'error');
  assert.equal(service.chatReadMark('chat'), undefined);
  assert.deepEqual(service.sender(hostId, instance.id, 'self'), { self: true });
  assert.deepEqual(service.sender(hostId, 'other', 'Other'), { name: 'Other' });
  assert.deepEqual(constructed, []);
  const closing = service.close(); assert.equal(service.stopped, true); await closing;
  assert.equal(service.chatReadMark('chat'), undefined); await service.markChatRead('chat');
  assert.equal(await service.sharedWorkspaceList(hostId), undefined);
  assert.deepEqual(service.sender(hostId, 'other', 'Other'), { name: 'Other' });
  assert.deepEqual(constructed, []);
  await assert.rejects(service.connect(hostId), { status: 503 });
});

test('sharing starts on every recovery/read/workspace path without probing unrelated hosts', async t => {
  let starts = 0, connects = 0;
  const marked: string[] = [];
  const positions = new Map<string, { read: number; head: number }>();
  const { service, hostId, saveTask, constructed } = await setup(t, backend => {
    backend.connect = async () => { connects++; return 'remote-box-1'; };
    backend.startSharing = () => { starts++; };
    backend.markRead = async id => { marked.push(id); throw new Error('offline'); };
    backend.readPosition = id => positions.get(id);
    backend.sharedWorkspaces = async () => [];
  });
  await service.addHost({ label: 'Other', connection: 'ssh://other' });
  const first = await saveTask('task-read-one', { relay: { id: 'relay-one' }, chat: { sessionId: 'chat', route: 'route' } });
  const second = await saveTask('task-read-two', { relay: { id: 'relay-two' }, chat: { sessionId: 'chat', route: 'route' } });
  await service.connect(hostId); assert.equal(starts, 1);
  await service.resume(hostId); assert.equal(starts, 2);
  await service.resumeConversation('chat'); assert.equal(starts, 3);
  await service.markChatRead('chat'); assert.equal(starts, 4); assert.deepEqual(marked, [first.id, second.id]);
  await service.sharedWorkspaces(hostId); assert.equal(starts, 5);
  await service.sharedWorkspaceList(hostId); assert.equal(starts, 6);
  assert.equal(connects, 2); assert.deepEqual(constructed, [hostId]);
  positions.set(first.id, { read: 3, head: 3 }); positions.set(second.id, { read: 2, head: 3 });
  assert.equal(service.chatReadMark('chat'), undefined);
  positions.set(second.id, { read: 3, head: 3 });
  assert.equal(service.chatReadMark('chat'), `${first.id}:3,${second.id}:3`);
  await service.close(); assert.equal(service.chatReadMark('chat'), undefined);
});

test('failed workspace publication is retried, while registry listing alone tolerates an offline host', async t => {
  let fail = true, published = 0;
  const { service, store, hostId } = await setup(t, backend => {
    backend.shareWorkspace = async () => { published++; if (fail) throw new Error('offline'); };
    backend.sharedWorkspaces = async () => { if (fail) throw new Error('offline'); return [{ path: '/srv/project' }]; };
  });
  await assert.rejects(service.shareWorkspace(hostId, '/srv/project'), /offline/);
  assert.deepEqual(store.seenWorkspaces(hostId), []);
  assert.equal(await service.sharedWorkspaceList(hostId), undefined);
  await assert.rejects(service.sharedWorkspaces(hostId), /offline/);
  fail = false; await service.shareWorkspace(hostId, '/srv/project');
  assert.equal(published, 2); assert.deepEqual(store.seenWorkspaces(hostId), ['/srv/project']);
  assert.deepEqual(await service.sharedWorkspaces(hostId), []);
  assert.deepEqual(await service.sharedWorkspaceList(hostId), [{ path: '/srv/project' }]);
});

test('restore deduplication and task mutations share one queue without connecting or replaying', async t => {
  const entered = deferred(), proceed = deferred();
  let restores = 0, connects = 0;
  const { service, store, hostId, saveTask, remote } = await setup(t, backend => {
    backend.connect = async () => { connects++; throw new Error('must not connect'); };
    backend.restore = async () => { restores++; entered.resolve(); await proceed.promise; throw new Error('restore secret-value'); };
  });
  await store.update(state => { state.hosts[0].password = 'secret-value'; });
  const task = await saveTask('task-restore', { relay: { id: 'relay-saved' }, chat: { sessionId: 'chat', route: 'route' } });
  const first = service.resumeConversation('chat'); await entered.promise;
  const second = service.resumeConversation('chat'); await service.detail(task.id);
  let renamed = false;
  const rename = service.rename(task.id, 'renamed').then(() => { renamed = true; });
  await tick(); assert.equal(restores, 1); assert.equal(renamed, false);
  proceed.resolve(); await Promise.all([first, second, rename]);
  assert.equal(store.task(t => t.id === task.id)?.error, 'restore [redacted]');
  assert.equal(connects, 0); assert.equal(remote.creates, 0); assert.equal(remote.sends, 0);
  assert.equal(service.hosts().find(h => h.id === hostId)?.status, 'disconnected');
});

test('close releases backends before draining both task and catalog locks and flushing receipts', async t => {
  const creating = deferred(), discovering = deferred(), proceed = deferred();
  const events: string[] = [];
  let rejectCreate: (error: Error) => void = () => {};
  const { service, store, hostId, remote } = await setup(t, backend => {
    backend.create = async () => new Promise((_resolve, reject) => { rejectCreate = reject; creating.resolve(); });
    backend.providers = async () => { discovering.resolve(); await proceed.promise; events.push('catalog'); return []; };
    backend.close = async () => { events.push('backend-close'); rejectCreate(new Error('closed during creation')); throw new Error('close failure'); };
  });
  const create = service.create({ id: 'task-closing', hostId, cwd: '/srv/project', provider: 'codex', model: 'remote-model', prompt: 'hello' });
  await creating.promise;
  assert.equal((await service.summary('task-closing')).status, 'starting', 'summaries observe the task lock');
  const discover = service.discoverHost(hostId); await discovering.promise;
  const flush = store.flush.bind(store);
  store.flush = async () => { events.push('flush'); await flush(); };
  let finished = false;
  const close = service.close().then(() => { finished = true; });
  assert.equal(service.stopped, true); assert.deepEqual(events, ['backend-close']);
  await tick(); assert.equal(finished, false, 'catalog mutations are part of the same shutdown drain');
  assert.equal(remote.stops, 0); assert.equal(remote.detaches, 0);
  proceed.resolve(); await Promise.all([create, discover, close]);
  assert.deepEqual(events, ['backend-close', 'catalog', 'flush']);
  const reopened = new Store(join(store.directory, 'state.json')); await reopened.open();
  assert.equal(reopened.tasks(() => true)[0].state, 'uncertain');
  assert.equal(reopened.tasks(() => true)[0].error, 'closed during creation');
  assert.ok(reopened.hosts()[0].catalog);
  assert.equal(service.hosts()[0].status, 'disconnected', 'connections clear only after draining mutations');
});

test('host removal forgets locally before atomically clearing bindings and does not connect', async t => {
  const events: string[] = [];
  let connects = 0;
  const { service, store, hostId, saveTask } = await setup(t, backend => {
    backend.connect = async () => { connects++; throw new Error('offline'); };
    backend.forgetLocal = async task => {
      events.push(`forget:${task.id}`);
      assert.ok(store.hosts().some(h => h.id === task.hostId));
      assert.ok(store.seenWorkspaces(task.hostId).length);
    };
    backend.cleanup = async () => { events.push('cleanup'); };
    backend.close = async () => {
      events.push('close');
      const state = store.snapshot();
      assert.equal(state.hosts.some(h => h.id === hostId), false);
      assert.equal(state.tasks.some(t => t.hostId === hostId), false);
      assert.equal(state.mainChatProjects?.some(p => p.hostId === hostId), false);
      assert.equal(state.relayCleanups?.some(c => c.hostId === hostId), false);
      assert.equal(state.sharedDeletions?.some(d => d.hostId === hostId), false);
      assert.equal(state.seenWorkspaces?.[hostId], undefined);
    };
  });
  const own = await saveTask('task-own'), imported = await saveTask('task-imported', { shared: { rev: 1, imported: true } });
  const other = (await service.addHost({ label: 'Other', connection: 'ssh://other' })).hosts.at(-1)!.id;
  await store.update(state => {
    state.mainChatProjects = [hostId, other].map(id => ({ id, hostId: id, cwd: '/srv/project', label: id, providers: [] }));
    state.relayCleanups = [hostId, other].map(id => ({ hostId: id, relayId: `relay-${id}` }));
    state.sharedDeletions = [hostId, other].map(id => ({ hostId: id, id: `deleted-${id}` }));
    state.seenWorkspaces = { [hostId]: ['/srv/project'], [other]: ['/keep'] };
  });
  let changes = 0; service.onCatalogChange(() => { changes++; });
  await service.removeHost(hostId, { deleteAgents: true });
  assert.deepEqual(events, [`forget:${own.id}`, `forget:${imported.id}`, 'cleanup', 'close']);
  assert.equal(connects, 0); assert.equal(changes, 1);
  assert.deepEqual(store.chatProjects().map(p => p.hostId), [other]);
  assert.equal(store.relayCleanups(other).length, 1); assert.equal(store.sharedDeletions(other).length, 1);
  assert.deepEqual(store.seenWorkspaces(other), ['/keep']);
});

test('failed sharing withdrawal keeps configuration and imported tasks until a successful retry', async t => {
  let fail = true;
  const events: string[] = [];
  const { service, store, hostId, saveTask, constructed } = await setup(t, backend => {
    backend.withdrawSharing = async ids => { events.push(`withdraw:${ids.join()}`); if (fail) throw new RemoteError('registry offline', 409); };
    backend.forgetLocal = async task => { events.push(`forget:${task.id}`); };
    backend.close = async () => { events.push('close'); };
    backend.restore = async task => { events.push(`restore:${task.id}`); return null; };
  });
  const own = await saveTask('task-own', { relay: { id: 'own-relay' } });
  const imported = await saveTask('task-imported', { shared: { rev: 1, imported: true } });
  await service.seeWorkspaces(hostId, ['/srv/project']);
  await assert.rejects(service.setHostSharing(hostId, false), { status: 409 });
  assert.equal(store.hosts()[0].share, undefined); assert.equal(store.tasks(() => true).length, 2);
  assert.deepEqual(store.seenWorkspaces(hostId), ['/srv/project']);
  assert.deepEqual(events, [`withdraw:${own.id}`]); assert.equal(constructed.length, 1);
  fail = false; await service.setHostSharing(hostId, false);
  await service.resume(hostId); // Join the facade's background recovery.
  assert.deepEqual(events.slice(1, 4), [`withdraw:${own.id}`, `forget:${imported.id}`, 'close']);
  assert.ok(events.indexOf(`restore:${own.id}`) > events.indexOf('close'));
  assert.equal(constructed.length, 2); assert.equal(store.hosts()[0].share, false);
  assert.deepEqual(store.tasks(() => true).map(t => t.id), [own.id]); assert.deepEqual(store.seenWorkspaces(hostId), []);
});

test('delegation recovery waits for its retry window but a new relay gets an immediate attempt', async t => {
  let now = Date.now(), restores = 0;
  t.mock.method(Date, 'now', () => now);
  const { service, store, saveTask } = await setup(t, backend => {
    backend.restore = async () => { restores++; return null; };
  });
  const task = await saveTask('task-delegation', { origin: 'dsh', owner: { sessionId: 'owner' }, relay: { id: 'relay-one' } });
  const observe = async () => {
    const rows = await service.delegations('owner');
    await service.rename(task.id, 'Delegate'); // Drain a scheduled restore through the task queue.
    return rows[0];
  };
  assert.equal((await observe()).reconnecting, true); assert.equal(restores, 1);
  now += 29_999; await observe(); assert.equal(restores, 1);
  now++; await observe(); assert.equal(restores, 2);
  await store.update(state => { state.tasks[0].relay = { id: 'relay-two' }; });
  await observe(); assert.equal(restores, 3);
  await service.close(); await service.delegations('owner'); assert.equal(restores, 3);
});

test('host removal uses launch sharing assigned after service construction', async t => {
  const { service, hostId } = await setup(t);
  const forgotten: string[] = [];
  service.sharing = {
    prepare: async () => ({ servers: [] }),
    attached: () => {},
    forget: id => { forgotten.push(id); },
  };
  await service.removeHost(hostId);
  assert.deepEqual(forgotten, [hostId]);
  assert.deepEqual(service.hosts(), []);
});

test('deleting everywhere refuses an unreachable shared registry before deleting tasks or connecting', async t => {
  let connects = 0, deletions = 0;
  const timeouts: number[] = [];
  const { service, store, hostId, saveTask } = await setup(t, backend => {
    backend.connect = async () => { connects++; throw new Error('must not connect'); };
    backend.sharingReachable = async timeout => { timeouts.push(timeout); return false; };
    backend.forget = backend.forgetLocal = async () => { deletions++; };
  });
  const task = await saveTask('task-unreachable');
  await assert.rejects(service.removeHost(hostId, { deleteAgents: true, everywhere: true }),
    { status: 409, message: /Connect to this machine/ });
  assert.deepEqual(timeouts, [10_000]);
  assert.equal(connects, 0); assert.equal(deletions, 0);
  assert.deepEqual(store.task(t => t.id === task.id), task);
  assert.equal(store.hosts()[0].id, hostId);
});
