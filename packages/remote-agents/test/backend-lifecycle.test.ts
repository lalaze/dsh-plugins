import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { SshBackend } from '../src/agents/backend.js';
import type { CliSession } from '../src/agents/runtime.js';
import type { HostConfig, Task } from '../src/core/domain.js';
import type { Store } from '../src/core/store.js';
import type { SshTransport } from '../src/core/ssh.js';
import type { LaunchSharing } from '../src/sharing/sharing.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
/** Real backend/session/link lifecycle; only persistence, SSH and CLI initialization are replaced. */
function fixture(t: TestContext) {
  const host: HostConfig = { id: 'host', label: 'Host', connection: 'ssh://host', share: false };
  const tasks: Task[] = [], sessions: CliSession[] = [];
  let launches = 0, opens = 0;
  const store = { directory: '/unused', hosts: () => [host], task: (predicate: (task: Task) => boolean) => tasks.find(predicate),
    update: async (change: (state: { tasks: Task[] }) => void) => { change({ tasks }); },
    relayCleanups: () => [], usageListeners: new Set(),
  } as unknown as Store;
  const transport = { relays: true, exec: async () => { throw new Error('Unexpected SSH'); }, start: () => { throw new Error('Unexpected SSH'); } } as unknown as SshTransport;
  const sharing = { prepare: async () => undefined, attached: () => {} };
  const backend = new SshBackend(host, store, transport, () => sharing as unknown as LaunchSharing);
  // Private hooks provide deterministic barriers without involving timers or a real SSH daemon.
  const internal = backend as any;
  const history = { checkpoint: async () => undefined, turn: async () => ({ entries: [] }), flush: async () => {}, append: async () => {}, hasMessage: async () => false };
  internal.history = async () => history;
  internal.relays = async () => ({ launch: async () => { launches++; } });
  const link = internal.link.bind(backend);
  internal.link = (...args: unknown[]) => {
    const value = link(...args);
    value.open = () => { opens++; };
    return value;
  };
  const session = internal.session.bind(backend);
  internal.session = (...args: unknown[]) => {
    const value: CliSession = session(...args); sessions.push(value);
    value.initialize = async () => { value.agent.status = 'running'; };
    return value;
  };
  const task = (id: string, relay = false): Task => {
    const value = { id, hostId: host.id, cwd: '/project', provider: 'codex', model: 'model', prompt: 'hello', title: id,
      serverId: 'server', createdAt: new Date().toISOString(), state: 'ready', agentId: id,
      native: { protocol: 'codex', sessionId: id, argv: ['codex'], initialSent: true, resumable: true },
      ...(relay ? { relay: { id: `relay-${id}` } } : {}),
    } as Task;
    tasks.push(value); return value;
  };
  t.after(async () => { await backend.close(); for (const session of sessions) session.release(); });
  return { backend, internal, history, sharing, sessions, task, launches: () => launches, opens: () => opens };
}

test('close drains an in-flight restore without registering or opening its relay afterwards', async t => {
  const f = fixture(t), entered = deferred(), resume = deferred();
  f.history.turn = async () => { entered.resolve(); await resume.promise; return { entries: [] }; };
  const task = f.task('restore', true), restoring = f.backend.restore(task);
  const rejected = assert.rejects(restoring, /backend has stopped/);
  await entered.promise;
  let closed = false;
  const closing = f.backend.close().then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false, 'close waits for the local history restore');
  await assert.rejects(f.backend.restore(task), /backend has stopped/, 'closed backend does not return its old pending restore');
  await assert.rejects(f.backend.recover(task), /backend has stopped/);
  resume.resolve(); await Promise.all([closing, rejected]);
  assert.equal(f.internal.sessions.size, 0);
  assert.equal(f.internal.restoring.size, 0);
  assert.equal(f.internal.reservations.size, 0);
  assert.equal(f.opens(), 0);
  assert.equal(f.sessions[0].alive, false);
  assert.equal((f.sessions[0].relay as any).timer, undefined);
});

test('close does not deadlock when a start is waiting for a relay restore', async t => {
  const f = fixture(t), entered = deferred(), resume = deferred();
  f.history.turn = async () => { entered.resolve(); await resume.promise; return { entries: [] }; };
  const starting = f.backend.recover(f.task('resume', true));
  const rejected = assert.rejects(starting, /backend has stopped/);
  await entered.promise;
  const closing = f.backend.close(); resume.resolve();
  await Promise.all([closing, rejected]);
  assert.equal(f.internal.sessions.size, 0);
  assert.equal(f.internal.starting.size, 0);
});

