import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, { createUserMessage, createAssistantMessage, createSystemMessage, MessageId, ReasoningEffortId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import { ChatProjects } from '../src/chat-projects.js';
import { CHAT_PROVIDER, CHAT_PROVIDERS, chatProviderId, chatModelId, RemoteCliAdapter, type ChatHost } from '../src/native-chat.js';
import { Store } from '../src/store.js';
import { RemoteAgentsService } from '../src/service.js';
import { TaskHistory } from '../src/history.js';
import { createHandler } from '../src/http.js';
import { fixture } from './fakes.js';
import { fastTierOf, RELAY_UNAVAILABLE, type DshPermission } from '../src/domain.js';

const CODEX_PROVIDER = chatProviderId('codex');
const user = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });
const collect = async (stream: AsyncIterable<StreamChunk>) => { const chunks: StreamChunk[] = []; for await (const chunk of stream) chunks.push(chunk); return chunks; };
const text = (chunks: StreamChunk[]) => chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('');
async function setup(t: TestContext, overrides: Partial<ChatHost> = {}) {
  const base = await fixture(t), projects = new ChatProjects(base.service);
  await base.service.discoverHost(base.hostId); const [project] = projects.hosts();
  const host: ChatHost = { agent: () => ({ id: 'dsh-agent' }), step: () => undefined, cwd: () => '/srv/project',
    workspace: async cwd => ({ hostIds: base.store.hosts().map(h => h.id), cwd }),
    approval: { request: async () => 'allowed-once' }, userQuestions: { ask: async () => ({ answers: [] }) }, ...overrides };
  const adapter = new RemoteCliAdapter(projects, host, 5); t.after(() => adapter.close());
  const options = (prompt = 'Fix the tests', extra: Partial<GenerateOptions> = {}): GenerateOptions => ({ provider: CODEX_PROVIDER,
    model: chatModelId(project.id, 'codex', 'remote-model'), sessionId: SessionId('dsh-conversation'), messages: [user(prompt)], ...extra });
  return { ...base, projects, project, adapter, options };
}

test('machine catalogs persist and advertise models without project registration or opening SSH in the picker', async t => {
  const { adapter, projects, project, remote, path, hostId, service } = await setup(t);
  let changes = 0; projects.onChange(() => changes++);
  const [model] = await adapter.listModels(CODEX_PROVIDER);
  assert.equal(model.provider, CODEX_PROVIDER); assert.equal(model.name, 'Remote model · Build server');
  assert.equal(model.description, 'Build server · Codex'); assert.deepEqual(model.inputModalities, ['text', 'image']);
  const reopened = new Store(path); await reopened.open(); assert.deepEqual(reopened.chatProjects(), []);
  assert.deepEqual(reopened.hosts()[0].catalog?.providers, project.providers);
  const probes = remote.discoveries;
  await adapter.listModels(CODEX_PROVIDER); await adapter.listModels(CODEX_PROVIDER);
  assert.equal(remote.discoveries, probes, 'opening the picker reads saved models without probing SSH');
  assert.deepEqual((await adapter.resolveModel(CODEX_PROVIDER, model.id)).reasoning?.efforts.map(e => e.id), ['high']);
  remote.catalog[0].models[0].id = 'new/model'; await projects.refresh(project.id);
  const [changed] = await adapter.listModels(CODEX_PROVIDER); assert.match(changed.id, /new%2Fmodel$/);
  await service.removeHost(hostId); assert.deepEqual(await adapter.listModels(CODEX_PROVIDER), []); assert.equal(changes, 2);
  await assert.rejects(adapter.resolveModel(CODEX_PROVIDER, changed.id), /unavailable/);
  assert.equal(remote.creates, 0);
});

test('the native picker receives separate CLI provider groups and filters models to their owning CLI', async t => {
  const { adapter, projects, project, service, remote, hostId, options } = await setup(t);
  remote.catalog[1] = { id: 'claude', label: 'Claude Code', status: 'ready', models: [{ id: 'claude-model', label: 'Claude model' }], modes: [] };
  await projects.refresh(project.id);
  assert.equal(adapter.providerInfo(chatProviderId('claude')).name, 'Claude');
  assert.equal(adapter.providerInfo(CODEX_PROVIDER).name, 'Codex');
  assert.equal(adapter.providerInfo(chatProviderId('dsh')).name, 'DeepSeek Harness');
  assert.equal((await adapter.listModels(chatProviderId('claude')))[0].name, 'Claude model · Build server');
  assert.equal((await adapter.listModels(CODEX_PROVIDER))[0].name, 'Remote model · Build server');
  assert.deepEqual(await adapter.listModels(CHAT_PROVIDER), [], 'the old aggregate route adds no picker row');
  await assert.rejects(adapter.resolveModel(chatProviderId('claude'), options().model), /unavailable/);
  await assert.rejects(collect(adapter.stream(options('Wrong CLI', { provider: chatProviderId('claude') }))), /unavailable/);
  const first = options(); await collect(adapter.stream(first));
  await collect(adapter.stream({ ...first, provider: CHAT_PROVIDER }));
  assert.equal(remote.creates, 1, 'existing 0.2.1 routes reuse the same session and message receipt');
  await projects.add({ hostId, cwd: '/srv/other', label: 'Other project' });
  assert.equal((await adapter.listModels(CODEX_PROVIDER)).length, 1, 'legacy projects do not duplicate machine models');
  const secondHost = (await service.addHost({ label: 'Second machine', connection: 'ssh://second' }, { discoverModels: true })).hosts.at(-1)!;
  const models = await adapter.listModels(CODEX_PROVIDER);
  assert.equal(models.length, 2); assert.match(models[0].name, /Build server/); assert.match(models[1].name, /Second machine/);
  assert.ok(models[1].id.startsWith(secondHost.id + '/'));
  assert.equal(new Set(models.map(m => m.id)).size, 2);
  assert.equal(service.store.snapshot().tasks.length, 1);
});

