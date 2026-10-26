import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SshBackend } from '../src/backend.js';
import { TaskHistory } from '../src/history.js';
import { createHandler } from '../src/http.js';
import { RemoteAgentsService } from '../src/service.js';
import { Store } from '../src/store.js';
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