test('concurrent launches reserve the last slot before asynchronous launch preparation', async t => {
  const f = fixture(t);
  for (let i = 0; i < 7; i++) await f.backend.recover(f.task(`live-${i}`));
  const entered = deferred(), resume = deferred();
  f.sharing.prepare = async () => { entered.resolve(); await resume.promise; return undefined; };
  const first = f.backend.recover(f.task('eighth'));
  await entered.promise;
  await assert.rejects(f.backend.recover(f.task('ninth')), /already has 8 working CLI sessions/);
  assert.equal(f.launches(), 7, 'the rejected start never launches a CLI');
  resume.resolve(); await first;
  assert.equal(f.launches(), 8);
  assert.equal([...f.internal.sessions.values()].filter((s: CliSession) => s.alive).length, 8);
  assert.equal(f.internal.reservations.size, 0);
});

test('restores and launches share the same quota, and a failed restore releases its slot', async t => {
  const f = fixture(t);
  for (let i = 0; i < 7; i++) await f.backend.recover(f.task(`live-${i}`));
  const entered = deferred(), resume = deferred();
  f.history.turn = async () => { entered.resolve(); await resume.promise; throw new Error('History failed'); };
  const restoring = f.backend.restore(f.task('eighth', true));
  const rejected = assert.rejects(restoring, /History failed/);
  await entered.promise;
  await assert.rejects(f.backend.restore(f.task('ninth-restore', true)), /already has 8 working CLI sessions/);
  await assert.rejects(f.backend.recover(f.task('ninth-start')), /already has 8 working CLI sessions/);
  resume.resolve(); await rejected;
  assert.equal(f.internal.reservations.size, 0);
  assert.equal(f.sessions.at(-1)!.alive, false);
  await f.backend.recover(f.task('replacement'));
  assert.equal(f.launches(), 8);
});

test('a failed launch releases its reservation for the next task', async t => {
  const f = fixture(t);
  for (let i = 0; i < 7; i++) await f.backend.recover(f.task(`live-${i}`));
  const relays = f.internal.relays;
  f.internal.relays = async () => ({ launch: async () => { throw new Error('Launch failed'); } });
  await assert.rejects(f.backend.recover(f.task('failed')), /Launch failed/);
  assert.equal(f.internal.reservations.size, 0);
  f.internal.relays = relays;
  await f.backend.recover(f.task('replacement'));
  assert.equal(f.launches(), 8);
});

test('closing during relay launch cannot register or open the late session', async t => {
  const f = fixture(t), entered = deferred(), resume = deferred();
  f.internal.relays = async () => ({ launch: async () => { entered.resolve(); await resume.promise; } });
  const starting = f.backend.recover(f.task('late'));
  const rejected = assert.rejects(starting, /backend has stopped/);
  await entered.promise;
  const closing = f.backend.close(); resume.resolve();
  await Promise.all([closing, rejected]);
  assert.equal(f.internal.sessions.size, 0);
  assert.equal(f.internal.reservations.size, 0);
  assert.equal(f.sessions.length, 0);
  assert.equal(f.opens(), 0);
});


test('aborting launch preparation releases its reserved slot without starting a CLI', async t => {
  const f = fixture(t);
  for (let i = 0; i < 7; i++) await f.backend.recover(f.task(`live-${i}`));
  const entered = deferred(), resume = deferred(), controller = new AbortController();
  f.sharing.prepare = async () => { entered.resolve(); await resume.promise; return undefined; };
  const starting = f.backend.recover(f.task('aborted'), controller.signal);
  const rejected = assert.rejects(starting, /abort/i);
  await entered.promise; controller.abort(); resume.resolve(); await rejected;
  assert.equal(f.internal.reservations.size, 0);
  assert.equal(f.launches(), 7);
  await f.backend.recover(f.task('replacement'));
  assert.equal(f.launches(), 8);
});

test('successful restores count towards quota and idle resumable sessions remain reclaimable', async t => {
  const f = fixture(t);
  for (let i = 0; i < 8; i++) {
    const task = f.task(`restored-${i}`, true); task.native!.resumable = false;
    await f.backend.restore(task);
  }
  await assert.rejects(f.backend.restore(f.task('blocked', true)), /already has 8 working CLI sessions/);
  assert.equal(f.opens(), 8);
  const idle = f.sessions[0]; idle.agent.resumable = true;
  await f.backend.restore(f.task('replacement', true));
  assert.equal(idle.alive, false);
  assert.equal(f.internal.sessions.size, 8);
  assert.equal(f.internal.reservations.size, 0);
});