test('the real DSH LLM registry lists, resolves and dispatches the remote adapter', async t => {
  const { adapter, options, remote } = await setup(t);
  const ctx = new Context(); const runtime = ctx.plugin(LlmRuntime); await runtime.await(); t.after(() => runtime.dispose());
  const unregister = ctx.llm.registerAdapter(CHAT_PROVIDERS, adapter); t.after(unregister);
  assert.equal(ctx.llm.listProviders().find(p => p.id === CODEX_PROVIDER)?.name, 'Codex');
  assert.equal((await ctx.llm.listModels(CODEX_PROVIDER)).length, 1);
  const input = options(); remote.onCreate = agent => remote.append(agent.id, { type: 'assistant_message', text: 'Native response' });
  const prepared = await ctx.llm.prepareCall({ provider: input.provider, model: input.model });
  assert.equal(text(await collect(prepared.stream(input))), 'Native response');
  assert.equal(remote.creates, 1);
});

test('the Cordis plugin mounts its native model route with standard DSH services and disposes cleanly', async t => {
  const { directory } = await setup(t);
  const plugin = await import('../src/index.js');
  const ctx = new Context(), llm = ctx.plugin(LlmRuntime); await llm.await();
  t.after(() => llm.dispose());
  const disposers = [ctx.provide('connection', { fetch: { register: () => () => {} } }), ctx.provide('sessions', {}),
    ctx.provide('agents', { get: () => undefined }), ctx.provide('approval', { request: async () => 'allowed-once' }),
    ctx.provide('userQuestions', { ask: async () => ({ answers: [] }) })];
  t.after(async () => { for (const dispose of disposers.reverse()) await dispose(); });
  const mounted = ctx.plugin(plugin, { stateDir: directory }); await mounted.await();
  for (let i = 0; i < 100 && !ctx.llm.listProviders().some(p => p.id === CODEX_PROVIDER); i++) await pause(2);
  assert.equal((await ctx.llm.listModels(CODEX_PROVIDER)).length, 1);
  await mounted.dispose(); assert.equal(ctx.llm.listProviders().some(p => p.id === CODEX_PROVIDER), false);
});

test('streaming, retry and follow-ups reuse the bound CLI without repeating a prompt or old output', async t => {
  const { adapter, options, remote, store } = await setup(t);
  remote.onCreate = agent => {
    remote.append(agent.id, { type: 'reasoning', text: 'Thinking' });
    remote.append(agent.id, { type: 'assistant_message', text: 'First ' });
    remote.append(agent.id, { type: 'assistant_message', text: 'reply' });
  };
  const first = options(), chunks = await collect(adapter.stream(first));
  assert.equal(text(chunks), 'First reply'); assert.equal(chunks.filter(c => c.type === 'block-start').length, 2);
  assert.equal(chunks.at(-1)?.type, 'finish');
  assert.equal(text(await collect(adapter.stream(first))), 'First reply'); assert.equal(remote.creates, 1); assert.equal(remote.sends, 0);
  const follow = options('Now run the linter');
  assert.equal(text(await collect(adapter.stream(follow))), 'Follow-up completed.'); assert.equal(remote.creates, 1); assert.equal(remote.sends, 1);
  assert.equal(text(await collect(adapter.stream(follow))), 'Follow-up completed.'); assert.equal(remote.sends, 1);
  assert.equal(text(await collect(adapter.stream(first))), 'First reply', 'replaying an older receipt never includes later replies');
  assert.equal(store.snapshot().tasks[0].chat?.sessionId, first.sessionId);
});

test('remote workspace images in replies are copied to the DSH host so the chat can show them', async t => {
  const requested: string[] = [];
  const { adapter, options, remote, store } = await setup(t, { image: async (_id, path) => { requested.push(path); return Buffer.from('image bytes'); } });
  remote.onCreate = agent => {
    remote.append(agent.id, { type: 'assistant_message', text: 'See ![Before](shots/' });
    remote.append(agent.id, { type: 'assistant_message', text: 'before.png) and ![Site](https://example.com/a.png)' });
    remote.append(agent.id, { type: 'reasoning', text: 'Done' });
    remote.append(agent.id, { type: 'assistant_message', text: ' ![unfinished' });
  };
  const reply = text(await collect(adapter.stream(options())));
  const local = /!\[Before\]\(<([^>]+)>\)/.exec(reply)?.[1];
  assert.ok(local?.startsWith(`${store.directory.replace(/\\/g, '/')}/chat-images/`), reply);
  assert.equal(reply, `See ![Before](<${local}>) and ![Site](https://example.com/a.png) ![unfinished`);
  assert.deepEqual(requested, ['shots/before.png']);
});

test('turn token usage is not reported to DSH, whose usage chunks describe the conversation context', async t => {
  const { adapter, options, remote } = await setup(t);
  remote.onCreate = agent => {
    remote.append(agent.id, { type: 'assistant_message', text: 'Done' });
    remote.append(agent.id, { type: 'usage', usage: { inputTokens: 5, outputTokens: 40, cacheReadTokens: 900_000 } });
  };
  const chunks = await collect(adapter.stream(options()));
  assert.equal(text(chunks), 'Done'); assert.equal(chunks.some(c => c.type === 'usage'), false);
});

