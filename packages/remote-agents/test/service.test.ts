import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { Store } from '../src/store.js';
import { RemoteAgentsService } from '../src/service.js';
import { connectionInput } from '../src/backend.js';
import { createHandler } from '../src/http.js';
import { FakeRemote, fixture } from './fakes.js';

const message = (text: string) => ({ id: randomUUID(), text });

test('host configuration is durable, passwords stay out of the dashboard, and writes are private', async t => {
  const { service, store, path, hostId } = await fixture(t);
  await service.connect(hostId);
  const snapshot = await service.snapshot();
  assert.equal(snapshot.hosts[0].serverId, 'remote-box-1');
  await assert.rejects(service.addHost({ label: 'Password host', connection: 'ssh://other-box', password: 'secret' }), /password storage/);
  assert.equal(JSON.stringify(snapshot).includes('password'), false);
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
  const agent = await service.create(request);
  assert.equal(agent.status, 'idle'); assert.equal(beta.creates, 1); assert.equal(alpha.creates, 0);
  assert.equal(store.snapshot().tasks.find(t => t.id === agent.id)!.serverId, 'remote-box-2');
  await assert.rejects(service.create({ ...request, id: randomUUID(), model: 'remote-model' }), /unavailable on this host/);
});

test('simultaneous duplicate creates and retries after a lost response execute one remote agent', async t => {
  const { service, remote, request, path } = await fixture(t);
  const input = request(); remote.loseCreate = true;
  const first = await service.create(input);
  assert.equal(first.status, 'error'); assert.match(first.error!, /Connection lost/);
  assert.equal(remote.creates, 1);
  const store = new Store(path); await store.open();
  const resumed = new RemoteAgentsService(store, remote.backend); t.after(() => resumed.close());
  const [a, b] = await Promise.all([resumed.create(input), resumed.create(input)]);
  assert.equal(a.status, 'idle'); assert.equal(b.status, 'idle'); assert.equal(remote.creates, 1);
  assert.equal(store.snapshot().tasks[0].agentId, `native-${input.id}`);
  await assert.rejects(resumed.create({ ...input, cwd: '/other/project' }), /different agent/);
});

test('creation saves titles, discovered modes and the delegation origin', async t => {
  const { service, store, request } = await fixture(t);
  const panel = await service.create(request({ prompt: 'Fix   the\nflaky  checkout test' }));
  assert.equal(panel.title, 'Fix the flaky checkout test'); assert.equal(panel.delegated, false);
  assert.deepEqual(panel.modes.map(m => m.id), ['inherit', 'ask', 'full-access']);
  const delegated = await service.create(request(), { title: 'Checkout tests', origin: 'dsh' });
  assert.equal(delegated.title, 'Checkout tests'); assert.equal(delegated.delegated, true);
  assert.equal(store.snapshot().tasks[1].origin, 'dsh');
});

test('sending to a working agent interrupts its turn, like Paseo; delegated sends can refuse instead', async t => {
  const { service, remote, request } = await fixture(t);
  const agent = await service.create(request()), live = remote.live(agent.id);
  live.status = 'running'; live.activeTurn = { turnId: 'turn-1', startedAt: null };
  assert.equal((await service.summary(agent.id)).status, 'running');
  await assert.rejects(service.send(agent.id, message('Only when idle'), { interrupt: false }), /still working/);
  assert.equal(remote.sends, 0);
  const instructions = message('Change of plan: run the linter first');
  await service.send(agent.id, instructions);
  assert.equal(remote.interrupts, 1); assert.equal(remote.sends, 1);
  const detail = await service.detail(agent.id);
  assert.deepEqual(detail.timeline!.entries.slice(-3).map(e => e.item.type), ['interrupted', 'user_message', 'assistant_message']);
  await service.send(agent.id, instructions);
  assert.equal(remote.sends, 1, 'a repeated message ID is never delivered twice');
  assert.equal(await service.reply(agent.id), 'Follow-up completed.');
});

test('dashboard statuses reflect live sessions: attention, running, idle and failed starts', async t => {
  const { service, remote, request } = await fixture(t);
  const waiting = await service.create(request()), working = await service.create(request()), idle = await service.create(request());
  remote.live(waiting.id).pendingPermissions = [{ id: 'approval-1', name: 'Bash', kind: 'tool' }];
  remote.live(working.id).status = 'running';
  remote.loseCreate = true; const failed = await service.create(request());
  const statuses = Object.fromEntries((await service.snapshot()).agents.map(a => [a.id, [a.status, a.pendingPermissions]]));
  assert.deepEqual(statuses[waiting.id], ['attention', 1]);
  assert.deepEqual(statuses[working.id], ['running', 0]);
  assert.deepEqual(statuses[idle.id], ['idle', 0]);
  assert.equal(statuses[failed.id][0], 'error');
  assert.equal((await service.state(waiting.id)).permissions[0].id, 'approval-1');
});

