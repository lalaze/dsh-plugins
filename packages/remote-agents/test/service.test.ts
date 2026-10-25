import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { Store } from '../src/store.js';
import { RemoteAgentsService } from '../src/service.js';
import { connectionInput } from '../src/backend.js';
import { createHandler } from '../src/http.js';
import { FakeRemote, fixture } from './fakes.js';

test('host configuration is durable, passwords stay out of the dashboard, and writes are private', async t => {
  const { service, store, path, hostId } = await fixture(t);
  await service.connect(hostId);
  const snapshot = service.snapshot();
  assert.equal(snapshot.hosts[0].serverId, 'remote-box-1');
  await assert.rejects(service.addHost({ label: 'Password host', connection: 'ssh://other-box', password: 'secret' }), /password storage/);
  assert.equal(JSON.stringify(snapshot).includes('private-daemon-password'), false);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const reopened = new Store(path); await reopened.open();
  assert.equal(reopened.snapshot().hosts[0].serverId, 'remote-box-1');
  await Promise.all(Array.from({ length: 8 }, (_, i) => store.update(s => { s.hosts.push({ id: randomUUID(), label: `host-${i}`, connection: `ssh://box-${i}` }); })));
  assert.equal(JSON.parse(await readFile(path, 'utf8')).hosts.length, 9);
});

test('only valid SSH targets are accepted', () => {
  assert.equal(connectionInput('100.100.100.100:2222'), 'ssh://100.100.100.100:2222');
  assert.equal(connectionInput('builder@box'), 'ssh://builder@box');
  for (const target of ['ssh://box?daemonPort=0', 'ssh://box?command=evil', 'ssh://box/shell', 'ws://user:secret@box/ws', 'ws://box/ws?password=secret', 'ssh://box\n-oProxyCommand=evil', 'file:///etc/passwd', 'https://box']) assert.throws(() => connectionInput(target));
});

test('an existing SSH machine identity cannot be replaced when reconnecting', async t => {
  const { service, remote, path, hostId } = await fixture(t);
  await service.connect(hostId); await service.close(); remote.serverId = 'different-daemon';
  const store = new Store(path); await store.open();
  const resumed = new RemoteAgentsService(store, remote.backend); t.after(() => resumed.close());
  await assert.rejects(resumed.connect(hostId), /identity changed/);
  assert.equal(remote.creates, 0);
});

test('discovery and model validation are scoped to the execution host', async t => {
  const { service, remote, hostId, request } = await fixture(t);
  const catalog = await service.providers(hostId, '/srv/project'); assert.equal(catalog[0].models[0].id, 'remote-model');
  await assert.rejects(service.create(request({ model: 'model-on-another-host' })), /unavailable on this host/);
  await assert.rejects(service.create(request({ provider: 'claude' })), /CLI is not ready/);
  await assert.rejects(service.create(request({ thinkingOptionId: 'unsupported' })), /thinking level/);
  assert.equal(remote.creates, 0);
});

test('two hosts discover independent CLI catalogs and route work to the selected machine', async t => {
  const { store, service: original } = await fixture(t); await original.close();
  const alpha = new FakeRemote(), beta = new FakeRemote();
  beta.serverId = 'remote-box-2'; beta.catalog[0].models[0].id = 'beta-model';
  const service = new RemoteAgentsService(store, host => host.connection.includes('second-box') ? beta.backend(host) : alpha.backend(host));
  t.after(() => service.close());
  const dashboard = await service.addHost({ label: 'Second server', connection: 'ssh://builder@second-box' });
  const second = dashboard.hosts.at(-1)!.id;
  assert.equal((await service.providers(second, '/srv/beta'))[0].models[0].id, 'beta-model');
  const request = { id: randomUUID(), hostId: second, cwd: '/srv/beta', provider: 'codex', model: 'beta-model', prompt: 'Work on the second machine' };
  const task = await service.create(request);
  assert.equal(task.serverId, 'remote-box-2'); assert.equal(beta.creates, 1); assert.equal(alpha.creates, 0);
  await assert.rejects(service.create({ ...request, id: randomUUID(), model: 'remote-model' }), /unavailable on this host/);
});

test('simultaneous duplicate creates and retries after a lost response execute one remote task', async t => {
  const { service, remote, request, path } = await fixture(t);
  const input = request(); remote.loseCreate = true;
  const first = await service.create(input); assert.equal(first.state, 'uncertain');
  assert.equal(remote.creates, 1);
  const store = new Store(path); await store.open();
  const resumed = new RemoteAgentsService(store, remote.backend); t.after(() => resumed.close());
  const [a, b] = await Promise.all([resumed.create(input), resumed.create(input)]);
  assert.equal(a.state, 'ready'); assert.equal(a.agentId, b.agentId); assert.equal(remote.creates, 1);
  await assert.rejects(resumed.create({ ...input, cwd: '/other/project' }), /different task/);
});