test('native bindings survive restart and a lost follow-up receipt', async t => {
  const { adapter, options, remote, path, service } = await setup(t);
  const first = options(); await collect(adapter.stream(first));
  const follow = options('Continue'); remote.loseSend = true;
  await assert.rejects(collect(adapter.stream(follow)), /receipt lost/);
  await service.close(); const store = new Store(path); await store.open();
  const next = new RemoteAgentsService(store, remote.backend); t.after(() => next.close());
  const resumed = new RemoteCliAdapter(new ChatProjects(next), { agent: () => undefined, step: () => undefined,
    cwd: () => '/srv/project', workspace: async cwd => ({ hostIds: store.hosts().map(h => h.id), cwd }) }, 5);
  assert.equal(text(await collect(resumed.stream(follow))), 'Follow-up completed.');
  assert.equal(remote.creates, 1); assert.equal(remote.sends, 1);
});

test('the same machine model works from different DSH workspace paths without registering projects', async t => {
  let cwd = '/srv/project';
  const { adapter, options, remote, store } = await setup(t, { cwd: () => cwd });
  const first = options(); await collect(adapter.stream(first));
  await collect(adapter.stream(options('Same project, another chat', { sessionId: SessionId('other-chat') })));
  cwd = '/srv/other-project';
  await collect(adapter.stream(options('Other project', { sessionId: SessionId('third-chat') })));
  assert.equal(remote.creates, 3); assert.equal(new Set(store.snapshot().tasks.map(t => t.chat?.sessionId + ':' + t.cwd)).size, 3);
  assert.equal(store.snapshot().tasks.at(-1)?.cwd, cwd); assert.equal(store.chatProjects().length, 0);
});

test('the shared catalog remains intact without a workspace, but execution requires workspace admission', async t => {
  const { adapter, options, remote } = await setup(t, { cwd: () => undefined });
  assert.equal((await adapter.listModels(CODEX_PROVIDER)).length, 1);
  await assert.rejects(collect(adapter.stream(options())), /Choose a DSH workspace/);
  assert.equal(remote.creates, 0);
});

test('a model from another workspace machine is rejected before remote execution', async t => {
  const { adapter, options, remote } = await setup(t, { workspace: async () => ({ hostIds: ['another-machine'], cwd: '/srv/project' }) });
  await assert.rejects(collect(adapter.stream(options())), /does not belong/);
  assert.equal(remote.creates, 0);
});

test('switching workspaces revokes a previously bound remote conversation', async t => {
  let allowed = true;
  const base = await setup(t, { workspace: async () => ({ hostIds: allowed ? [base.hostId] : [], cwd: '/srv/project' }) });
  const first = base.options();
  await collect(base.adapter.stream(first));
  allowed = false;
  await assert.rejects(collect(base.adapter.stream({ ...first, messages: [...first.messages, user('Continue')] })), /does not belong/);
  assert.equal(base.remote.sends, 0);
});

test('main chat executes at the verified remote directory, never at its local placeholder', async t => {
  const base = await setup(t, { cwd: () => '/local/placeholder', workspace: async () => ({ hostIds: [base.hostId], cwd: '/srv/real-project' }) });
  await collect(base.adapter.stream(base.options()));
  assert.equal(base.remote.created?.cwd, '/srv/real-project');
});

test('a workspace change while server verification is pending cannot start a remote CLI', async t => {
  let cwd = '/workspace-one';
  const base = await setup(t, { cwd: () => cwd, workspace: async () => { cwd = '/workspace-two'; return { hostIds: [base.hostId], cwd: '/srv/project' }; } });
  await assert.rejects(collect(base.adapter.stream(base.options())), /workspace changed/);
  assert.equal(base.remote.creates, 0);
});

test('adding only a machine through HTTP discovers its models and preserves them across an offline refresh', async t => {
  const { service, store, remote } = await fixture(t), projects = new ChatProjects(service), handle = createHandler(service, projects);
  const post = (body: unknown) => handle(new Request('http://dsh.test/api/remote-agents', { method: 'POST', headers: { 'content-type': 'application/json', 'X-DSH-Remote-Agents': '1' }, body: JSON.stringify(body) }));
  const added = await post({ action: 'addHost', host: { label: 'Machine only', connection: 'ssh://machine-only' } });
  assert.equal(added.status, 200);
  const host = (await added.json()).hosts.find((h: { label: string }) => h.label === 'Machine only');
  assert.equal(host.modelCount, 1); assert.equal(host.modelError, undefined);
  const routes = await (await post({ action: 'hostCatalogs' })).json();
  assert.equal(routes[0].id, host.id); assert.equal(routes[0].cwd, '/home/builder');
  assert.equal(store.chatProjects().length, 0); assert.equal(remote.creates, 0);
  remote.homeError = 'Host is offline';
  const offline = await (await post({ action: 'discoverHost', hostId: host.id })).json();
  const cached = offline.hosts.find((h: { id: string }) => h.id === host.id);
  assert.equal(cached.modelCount, 1); assert.equal(cached.modelError, 'Host is offline');
  assert.equal(projects.hosts()[0].providers[0].models[0].id, 'remote-model');
});