test('archive releases the CLI and hides the agent; messaging restores it; delete removes it and its output', async t => {
  const { service, remote, request, store, hostId } = await fixture(t);
  const agent = await service.create(request());
  remote.live(agent.id).status = 'running';
  const archived = await service.archive(agent.id);
  assert.equal(archived.archived, true); assert.equal(remote.detaches, 1);
  assert.equal(archived.status, 'idle', 'a resumable archived agent can continue later');
  const restored = await service.send(agent.id, message('Pick this back up'));
  assert.equal(restored.archived, false);
  await assert.rejects(service.removeHost(hostId), /Delete this host’s agents/);
  await service.delete(agent.id);
  assert.equal(remote.forgets, 1); assert.equal(store.snapshot().tasks.length, 0);
  await assert.rejects(service.detail(agent.id), /not found/);
  assert.equal((await service.removeHost(hostId)).hosts.length, 0);
});

test('history archiving rechecks live state, keeps output, and restores after a server restart', async t => {
  const { service, remote, request, path } = await fixture(t);
  const agent = await service.create(request());
  remote.append(remote.live(agent.id).id, { type: 'assistant_message', text: 'Keep this result' });
  const live = remote.live(agent.id);
  live.status = 'running';
  await assert.rejects(service.archive(agent.id, true, { onlyIdle: true }), /Refresh before archiving/);
  live.status = 'error';
  await assert.rejects(service.archive(agent.id, true, { onlyIdle: true }), /Refresh before archiving/);
  live.status = 'idle';
  live.pendingPermissions = [{ id: 'approval', name: 'Bash', kind: 'tool' }];
  await assert.rejects(service.archive(agent.id, true, { onlyIdle: true }), /Refresh before archiving/);
  assert.equal(remote.detaches, 0);
  assert.equal((await service.summary(agent.id)).archived, false);
  live.pendingPermissions = [];
  await service.archive(agent.id, true, { onlyIdle: true });
  await service.close();
  const store = new Store(path); await store.open();
  const resumed = new RemoteAgentsService(store, remote.backend); t.after(() => resumed.close());
  assert.equal((await resumed.summary(agent.id)).archived, true);
  const detail = await resumed.detail(agent.id);
  assert.ok(detail.timeline?.entries.some(e => e.item.text === 'Keep this result'));
  assert.equal((await resumed.archive(agent.id, false)).archived, false);
  assert.equal(remote.forgets, 0);
});

test('mode changes use discovered modes, wait for idle, and apply by resuming the session', async t => {
  const { service, remote, request, store } = await fixture(t);
  const agent = await service.create(request());
  await assert.rejects(service.setMode(agent.id, 'yolo'), /not available/);
  remote.live(agent.id).status = 'running';
  await assert.rejects(service.setMode(agent.id, 'full-access'), /Stop the agent/);
  await service.stop(agent.id); assert.equal(remote.stops, 1);
  const changed = await service.setMode(agent.id, 'full-access');
  assert.equal(changed.modeId, 'full-access'); assert.equal(remote.detaches, 1);
  assert.equal(store.snapshot().tasks[0].modeId, 'full-access');
  await service.stop(agent.id); assert.equal(remote.stops, 1, 'stopping an idle agent is a no-op');
});

test('permission choices retain native IDs and questions return structured answers', async t => {
  const { service, remote, request } = await fixture(t);
  const created = await service.create(request()), agent = remote.live(created.id);
  agent.pendingPermissions = [{ id: 'approval-42', name: 'Bash', kind: 'tool', actions: [{ id: 'allow-specific-command', label: 'Run once', behavior: 'allow' }] }];
  await assert.rejects(service.respond(created.id, 'approval-42', { behavior: 'allow' }), /Select one/);
  await assert.rejects(service.respond(created.id, 'approval-42', { behavior: 'allow', selectedActionId: 'wrong-id' }), /Invalid permission/);
  await service.respond(created.id, 'approval-42', { behavior: 'allow', selectedActionId: 'allow-specific-command' });
  assert.equal(remote.answers[0].answer.selectedActionId, 'allow-specific-command');
  await assert.rejects(service.respond(created.id, 'approval-42', { behavior: 'deny' }), /no longer pending/);
  agent.pendingPermissions = [{ id: 'question-43', name: 'AskUserQuestion', kind: 'question', input: { questions: [{ header: 'Framework', question: 'Which framework?', options: [{ label: 'React' }] }] } }];
  await assert.rejects(service.respond(created.id, 'question-43', { behavior: 'allow', answers: {} }), /every required/);
  await service.respond(created.id, 'question-43', { behavior: 'allow', answers: { Framework: 'React' } });
  assert.deepEqual(remote.answers[1].answer.answers, { Framework: 'React' });
});

