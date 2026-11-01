import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { RemoteAgentsService } from '../src/agents/service.js';
import { Store } from '../src/core/store.js';
import { createHandler } from '../src/http.js';
import { fixture } from './fakes.js';

test('delegation summaries expose durable ownership without converting it to a main-chat binding', async t => {
  const { service, request, path, store, remote } = await fixture(t);
  const owned = await service.create(request(), { origin: 'dsh', owner: { sessionId: 'parent-one' } });
  const archived = await service.create(request(), { origin: 'dsh', owner: { sessionId: 'parent-one' } });
  await service.archive(archived.id);
  await service.create(request(), { origin: 'dsh', owner: { sessionId: 'parent-two' } });
  await service.create(request(), { origin: 'dsh' }); // Legacy delegates cannot safely be guessed into a parent.
  await service.create(request(), { chat: { sessionId: 'parent-one', route: 'remote/main' } });
  await service.create(request(), { owner: { sessionId: 'parent-one' }, chat: { sessionId: 'main-chat', route: 'remote/main' } });
  const rows = await service.delegations('parent-one');
  assert.deepEqual(rows.map(a => a.id), [owned.id, archived.id]);
  assert.equal(rows[0].ownerSessionId, 'parent-one');
  assert.equal(rows[0].chatSessionId, undefined);
  assert.equal(rows[1].archived, true);
  assert.equal(store.task(task => task.id === owned.id)?.chat, undefined);
  await service.close();
  const reopened = new Store(path); await reopened.open();
  const resumed = new RemoteAgentsService(reopened, remote.backend); t.after(() => resumed.close());
  assert.deepEqual((await resumed.delegations('parent-one')).map(a => a.id), rows.map(a => a.id));
  assert.deepEqual(await resumed.delegations('no-delegates'), []);
});

test('opening an owner catalog recovers only that owner’s existing relays and starts no CLI or prompt', async t => {
  const { service, request, store, remote } = await fixture(t);
  const mine = await service.create(request(), { origin: 'dsh', owner: { sessionId: 'parent-one' } });
  const archived = await service.create(request(), { origin: 'dsh', owner: { sessionId: 'parent-one' } });
  await service.archive(archived.id);
  const otherHost = randomUUID();
  await store.update(state => {
    state.hosts.push({ id: otherHost, label: 'Unrelated', connection: 'ssh://unrelated', serverId: 'other-server' });
    const other = structuredClone(state.tasks[0]);
    other.id = randomUUID(); other.agentId = `native-${other.id}`; other.hostId = otherHost;
    other.owner = { sessionId: 'parent-two' }; state.tasks.push(other);
    for (const task of state.tasks) {
      task.relay = { id: randomUUID() };
      task.native = { protocol: 'codex', sessionId: `native-${task.id}`, argv: ['codex', 'app-server'], initialSent: true };
    }
  });
  await service.close();
  const constructed: string[] = [];
  const observer = new RemoteAgentsService(store, host => {
    constructed.push(host.id); const backend = remote.backend(host);
    backend.agent = async () => null;
    return backend;
  });
  t.after(() => observer.close());
  const creates = remote.creates;
  const recovering = await observer.delegations('parent-one');
  assert.equal(recovering[0].status, 'starting'); assert.equal(recovering[0].reconnecting, true);
  await observer.delegations('parent-one');
  assert.deepEqual(remote.restores, [mine.id], 'repeated menu polls do not reacquire the relay');
  assert.equal(constructed.includes(otherHost), false);
  await observer.detail(archived.id);
  assert.deepEqual(remote.restores, [mine.id], 'archived history is readable without reattaching its old relay');
  assert.equal(remote.creates, creates); assert.equal(remote.sends, 0);
});

test('owner catalog keeps live states, metadata and errors; HTTP requires an explicit valid owner', async t => {
  const { service, request, remote } = await fixture(t);
  const owner = { sessionId: 'parent-one' };
  const working = await service.create(request(), { origin: 'dsh', owner });
  const attention = await service.create(request(), { origin: 'dsh', owner });
  remote.live(working.id).status = 'running';
  remote.live(attention.id).pendingPermissions = [{ id: 'approval', name: 'Bash', kind: 'tool' }];
  remote.loseCreate = true;
  const failed = await service.create(request(), { origin: 'dsh', owner });
  const handle = createHandler(service);
  const post = (input: unknown) => handle(new Request('http://dsh.test/api/remote-agents', { method: 'POST', headers: { 'content-type': 'application/json', 'X-DSH-Remote-Agents': '1' }, body: JSON.stringify(input) }));
  assert.equal((await post({ action: 'delegations' })).status, 400);
  assert.equal((await post({ action: 'delegations', sessionId: ' ' })).status, 400);
  const response = await post({ action: 'delegations', sessionId: owner.sessionId });
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  const rows = await response.json();
  assert.deepEqual(rows.map((a: { status: string }) => a.status), ['running', 'attention', 'error']);
  assert.equal(rows[0].id, working.id); assert.equal(rows[0].provider, 'codex');
  assert.equal(rows[0].model, 'remote-model'); assert.equal(rows[0].cwd, '/srv/project');
  assert.equal(rows[1].pendingPermissions, 1); assert.equal(rows[2].id, failed.id);
  assert.match(rows[2].error, /Connection lost/);
});


test('offline delegate recovery reports errors and menu polling does not churn retries', async t => {
  const { service, request, store, remote } = await fixture(t);
  const created = await service.create(request(), { origin: 'dsh', owner: { sessionId: 'parent-one' } });
  await store.update(state => {
    const task = state.tasks[0];
    task.relay = { id: randomUUID() };
    task.native = { protocol: 'codex', sessionId: 'saved-thread', argv: ['codex', 'app-server'], initialSent: true };
  });
  await service.close();
  let attempts = 0;
  const observer = new RemoteAgentsService(store, host => {
    const backend = remote.backend(host);
    backend.agent = async () => null;
    backend.restore = async () => { attempts++; throw new Error('SSH host is offline'); };
    return backend;
  });
  t.after(() => observer.close());
  assert.equal((await observer.delegations('parent-one'))[0].status, 'starting');
  // close drains serial recovery and the durable failure receipt, without touching the fake CLI.
  await observer.close();
  assert.equal(attempts, 1);
  // A stopped service still exposes the persisted error when reopened by the next plugin instance.
  const restarted = new RemoteAgentsService(store, host => {
    const backend = remote.backend(host);
    backend.agent = async () => null;
    backend.restore = async () => { attempts++; throw new Error('SSH host is offline'); };
    return backend;
  });
  t.after(() => restarted.close());
  const next = (await restarted.delegations('parent-one'))[0];
  assert.equal(next.id, created.id); assert.equal(next.status, 'error');
  assert.match(next.error!, /offline/); assert.equal(next.reconnecting, true);
  await restarted.delegations('parent-one'); await restarted.delegations('parent-one');
  assert.equal((await restarted.detail(created.id)).agent.status, 'error');
  assert.equal(attempts, 2, 'one recovery attempt per service, not per menu poll');
  assert.equal(remote.sends, 0); assert.equal(remote.creates, 1);
});