test('an unsuccessful first discovery keeps the machine saved and a later refresh can populate the picker', async t => {
  const { service, remote, store } = await fixture(t);
  remote.homeError = 'SSH unavailable';
  const result = await service.addHost({ label: 'Offline machine', connection: 'offline-host' }, { discoverModels: true });
  const host = result.hosts.at(-1)!;
  assert.equal(host.modelError, 'SSH unavailable'); assert.equal(host.modelCount, undefined);
  remote.homeError = undefined; await service.discoverHost(host.id);
  assert.equal(service.hosts().find(h => h.id === host.id)?.modelCount, 1);
  assert.equal(store.chatProjects().length, 0);
});

test('saved project routes remain usable but are hidden from the machine model menu', async t => {
  let cwd = '/different/workspace';
  const { adapter, options, projects, hostId, remote } = await setup(t, { cwd: () => cwd });
  const [legacy] = await projects.add({ hostId, label: 'Old project', cwd: '/srv/legacy' });
  const model = chatModelId(legacy.id, 'codex', 'remote-model');
  assert.ok(!(await adapter.listModels(CODEX_PROVIDER)).some(m => m.id === model));
  await assert.rejects(collect(adapter.stream(options('Wrong workspace', { model }))), /different workspace directory/);
  assert.equal(remote.creates, 0);
  cwd = '/srv/legacy';
  await collect(adapter.stream(options('Continue old chat', { model })));
  assert.equal(remote.created?.cwd, '/srv/legacy');
});

test('initial context contains conversation text but excludes DSH system, injected context and tool declarations', async t => {
  const { adapter, options, remote } = await setup(t);
  const injected = { ...user('LOCAL WORKSPACE INSTRUCTIONS'), source: { kind: 'system-prompt' as const } };
  const input = options('Implement the change', { messages: [createSystemMessage('LOCAL SYSTEM'), user('Earlier human request'),
    createAssistantMessage({ source: { provider: 'deepseek', model: 'chat' }, content: [{ type: 'text', text: 'Earlier reply' }] }), injected, user('Implement the change'), injected],
    tools: [{ name: 'local_shell', description: 'LOCAL TOOL', parameters: {} }] });
  await collect(adapter.stream(input));
  assert.match(remote.created!.prompt, /Earlier human request/); assert.match(remote.created!.prompt, /Earlier reply/);
  assert.match(remote.created!.prompt, /Current user request:\nImplement the change$/);
  assert.doesNotMatch(remote.created!.prompt, /LOCAL/);
});

test('DSH Stop cancels remote work and releases the conversation for a later follow-up', async t => {
  const { adapter, options, remote } = await setup(t);
  remote.onCreate = agent => { agent.status = 'running'; remote.append(agent.id, { type: 'assistant_message', text: 'Working' }); };
  const controller = new AbortController(), input = options('Work', { signal: controller.signal }), iterator = adapter.stream(input);
  assert.equal((await iterator.next()).value?.type, 'block-start'); controller.abort();
  await assert.rejects(collect(iterator), /abort/i); assert.equal(remote.stops, 1);
  await collect(adapter.stream(options('Continue safely'))); assert.equal(remote.sends, 1);
});

test('closing a stream early stops remote work; disposing the adapter or DSH shutdown leaves it running', async t => {
  const { adapter, options, remote } = await setup(t);
  remote.onCreate = agent => { agent.status = 'running'; remote.append(agent.id, { type: 'assistant_message', text: 'Working' }); };
  const iterator = adapter.stream(options()); await iterator.next(); await iterator.return(undefined); assert.equal(remote.stops, 1);
  const shutdown = new AbortController();
  const disposed = adapter.stream(options('Shut down', { sessionId: SessionId('disposed'), signal: shutdown.signal })); await disposed.next();
  shutdown.abort({ kind: 'disposed' });
  await assert.rejects(collect(disposed)); assert.equal(remote.stops, 1, 'a DSH disposal cause is not a user Stop');
  const running = adapter.stream(options('Another conversation', { sessionId: SessionId('second') })); await running.next(); adapter.close();
  const released = await collect(running); assert.equal(remote.stops, 1, 'plugin unload releases the stream only');
  assert.deepEqual(released.at(-1), { type: 'finish', reason: { kind: 'stop' } }, 'a released turn is not a failure');
  assert.match(text(released), /^Working\n\nDSH disconnected while the remote CLI was still working/);
  assert.equal([...remote.agents.values()].filter(a => a.status === 'running').length, 2);
});

test('permissions and questions use native DSH services and select only a one-time CLI action', async t => {
  let approvals = 0, questions = 0;
  const { adapter, options, remote } = await setup(t, {
    approval: { request: async () => { approvals++; return 'allowed-once'; } },
    userQuestions: { ask: async () => { questions++; return { answers: [{ id: 'Checks', selected: ['Tests'], custom: 'and lint' }] }; } },
  });
  remote.onCreate = agent => {
    agent.status = 'running'; agent.pendingPermissions = [{ id: 'permission', kind: 'tool', name: 'Bash', actions: [
      { id: 'project-rule', label: 'Save rule', behavior: 'allow', scope: 'project' },
      { id: 'acceptForSession', label: 'Always allow', behavior: 'allow' }, { id: 'once', label: 'Allow once', behavior: 'allow', scope: 'once' }] }];
    void (async () => {
      while (!remote.answers.length) await pause(5);
      agent.pendingPermissions = [{ id: 'question', kind: 'question', name: 'Question', input: { questions: [{ header: 'Checks', question: 'Which checks?', options: [{ label: 'Tests' }], allowOther: true }] } }];
      while (remote.answers.length < 2) await pause(5);
      remote.append(agent.id, { type: 'assistant_message', text: 'Done' }); agent.status = 'idle';
    })();
  };
  assert.equal(text(await collect(adapter.stream(options()))), 'Done'); assert.equal(approvals, 1); assert.equal(questions, 1);
  assert.equal(remote.answers[0].answer.selectedActionId, 'once'); assert.deepEqual(remote.answers[1].answer.answers, { Checks: 'Tests, and lint' });
});