test('follow-ups have durable at-most-once submission and reconcile through message IDs', async t => {
  const { service, remote, request } = await fixture(t);
  const task = await service.create(request()), message = { id: randomUUID(), text: 'Run the test suite' };
  remote.loseSend = true;
  const uncertain = await service.send(task.id, message); assert.equal(uncertain.submissions[0].state, 'uncertain');
  await service.send(task.id, message); assert.equal(remote.sends, 1);
  const detail = await service.detail(task.id); assert.equal(detail.task.submissions[0].state, 'accepted');
  await assert.rejects(service.send(task.id, { ...message, text: 'Different instructions' }), /another message/);
  remote.agents.get(task.agentId!)!.status = 'running';
  await assert.rejects(service.send(task.id, { id: randomUUID(), text: 'Do not implicitly interrupt' }), /finish or stop/);
  assert.equal(remote.sends, 1);
});

test('permission choices retain native IDs and questions return structured answers', async t => {
  const { service, remote, request } = await fixture(t);
  const task = await service.create(request()), agent = remote.agents.get(task.agentId!)!;
  agent.pendingPermissions = [{ id: 'approval-42', name: 'Bash', kind: 'tool', actions: [{ id: 'allow-specific-command', label: 'Run once', behavior: 'allow' }] }];
  await assert.rejects(service.respond(task.id, 'approval-42', { behavior: 'allow' }), /Select one/);
  await assert.rejects(service.respond(task.id, 'approval-42', { behavior: 'allow', selectedActionId: 'wrong-id' }), /Invalid permission/);
  await service.respond(task.id, 'approval-42', { behavior: 'allow', selectedActionId: 'allow-specific-command' });
  assert.equal(remote.answers[0].answer.selectedActionId, 'allow-specific-command');
  await assert.rejects(service.respond(task.id, 'approval-42', { behavior: 'deny' }), /no longer pending/);
  agent.pendingPermissions = [{ id: 'question-43', name: 'AskUserQuestion', kind: 'question', input: { questions: [{ header: 'Framework', question: 'Which framework?', options: [{ label: 'React' }] }] } }];
  await assert.rejects(service.respond(task.id, 'question-43', { behavior: 'allow', answers: {} }), /every required/);
  await service.respond(task.id, 'question-43', { behavior: 'allow', answers: { Framework: 'React' } });
  assert.deepEqual(remote.answers[1].answer.answers, { Framework: 'React' });
});

test('stop invokes native cancellation and backend lifecycle cleanup is separate', async t => {
  const { service, remote, request } = await fixture(t);
  const task = await service.create(request()); remote.agents.get(task.agentId!)!.status = 'running';
  await service.stop(task.id); assert.equal(remote.stops, 1);
  remote.agents.get(task.agentId!)!.status = 'running';
  await service.close(); assert.equal(remote.stops, 1); assert.equal(remote.agents.get(task.agentId!)!.status, 'running');
});

test('unloading waits for in-flight creation to save its recovery state', async t => {
  const { service: original, store, remote, path, request } = await fixture(t); await original.close();
  let entered!: () => void, rejectCreate!: (error: Error) => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const service = new RemoteAgentsService(store, host => {
    const backend = remote.backend(host);
    backend.create = async () => new Promise((_resolve, reject) => { rejectCreate = reject; entered(); });
    backend.close = async () => { rejectCreate?.(new Error('Plugin unloaded during creation')); };
    return backend;
  });
  t.after(() => service.close());
  const creating = service.create(request()); await started;
  await service.close(); await creating;
  const reopened = new Store(path); await reopened.open();
  assert.equal(reopened.snapshot().tasks[0].state, 'uncertain');
});

test('a changed remote agent binding cannot receive instructions', async t => {
  const { service, remote, request } = await fixture(t);
  const task = await service.create(request()); remote.agents.get(task.agentId!)!.cwd = '/unrelated/project';
  await assert.rejects(service.send(task.id, { id: randomUUID(), text: 'Edit files' }), /identity or project changed/);
  await assert.rejects(service.stop(task.id), /identity or project changed/);
  assert.equal(remote.sends, 0); assert.equal(remote.stops, 0);
});

test('corrupt registries fail without overwriting existing data', async t => {
  const { path } = await fixture(t); await writeFile(path, '{damaged');
  const reopened = new Store(path); await assert.rejects(reopened.open());
  assert.equal(await readFile(path, 'utf8'), '{damaged');
});

test('HTTP boundary rejects malformed input, form submissions, oversized bodies and unknown actions', async t => {
  const { service } = await fixture(t), handle = createHandler(service);
  const post = (body: string, headers: Record<string, string> = { 'content-type': 'application/json', 'X-DSH-Remote-Agents': '1' }) => handle(new Request('http://dsh.test/api/remote-agents', { method: 'POST', headers, body }));
  assert.equal((await post('{')).status, 400);
  assert.equal((await post('{}', { 'content-type': 'application/x-www-form-urlencoded' })).status, 403);
  assert.equal((await post(JSON.stringify({ action: 'unknown' }))).status, 400);
  assert.equal((await post(' '.repeat(256_001))).status, 413);
  const response = await handle(new Request('http://dsh.test/api/remote-agents'));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.text()).includes('private-daemon-password'), false);
});