test('unloading the plugin leaves remote work running rather than stopping it', async t => {
  const { service, remote, request } = await fixture(t);
  const agent = await service.create(request()); remote.live(agent.id).status = 'running';
  await service.close(); assert.equal(remote.stops, 0); assert.equal(remote.live(agent.id).status, 'running');
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

test('a creation record without an in-flight request is reported as interrupted', async t => {
  const { service, store, request } = await fixture(t);
  const agent = await service.create(request());
  await store.update(state => { const task = state.tasks[0]; task.state = 'creating'; delete task.agentId; });
  const summary = await service.summary(agent.id);
  assert.equal(summary.status, 'error'); assert.match(summary.error!, /interrupted/);
});

test('a changed remote agent binding cannot receive instructions', async t => {
  const { service, remote, request } = await fixture(t);
  const agent = await service.create(request()); remote.live(agent.id).cwd = '/unrelated/project';
  await assert.rejects(service.send(agent.id, message('Edit files')), /identity or project changed/);
  await assert.rejects(service.stop(agent.id), /identity or project changed/);
  assert.equal(remote.sends, 0); assert.equal(remote.stops, 0);
});

test('registries from earlier builds load, and the next write drops main-chat bindings', async t => {
  const { path, store: original, service, request } = await fixture(t);
  await service.create(request()); await service.close(); await original.flush();
  const legacy = JSON.parse(await readFile(path, 'utf8'));
  legacy.chatProjects = [{ id: randomUUID(), hostId: legacy.hosts[0].id, cwd: '/srv/project', providers: [] }];
  legacy.tasks[0].submissions = [{ id: randomUUID(), text: 'old', state: 'accepted' }];
  await writeFile(path, JSON.stringify(legacy));
  const store = new Store(path); await store.open();
  assert.equal(store.snapshot().tasks.length, 1);
  await store.update(() => {});
  assert.equal('chatProjects' in JSON.parse(await readFile(path, 'utf8')), false);
});

test('corrupt registries fail without overwriting existing data', async t => {
  const { path } = await fixture(t); await writeFile(path, '{damaged');
  const reopened = new Store(path); await assert.rejects(reopened.open());
  assert.equal(await readFile(path, 'utf8'), '{damaged');
});

test('HTTP boundary rejects malformed input, form submissions, oversized bodies and unknown actions', async t => {
  const { service, request } = await fixture(t), handle = createHandler(service);
  const post = (body: string, headers: Record<string, string> = { 'content-type': 'application/json', 'X-DSH-Remote-Agents': '1' }) => handle(new Request('http://dsh.test/api/remote-agents', { method: 'POST', headers, body }));
  assert.equal((await post('{')).status, 400);
  assert.equal((await post('{}', { 'content-type': 'application/x-www-form-urlencoded' })).status, 403);
  assert.equal((await post(JSON.stringify({ action: 'unknown' }))).status, 400);
  const created = await (await post(JSON.stringify({ action: 'create', agent: request() }))).json();
  assert.equal(created.status, 'idle');
  assert.equal((await post(JSON.stringify({ action: 'agent', agentId: created.id }))).status, 200);
  // Bodies may be up to 2,000,000 bytes, counted in bytes rather than characters.
  const sized = (bytes: number) => { const json = JSON.stringify({ action: 'agent', agentId: created.id }); return json + ' '.repeat(bytes - json.length); };
  assert.equal((await post(sized(2_000_000))).status, 200);
  assert.equal((await post(sized(2_000_001))).status, 413);
  assert.equal((await post(JSON.stringify({ action: 'agent', agentId: created.id, note: 'é'.repeat(1_000_000) }))).status, 413);
  // A declared length over the limit is refused before the body is read.
  assert.equal((await post('{}', { 'content-type': 'application/json', 'X-DSH-Remote-Agents': '1', 'content-length': '2000001' })).status, 413);
  assert.equal((await post(JSON.stringify({ action: 'agent', agentId: randomUUID() }))).status, 404);
  const response = await handle(new Request('http://dsh.test/api/remote-agents'));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).agents[0].id, created.id);
});

test('a store refuses to overwrite state written by another DSH instance, and refuses writes once closed', async t => {
  const { path, store: stale, service } = await fixture(t);
  const current = new Store(path); await current.open();
  await current.update(state => { state.hosts.push({ id: randomUUID(), label: 'Added after reload', connection: 'ssh://second-host' }); });
  await assert.rejects(stale.update(state => { state.tasks = []; }), /changed by another DSH instance/);
  const reopened = new Store(path); await reopened.open();
  assert.equal(reopened.hosts().length, 2, 'the newer state is kept');
  await current.close();
  await assert.rejects(current.update(() => {}), /closed/);
  await service.close();
});