for (const mode of ['acceptEdits', 'auto']) test(`new Claude chats inherit remote permissions even with an old cached default, and follow-ups preserve ${mode}`, async t => {
  const { remote, projects, project, adapter, options, service, store } = await setup(t);
  remote.catalog[1] = { id: 'claude', label: 'Claude Code', status: 'ready', defaultModeId: 'default',
    models: [{ id: 'claude-model', label: 'Claude model' }], modes: [{ id: 'default', label: 'Ask before tools' }, { id: 'acceptEdits', label: 'Accept edits' }] };
  await projects.refresh(project.id);
  const input = options('Use remote permissions', { provider: chatProviderId('claude'), model: chatModelId(project.id, 'claude', 'claude-model') });
  await collect(adapter.stream(input));
  assert.equal(remote.created!.modeId, undefined);
  const task = store.snapshot().tasks[0];
  await service.setMode(task.id, mode);
  await collect(adapter.stream({ ...input, messages: [...input.messages, user('Continue editing')] }));
  assert.equal(store.snapshot().tasks[0].modeId, mode);
  assert.equal(remote.creates, 1); assert.equal(remote.sends, 1);
});

test('Claude chats follow the DSH composer permission over a mode chosen in Open sessions', async t => {
  let permission: DshPermission | undefined = 'workspace-write';
  const { remote, projects, project, adapter, options, service, store } = await setup(t, { permission: () => permission });
  remote.catalog[1] = { id: 'claude', label: 'Claude Code', status: 'ready', models: [{ id: 'claude-model', label: 'Claude model' }],
    modes: [{ id: 'default', label: 'Ask before tools' }, { id: 'acceptEdits', label: 'Accept edits' }, { id: 'bypassPermissions', label: 'Full access' }] };
  await projects.refresh(project.id);
  const input = options('Follow the composer', { provider: chatProviderId('claude'), model: chatModelId(project.id, 'claude', 'claude-model') });
  await collect(adapter.stream(input));
  assert.equal(remote.created!.modeId, 'acceptEdits');
  const task = store.snapshot().tasks[0];
  await service.setMode(task.id, 'default'); permission = 'danger-full-access';
  const second = { ...input, messages: [...input.messages, user('Continue with full access')] };
  await collect(adapter.stream(second));
  assert.equal(store.snapshot().tasks[0].modeId, 'bypassPermissions');
  permission = 'auto';
  await collect(adapter.stream({ ...second, messages: [...second.messages, user('Continue with Auto review')] }));
  assert.equal(store.snapshot().tasks[0].modeId, 'auto');
  permission = undefined;
  await collect(adapter.stream({ ...second, messages: [...second.messages, user('Continue with a custom permission')] }));
  assert.equal(store.snapshot().tasks[0].modeId, 'auto', 'a custom DSH permission keeps the saved mode');
  assert.equal(remote.creates, 1); assert.equal(remote.sends, 3);
});

test('Codex chats map the DSH composer permission and skip modes their catalog lacks', async t => {
  const { remote, projects, project, adapter, options } = await setup(t, { permission: () => 'read-only' });
  await collect(adapter.stream(options('Not in the catalog')));
  assert.equal(remote.created!.modeId, 'inherit');
  remote.catalog[0].modes.push({ id: 'read-only', label: 'Read only' }); await projects.refresh(project.id);
  await collect(adapter.stream(options('Read only', { sessionId: SessionId('read-only-conversation') })));
  assert.equal(remote.created!.modeId, 'read-only');
});

test('DSH Auto review selects Codex auto review, even from a catalog saved before it existed', async t => {
  const { remote, projects, project, adapter, options } = await setup(t, { permission: () => 'auto' });
  remote.catalog[0].modes.push({ id: 'workspace-write', label: 'Workspace write · ask on request' }); await projects.refresh(project.id);
  await collect(adapter.stream(options()));
  assert.equal(remote.created!.modeId, 'auto-review');
});

test('a host that cannot keep the CLI running after DSH quits fails the response with the reason', async t => {
  const { remote, adapter, options } = await setup(t);
  remote.onCreate = () => { throw new Error(RELAY_UNAVAILABLE['missing-node']); };
  await assert.rejects(collect(adapter.stream(options())), (error: Error) => error.message === RELAY_UNAVAILABLE['missing-node']);
});

test('after a failed start is fixed, a new message starts the CLI with it instead of replaying the failed prompt', async t => {
  const { remote, adapter, options, service } = await setup(t);
  remote.onCreate = () => { throw new Error(RELAY_UNAVAILABLE['missing-node']); };
  const first = user('hello');
  await assert.rejects(collect(adapter.stream(options('hello', { messages: [first] }))), /Node\.js was not found/);
  // Once Node.js is installed, replaying the first prompt would keep the CLI busy and reject this message.
  remote.onCreate = agent => remote.append(agent.id, { type: 'assistant_message', text: 'Hi' });
  remote.onSend = () => assert.fail('the new message must start the CLI, not follow a replayed prompt');
  await collect(adapter.stream(options('hello again', { messages: [first, user('hello again')] })));
  assert.match(remote.created!.prompt, /user: hello\n\nCurrent user request:\nhello again$/);
  assert.equal(service.store.snapshot().tasks.length, 1);
});

