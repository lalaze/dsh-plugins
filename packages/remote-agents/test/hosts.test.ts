import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SshBackend } from '../src/agents/backend.js';
import { TaskHistory } from '../src/agents/history.js';
import { createHandler } from '../src/http.js';
import { RemoteAgentsService } from '../src/agents/service.js';
import { Store } from '../src/core/store.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { Backend } from '../src/agents/backend.js';
import { fixture } from './fakes.js';

test('the SSH backend removes saved output for an offline host without remote execution', async t => {
  const { service: original, store, request, hostId } = await fixture(t);
  const agent = await original.create(request());
  await original.archive(agent.id);
  const history = new TaskHistory(store.directory, agent.id); await history.open();
  await history.append({ type: 'assistant_message', text: 'Saved offline output' });
  const file = join(store.directory, 'events', `${agent.id}.jsonl`);
  assert.match(await readFile(file, 'utf8'), /Saved offline output/);
  let executions = 0;
  const unavailable = () => { executions++; throw new Error('ssh: Could not resolve hostname ubuntu-claude-103'); };
  const service = new RemoteAgentsService(store, host => new SshBackend(host, store, { exec: async () => unavailable(), start: unavailable }));
  t.after(() => service.close());
  await service.discoverHost(hostId);
  assert.equal(executions, 1);
  const next = await service.removeHost(hostId, { deleteAgents: true });
  assert.deepEqual(next, { hosts: [], agents: [] });
  assert.equal(executions, 1, 'removing saved sessions does not run SSH commands');
  await assert.rejects(readFile(file), { code: 'ENOENT' });
});

test('confirmed removal clears offline host sessions and catalogs without reconnecting or affecting other hosts', async t => {
  const { service: original, remote, request, hostId, path } = await fixture(t);
  const archived = await original.create(request());
  await original.archive(archived.id);
  remote.loseCreate = true;
  await original.create(request());
  const other = (await original.addHost({ label: 'Other host', connection: 'ssh://other-host' })).hosts.at(-1)!;
  const kept = await original.create(request({ hostId: other.id }));
  const store = new Store(path); await store.open();
  let connects = 0;
  const service = new RemoteAgentsService(store, host => ({ ...remote.backend(host), connect: async () => {
    connects++; throw new Error('ssh: Could not resolve hostname ubuntu-claude-103');
  } }));
  t.after(() => service.close());
  await store.update(state => { state.mainChatProjects = [
    { id: 'removed-project', hostId, label: 'Old project', cwd: '/srv/old', providers: [] },
    { id: 'kept-project', hostId: other.id, label: 'Other project', cwd: '/srv/other', providers: [] },
  ]; });
  await service.discoverHost(hostId);
  assert.match(service.hosts()[0].modelError!, /Could not resolve hostname/);
  const handler = createHandler(service);
  const remove = (deleteAgents: unknown) => handler(new Request('http://plugin.test/api/remote-agents', {
    method: 'POST', headers: { 'content-type': 'application/json', 'X-DSH-Remote-Agents': '1' },
    body: JSON.stringify({ action: 'removeHost', hostId, deleteAgents }),
  }));
  for (const unconfirmed of [undefined, false, 'true']) assert.equal((await remove(unconfirmed)).status, 409);
  assert.equal(store.snapshot().tasks.length, 3, 'unconfirmed removal preserves every session');
  let changes = 0; service.onCatalogChange(() => { changes++; });
  const response = await remove(true);
  assert.equal(response.status, 200, await response.text());
  assert.deepEqual(store.hosts().map(h => h.id), [other.id]);
  assert.deepEqual(store.snapshot().tasks.map(a => a.id), [kept.id]);
  assert.deepEqual(store.chatProjects().map(p => p.id), ['kept-project']);
  assert.equal(remote.forgets, 2);
  assert.equal(connects, 1, 'removal never attempts another SSH connection');
  assert.equal(changes, 1, 'removal invalidates the model picker catalog');
  const reopened = new Store(path); await reopened.open();
  assert.deepEqual(reopened.snapshot(), store.snapshot());
});

test('a failed request leaves its host connected; only the connection itself marks the host', async t => {
  const provider = { id: 'codex', label: 'Codex', status: 'ready', models: [{ id: 'model', label: 'Model' }], modes: [] };
  let down: string | undefined;
  const backend = {
    connect: async () => { if (down) throw new Error(down); return 'machine-1'; },
    close: async () => {}, agent: async () => null, target: async () => provider, providers: async () => [provider], homeDirectory: async () => '/home/user',
    account: async () => { throw new Error('Could not read the plan limits'); },
    listDirectory: async () => { throw new Error('Not a readable directory'); },
  } as unknown as Backend;
  const store = new Store(join(await mkdtemp(join(tmpdir(), 'ra-host-')), 'state.json')); await store.open();
  const service = new RemoteAgentsService(store, () => backend);
  t.after(() => service.close());
  await service.addHost({ label: 'box', connection: 'ssh://user@box', enabledProviders: ['codex'] });
  const hostId = store.hosts()[0].id, host = () => service.hosts()[0];
  await service.connect(hostId);
  assert.equal(host().status, 'connected');

  const report = await service.usage('session', { target: { hostId, provider: 'codex' }, account: true });
  assert.match(report!.account!.error!, /plan limits/);
  assert.deepEqual([host().status, host().error], ['connected', undefined], 'plan limits that cannot be read say nothing about the connection');

  await assert.rejects(service.create({ id: 'request-0001', hostId, cwd: '/srv', provider: 'codex', model: 'no-such-model', prompt: 'x' }), { status: 409, message: /model is unavailable/ });
  assert.deepEqual([host().status, host().error], ['connected', undefined], 'nor does a request the host cannot serve');

  await assert.rejects(service.browse(hostId, '/missing'), /Not a readable directory/);
  assert.equal(host().status, 'connected');

  down = 'ssh: connect to host box port 22: Connection refused';
  await new Promise(resolve => setTimeout(resolve, 0));
  await assert.rejects(service.connect(hostId), /Connection refused/);
  assert.deepEqual([host().status, host().error], ['error', down], 'a connection that fails does');

  down = undefined;
  await service.connect(hostId);
  assert.deepEqual([host().status, host().error], ['connected', undefined], 'and it recovers');
});