test('new Codex chats use the remote CLI permission config instead of forcing workspace write', async t => {
  const { remote, adapter, options } = await setup(t);
  await collect(adapter.stream(options('Use remote permissions')));
  assert.equal(remote.created!.modeId, 'inherit');
});

test('dismissed approvals stay pending and can be answered in the session panel without stopping the turn', async t => {
  let prompts = 0;
  const { adapter, options, remote, service, store } = await setup(t, { approval: { request: async () => { prompts++; return 'dismissed'; } } });
  remote.onCreate = agent => { agent.status = 'running'; agent.pendingPermissions = [{ id: 'approve', name: 'Bash', kind: 'tool' }]; };
  const stream = adapter.stream(options());
  assert.equal((await stream.next()).value?.type, 'block-start');
  const task = store.snapshot().tasks[0];
  assert.equal((await service.state(task.id)).agent.status, 'attention'); assert.equal(remote.stops, 0);
  await service.respond(task.id, 'approve', { behavior: 'allow' });
  remote.append(remote.live(task.id).id, { type: 'assistant_message', text: 'Approved from panel' }); remote.live(task.id).status = 'idle';
  assert.equal(text(await collect(stream)), 'Approved from panel'); assert.equal(prompts, 1); assert.equal(remote.stops, 0);
});

test('unavailable DSH approval services fail promptly and stop the remote CLI', async t => {
  const { adapter, options, remote } = await setup(t, { agent: () => undefined });
  remote.onCreate = agent => { agent.status = 'running'; agent.pendingPermissions = [{ id: 'approve', name: 'Bash', kind: 'tool' }]; };
  await assert.rejects(collect(adapter.stream(options())), /unavailable/); assert.equal(remote.stops, 1);
});

test('answering from the panel while the native approval is open does not fail or answer twice', async t => {
  let shown!: () => void, answer!: (value: string) => void;
  const showing = new Promise<void>(resolve => { shown = resolve; });
  const decision = new Promise<string>(resolve => { answer = resolve; });
  const { adapter, options, remote, service, store } = await setup(t, { approval: { request: () => { shown(); return decision; } } });
  remote.onCreate = agent => { agent.status = 'running'; agent.pendingPermissions = [{ id: 'approve', name: 'Bash', kind: 'tool' }]; };
  const response = collect(adapter.stream(options())); await showing;
  const task = store.snapshot().tasks[0];
  await service.respond(task.id, 'approve', { behavior: 'allow' }); answer('allowed-once');
  const agent = remote.live(task.id); remote.append(agent.id, { type: 'assistant_message', text: 'Finished once' }); agent.status = 'idle';
  assert.equal(text(await response), 'Finished once'); assert.equal(remote.answers.length, 1); assert.equal(remote.stops, 0);
});

test('the session browser cannot send outside the bound native conversation', async t => {
  const { adapter, options, service, store, remote } = await setup(t);
  await collect(adapter.stream(options()));
  const response = await createHandler(service)(new Request('http://dsh.test/api/remote-agents', { method: 'POST', headers: { 'content-type': 'application/json', 'X-DSH-Remote-Agents': '1' },
    body: JSON.stringify({ action: 'send', agentId: store.snapshot().tasks[0].id, message: { id: 'panel-message-1', text: 'Untracked prompt' } }) }));
  assert.equal(response.status, 409); assert.equal(remote.sends, 0);
});

test('switching models within a CLI retains the conversation and its old message receipts', async t => {
  const { adapter, options, remote, store, projects, project, service } = await setup(t);
  remote.catalog[0].models.push({ id: 'next-model', label: 'Next model' }); await projects.refresh(project.id);
  remote.onCreate = agent => remote.append(agent.id, { type: 'assistant_message', text: 'First model reply' });
  const first = options(); await collect(adapter.stream(first));
  const task = store.snapshot().tasks[0];
  assert.equal((await service.summary(task.id)).chatSessionId, first.sessionId);
  const second = options('Continue with next model', { model: chatModelId(project.id, 'codex', 'next-model') });
  assert.equal(text(await collect(adapter.stream(second))), 'Follow-up completed.');
  assert.equal(store.snapshot().tasks.length, 1); assert.equal(remote.creates, 1); assert.equal(remote.detaches, 1);
  assert.equal(store.snapshot().tasks[0].model, 'next-model');
  assert.equal(text(await collect(adapter.stream(first))), 'First model reply');
  assert.equal(store.snapshot().tasks[0].model, 'next-model', 'replaying an older response never changes the live model');
  assert.equal(text(await collect(adapter.stream(second))), 'Follow-up completed.'); assert.equal(remote.sends, 1);
  await collect(adapter.stream(options('Back to first model'))); assert.equal(remote.creates, 1); assert.equal(remote.sends, 2);
});

test('Codex Fast is a per-conversation switch on one model row; routes saved with a tier still run Fast', async t => {
  const { adapter, options, remote, store, projects, project } = await setup(t);
  remote.catalog[0].models[0].serviceTiers = [{ id: 'priority', label: 'Fast' }]; await projects.refresh(project.id);
  const models = await adapter.listModels(CODEX_PROVIDER);
  assert.deepEqual(models.map(m => m.name), ['Remote model · Build server'], 'no separate Fast row');
  const normal = options().model, session = options().sessionId!;
  assert.deepEqual(projects.speed(session, normal), { available: true, enabled: false });
  assert.deepEqual(projects.speed(session, chatModelId(project.id, 'codex', 'other-model')), { available: false, enabled: false });
  await projects.setFast(session, true);
  await collect(adapter.stream(options('Go fast')));
  assert.equal(remote.created?.serviceTier, 'priority');
  await projects.setFast(session, false);
  await collect(adapter.stream(options('Back to the configured speed')));
  assert.equal(remote.creates, 1); assert.equal(remote.detaches, 1);
  assert.equal(store.snapshot().tasks[0].serviceTier, undefined); assert.equal(store.snapshot().chatFast, undefined);
  // A conversation saved on the old Fast row keeps running Fast until the client moves it to the switch.
  const fast = chatModelId(project.id, 'codex', 'remote-model', 'priority');
  assert.deepEqual((await adapter.resolveModel(CODEX_PROVIDER, fast)).reasoning?.efforts.map(e => e.id), ['high']);
  await assert.rejects(adapter.resolveModel(CODEX_PROVIDER, chatModelId(project.id, 'codex', 'remote-model', 'flex')), /unavailable/);
  await assert.rejects(adapter.resolveModel(CODEX_PROVIDER, `${fast}/extra`), /unavailable/);
  assert.deepEqual(projects.speed(session, fast), { available: true, enabled: false });
  await collect(adapter.stream(options('Fast again', { model: fast })));
  assert.equal(store.snapshot().tasks[0].serviceTier, 'priority'); assert.equal(remote.detaches, 2);
  assert.equal(store.chatFast('another-conversation'), false, 'the switch belongs to one conversation');
});

test('the Fast switch picks Codex’s priority or fast tier, or a model’s only extra tier', () => {
  assert.equal(fastTierOf({ serviceTiers: [{ id: 'flex', label: 'Flex' }, { id: 'priority', label: 'Fast' }] })?.id, 'priority');
  assert.equal(fastTierOf({ serviceTiers: [{ id: 'fast', label: 'Fast' }] })?.id, 'fast');
  assert.equal(fastTierOf({ serviceTiers: [{ id: 'turbo', label: 'Turbo' }] })?.id, 'turbo');
  assert.equal(fastTierOf({ serviceTiers: [{ id: 'flex', label: 'Flex' }, { id: 'scale', label: 'Scale' }] }), undefined);
  assert.equal(fastTierOf({}), undefined);
});

test('native tool cards produce a valid DSH session lifecycle and never request DSH tool dispatch', async t => {
  const session = Session.create(SessionId('native-cards'));
  session.append('turn/start', { turn: 1 }); session.append('step/start', { turn: 1, step: 1 });
  const { adapter, options, remote } = await setup(t, { step: () => ({ session, turn: 1, step: 1 }) });
  remote.onCreate = agent => {
    remote.append(agent.id, { type: 'tool_call', callId: 'tool-1', name: 'Bash', status: 'running', detail: { command: 'pnpm test' } });
    remote.append(agent.id, { type: 'tool_call', callId: 'tool-1', name: 'Bash', status: 'completed', detail: '42 tests pass' });
    remote.append(agent.id, { type: 'assistant_message', text: 'All done' });
  };
  const chunks: StreamChunk[] = []; let whileStreaming: string[] = [];
  for await (const chunk of adapter.stream(options('Run tests', { sessionId: session.id }))) {
    if (chunk.type === 'text-delta' && !whileStreaming.length) whileStreaming = session.snapshotEvents().map(e => e.type);
    chunks.push(chunk);
  }
  assert.equal(chunks.some(c => c.type === 'tool-call-delta'), false); assert.equal(text(chunks), 'All done');
  // A model message in the streaming step would make a reopened DSH chat hide the CLI's text.
  assert.deepEqual(whileStreaming, ['turn/start', 'step/start', 'tool/call', 'tool/ptc-dispatch-start', 'tool/ptc-dispatch']);
  session.append('step/end', { turn: 1, step: 1 });
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  const events = session.snapshotEvents();
  assert.deepEqual(events.map(e => e.type), [...whileStreaming, 'assistant/message', 'tool/result', 'step/end', 'turn/end']);
  const restored = Session.create(session.id, events, session.header), messages = restored.deriveMessages();
  const call = messages.flatMap(m => m.role === 'assistant' ? m.content : []).find(b => b.type === 'tool-call');
  const results = messages.filter(m => m.role === 'tool');
  assert.equal(results.length, 1); assert.equal(results[0]?.role === 'tool' && results[0].toolCallId, call?.type === 'tool-call' && call.id);
  assert.match(results[0]?.content[0]?.type === 'text' ? results[0].content[0].text : '', /^Bash \{"command":"pnpm test"\}\n42 tests pass$/);
});

test('text-only input, auxiliary calls and unavailable routes never start an unintended CLI', async t => {
  const { adapter, options, remote } = await setup(t);
  await assert.rejects(collect(adapter.stream(options('Work', { sessionId: undefined }))), /conversation/);
  await assert.rejects(collect(adapter.stream(options('Work', { model: 'removed/model' }))), /unavailable/);
  await assert.rejects(collect(adapter.stream(options('Work', { reasoningEffort: ReasoningEffortId('unknown') }))), /thinking level/);
  assert.ok(text(await collect(adapter.stream(options('Title', { purpose: 'session-title' })))));
  // DSH's title request: an instruction line, then a JSON array of the human messages.
  const framed = `Generate the session title from this JSON array of human messages:\n${JSON.stringify([{ seq: 1, text: '  Fix the\nlogin bug ' }, { seq: 2, text: 'Also add tests' }])}`;
  assert.equal(text(await collect(adapter.stream(options(framed, { purpose: 'session-title' })))), 'Fix the login bug');

  assert.equal(remote.creates, 0);
});

test('each remote model defaults to the reasoning effort its last conversation turn used', async t => {
  const { adapter, options, remote, projects, project, store, path } = await setup(t);
  remote.catalog[0].models[0].thinkingOptions!.push({ id: 'low', label: 'Low' }); remote.catalog[0].models[0].defaultThinkingOptionId = 'high';
  await projects.refresh(project.id);
  let refreshes = 0; adapter.onModelInfoChange(() => refreshes++);
  const route = options().model, effortOf = async () => (await adapter.resolveModel(CODEX_PROVIDER, route)).reasoning?.defaultEffort;
  assert.equal(await effortOf(), 'high', 'the CLI default before any turn');
  await collect(adapter.stream(options('Quick question', { reasoningEffort: ReasoningEffortId('low') }))); await pause(20);
  assert.equal(await effortOf(), 'low'); assert.equal(refreshes, 1, 'DSH is told to reload the catalog');
  await collect(adapter.stream(options('Another', { reasoningEffort: ReasoningEffortId('low') }))); await pause(20);
  assert.equal(refreshes, 1, 'an unchanged effort does not reload the catalog');
  await collect(adapter.stream(options('Summarize', { purpose: 'compaction', reasoningEffort: ReasoningEffortId('high') }))); await pause(20);
  assert.equal(await effortOf(), 'low', 'compaction does not change the remembered effort');
  const reopened = new Store(path); await reopened.open(); assert.equal(reopened.chatEffort(route), 'low', 'it survives a restart');
  remote.catalog[0].models[0].thinkingOptions = [{ id: 'high', label: 'High' }]; await projects.refresh(project.id);
  assert.equal(await effortOf(), 'high', 'an effort the model no longer offers falls back to its default');
  assert.equal(store.chatEffort('constructor'), undefined);
});

test('compaction uses a disposable CLI session and preserves the live conversation binding', async t => {
  const { adapter, options, remote, store } = await setup(t);
  remote.onCreate = agent => remote.append(agent.id, { type: 'assistant_message', text: 'Summary result' });
  await collect(adapter.stream(options('Implement this')));
  const original = store.snapshot().tasks[0];
  const compacted = await collect(adapter.stream(options('Summarize the conversation', { purpose: 'compaction' })));
  assert.equal(text(compacted), 'Summary result'); assert.equal(remote.creates, 2); assert.equal(remote.forgets, 1);
  assert.equal(store.snapshot().tasks.length, 1); assert.deepEqual(store.snapshot().tasks[0], original);
});

test('unconfirmed delivery stays visible as an error on retry instead of resending or returning empty success', async t => {
  const { adapter, options, remote } = await setup(t);
  remote.onCreate = agent => { remote.entries.get(agent.id)![0].item.delivery = 'pending'; };
  const input = options();
  await assert.rejects(collect(adapter.stream(input)), /delivery was not confirmed/);
  await assert.rejects(collect(adapter.stream(input)), /delivery was not confirmed/);
  assert.equal(remote.creates, 1); assert.equal(remote.sends, 0);
});

test('main chat HTTP actions persist a discovered project and refresh/remove it', async t => {
  const { service, hostId } = await fixture(t), handler = createHandler(service);
  const post = async (body: unknown) => handler(new Request('http://dsh.test/api/remote-agents', { method: 'POST',
    headers: { 'content-type': 'application/json', 'X-DSH-Remote-Agents': '1' }, body: JSON.stringify(body) }));
  const added = await post({ action: 'addChatProject', project: { label: 'Native', hostId, cwd: '/srv/project' } }); assert.equal(added.status, 200);
  const [project] = await added.json();
  assert.equal((await post({ action: 'refreshChatProject', projectId: project.id })).status, 200);
  assert.equal((await (await post({ action: 'chatProjects' })).json()).length, 1);
  assert.deepEqual(await (await post({ action: 'removeChatProject', projectId: project.id })).json(), []);
});

test('durable message pages drain more than 100 events and stop at the next submitted message', async t => {
  const { directory } = await fixture(t), history = new TaskHistory(directory, 'message-history'); await history.open();
  await history.append({ type: 'user_message', clientMessageId: 'first', text: 'First' });
  for (let i = 0; i < 240; i++) await history.append({ type: 'assistant_message', text: String(i) });
  await history.append({ type: 'user_message', clientMessageId: 'second', text: 'Second' });
  await history.append({ type: 'assistant_message', text: 'Other reply' });
  const first = await history.messagePage('first'), second = await history.messagePage('first', first.endCursor!), third = await history.messagePage('first', second.endCursor!);
  assert.equal(first.entries.length + second.entries.length + third.entries.length, 240); assert.equal(third.hasNewer, false);
  assert.equal(third.entries.at(-1)?.item.text, '239'); assert.equal((await history.messagePage('missing')).found, false);
});
