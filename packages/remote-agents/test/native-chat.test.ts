import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, { BlockAssembler, createUserMessage, createAssistantMessage, createSystemMessage, MessageId, ReasoningEffortId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import { assertReleasedV4Relationships } from '@deepseek-ai/dsh-session-format-v3-to-v4';
import { ChatProjects } from '../src/chat/projects.js';
import { CHAT_PROVIDER, CHAT_PROVIDERS, SYNC_SOURCE, chatProviderId, chatModelId, RemoteCliAdapter, type ChatHost } from '../src/chat/native-chat.js';
import { toolStatus } from '../src/chat/transcript.js';
import { Store } from '../src/core/store.js';
import { RemoteAgentsService } from '../src/agents/service.js';
import { TaskHistory } from '../src/agents/history.js';
import { createHandler } from '../src/http.js';
import { fixture } from './fakes.js';
import { fastTierOf, RELAY_UNAVAILABLE, type DshPermission } from '../src/core/domain.js';

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

test('the reply says where Claude moved to another model, in the language of the message', async t => {
  for (const [prompt, expected] of [
    ['Fix the login', /Looking\n\n> \*\*Model switched\.\*\* claude-fable-5-1's safeguards stopped this request \(cyber\), so claude-opus-4-8 retried it\. .*pick a different one.*\n\nRetried$/],
    ['修复登录', /Looking\n\n> \*\*模型已切换。\*\* claude-fable-5-1 的安全机制拦截了这条消息 \(cyber\)，这一轮改由 claude-opus-4-8 重试。.*选另一个模型.*\n\nRetried$/],
  ] as const) {
    const { adapter, options, remote } = await setup(t);
    remote.onCreate = agent => {
      remote.append(agent.id, { type: 'assistant_message', text: 'Looking' });
      remote.append(agent.id, { type: 'model_switch', from: 'claude-fable-5-1', to: 'claude-opus-4-8', category: 'cyber' });
      remote.append(agent.id, { type: 'assistant_message', text: 'Retried' });
    };
    assert.match(text(await collect(adapter.stream(options(prompt)))), expected);
  }
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

test('images the CLI read with its tools appear in the reply where it read them, once each', async t => {
  const { adapter, options, remote, store } = await setup(t);
  const directory = join(store.directory, 'chat-images'), shot = `${'a'.repeat(64)}.png`, gone = `${'b'.repeat(64)}.jpg`;
  await mkdir(directory, { recursive: true }); await writeFile(join(directory, shot), 'png');
  remote.onCreate = agent => {
    remote.append(agent.id, { type: 'assistant_message', text: 'Look at the receipt:' });
    remote.append(agent.id, { type: 'tool_call', callId: 'read-1', name: 'Read', status: 'running', detail: { file_path: '/tmp/a1-receipt.png' } });
    // Only content-hash names are files here; one another DSH saved has no copy on this host.
    remote.append(agent.id, { type: 'tool_call', callId: 'read-1', name: 'Read', status: 'completed', detail: '',
      images: [{ file: shot, name: 'a1-[receipt].png' }, { file: '../state.png', name: 'escape' }, { file: gone, name: 'elsewhere.jpg' }] });
    remote.append(agent.id, { type: 'assistant_message', text: 'Again:' });
    remote.append(agent.id, { type: 'tool_call', callId: 'read-2', name: 'Read', status: 'completed', detail: '', images: [{ file: shot, name: 'same.png' }] });
    remote.append(agent.id, { type: 'assistant_message', text: 'Done' });
  };
  const chunks = await collect(adapter.stream(options()));
  const blocks = chunks.flatMap(c => c.type === 'block-end' && c.block.type === 'text' ? [c.block.text] : []);
  assert.deepEqual(blocks, ['Look at the receipt:', `![a1-receipt.png](<${join(directory, shot).replace(/\\/g, '/')}>)`, 'Again:', 'Done']);
});

test('an image the CLI viewed by path, as Codex does, is fetched from the remote machine once per reply and only if it is an image', async t => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('pixels')]), fetched: string[] = [];
  const { adapter, options, remote, store } = await setup(t, { viewedImage: async (_id, path) => {
    fetched.push(path);
    if (path === '/tmp/qa/missing.png') throw new Error('No such file');
    return path === '/tmp/qa/shot.png' ? png : Buffer.from('not an image');
  } });
  remote.onCreate = agent => {
    remote.append(agent.id, { type: 'tool_call', callId: 'view-1', name: 'view_image', status: 'completed', images: [{ path: '/tmp/qa/shot.png', name: 'shot.png' }] });
    // No copy here: the generated image's saved path is fetched, and the same picture is not shown twice.
    remote.append(agent.id, { type: 'tool_call', callId: 'gen-1', name: 'image_generation', status: 'completed', images: [{ file: `${'c'.repeat(64)}.png`, path: '/tmp/qa/shot.png', name: 'gen.png' }] });
    remote.append(agent.id, { type: 'tool_call', callId: 'view-2', name: 'view_image', status: 'completed',
      images: [{ path: 'relative.png', name: 'r' }, { path: '/tmp/qa/fake.png', name: 'f' }, { path: '/tmp/qa/missing.png', name: 'm' }, { path: '/etc/passwd', name: 'p' }] });
    remote.append(agent.id, { type: 'assistant_message', text: 'Seen' });
  };
  const chunks = await collect(adapter.stream(options()));
  const blocks = chunks.flatMap(c => c.type === 'block-end' && c.block.type === 'text' ? [c.block.text] : []);
  const local = join(store.directory, 'chat-images', `${createHash('sha256').update(png).digest('hex')}.png`);
  assert.deepEqual(blocks, [`![shot.png](<${local.replace(/\\/g, '/')}>)`, 'Seen']);
  assert.deepEqual(await readFile(local), png);
  assert.deepEqual(fetched, ['/tmp/qa/shot.png', '/tmp/qa/fake.png', '/tmp/qa/missing.png']);
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

const MISSED = 'Output from the previous response, completed while DSH was disconnected:';
const syncAgent = (input: GenerateOptions, send: (message: ReturnType<typeof createUserMessage>) => void = () => {}) => ({ session: { id: input.sessionId!, requestHeader: () => ({ config: { provider: input.provider, model: input.model } }) as ReturnType<Session['requestHeader']> }, send });

test('DSH Stop before any output leaves nothing to catch up on', async t => {
  const { adapter, options, remote, store } = await setup(t);
  remote.onCreate = agent => { agent.status = 'running'; };
  const controller = new AbortController(), input = options('Work', { signal: controller.signal });
  const stopped = assert.rejects(collect(adapter.stream(input)), /abort/i);
  while (!store.snapshot().tasks[0]?.chat?.delivered) await pause(1);
  controller.abort(); await stopped;
  assert.equal(adapter.sync(syncAgent(input)), false, 'reopening the conversation shows no catch-up');
  assert.equal(text(await collect(adapter.stream(options('Next')))), 'Follow-up completed.');
});

test('DSH Stop drops what the CLI wrote after the last read instead of showing it as missed', async t => {
  const { adapter, options, remote } = await setup(t);
  remote.onCreate = agent => { agent.status = 'running'; remote.append(agent.id, { type: 'assistant_message', text: 'Working' }); };
  const controller = new AbortController(), input = options('Work', { signal: controller.signal }), iterator = adapter.stream(input);
  await iterator.next();
  remote.append([...remote.agents.keys()][0], { type: 'assistant_message', text: 'Late' }); controller.abort();
  await assert.rejects(collect(iterator), /abort/i);
  assert.equal(adapter.sync(syncAgent(input)), false);
  assert.equal(text(await collect(adapter.stream(options('Next')))), 'Follow-up completed.');
});

test('DSH Stop right after sending does not show the stopped turn as sent elsewhere', async t => {
  const { adapter, options, remote } = await setup(t);
  await collect(adapter.stream(options('First')));
  const controller = new AbortController();
  remote.onSend = agent => { agent.status = 'running'; controller.abort(); };
  await assert.rejects(collect(adapter.stream(options('Stopped', { signal: controller.signal }))), /abort/i);
  remote.onSend = undefined;
  assert.equal(text(await collect(adapter.stream(options('Next')))), 'Follow-up completed.');
});

test('DSH Stop that cannot reach the CLI still catches up on what it went on to write', async t => {
  const { adapter, options, remote } = await setup(t);
  remote.onCreate = agent => { agent.status = 'running'; remote.append(agent.id, { type: 'assistant_message', text: 'Working' }); };
  const controller = new AbortController(), iterator = adapter.stream(options('Work', { signal: controller.signal }));
  await iterator.next();
  remote.unreachable = true; controller.abort();
  await assert.rejects(collect(iterator), /abort/i);
  const [id, agent] = [...remote.agents.entries()][0];
  assert.equal(agent.status, 'running', 'the CLI never heard the Stop');
  remote.append(id, { type: 'assistant_message', text: 'Finished offline' }); agent.status = 'idle'; remote.unreachable = false;
  assert.equal(text(await collect(adapter.stream(options('Next')))), `${MISSED}\n\nFinished offline\n\n---\n\nFollow-up completed.`);
});

test('a CLI failure already shown is not repeated as output missed while DSH was disconnected', async t => {
  const { adapter, options, remote } = await setup(t);
  remote.onCreate = agent => { agent.status = 'running'; remote.append(agent.id, { type: 'assistant_message', text: 'Working' }); };
  const iterator = adapter.stream(options('Work'));
  const seen: StreamChunk[] = [(await iterator.next()).value as StreamChunk, (await iterator.next()).value as StreamChunk];
  assert.equal(text(seen), 'Working');
  const [id, agent] = [...remote.agents.entries()][0];
  remote.append(id, { type: 'error', message: 'Boom' }); agent.status = 'idle';
  await assert.rejects(collect(iterator), /Boom/);
  assert.equal(text(await collect(adapter.stream(options('Next')))), 'Follow-up completed.');
});

for (const [name, tail] of [
  ['usage and a turn end', [{ type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }, { type: 'turn_end', status: 'completed' }]],
  ['empty reasoning', [{ type: 'reasoning', text: '' }, { type: 'turn_end', status: 'completed' }]],
] as const) test(`a disconnect that missed only ${name} shows no catch-up heading`, async t => {
  const { adapter, options, remote } = await setup(t);
  remote.onCreate = agent => { agent.status = 'running'; remote.append(agent.id, { type: 'assistant_message', text: 'Working' }); };
  const shutdown = new AbortController(), first = options('Work', { signal: shutdown.signal }), iterator = adapter.stream(first);
  await iterator.next(); shutdown.abort({ kind: 'disposed' });
  await assert.rejects(collect(iterator));
  const [id, agent] = [...remote.agents.entries()][0];
  for (const item of tail) remote.append(id, { ...item }); agent.status = 'idle';
  // Reopening the conversation wakes it, as it cannot know what is left without reading: the reply says there was nothing.
  let notice: ReturnType<typeof createUserMessage> | undefined;
  assert.equal(adapter.sync(syncAgent(first, message => { notice = message; })), true);
  assert.equal(text(await collect(adapter.stream({ ...first, signal: undefined, messages: [...first.messages, notice!] }))), 'The remote CLI produced no further output.');
});

test('a disconnect that missed only bookkeeping leaves the next message without a heading', async t => {
  const { adapter, options, remote } = await setup(t);
  remote.onCreate = agent => { agent.status = 'running'; remote.append(agent.id, { type: 'assistant_message', text: 'Working' }); };
  const shutdown = new AbortController(), iterator = adapter.stream(options('Work', { signal: shutdown.signal }));
  await iterator.next(); shutdown.abort({ kind: 'disposed' });
  await assert.rejects(collect(iterator));
  const [id, agent] = [...remote.agents.entries()][0];
  remote.append(id, { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }); remote.append(id, { type: 'turn_end', status: 'completed' }); agent.status = 'idle';
  assert.equal(text(await collect(adapter.stream(options('Next')))), 'Follow-up completed.');
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

test('an AgentTeams member CLI receives its assignments, learns the team tools once and never waits for approvals', async t => {
  let asked = 0;
  const { remote, adapter, options, store } = await setup(t, { teamMember: () => ({ team: 'web', member: 'coder' }), unattended: () => true,
    approval: { request: async () => { asked++; return 'rejected'; } } });
  // AgentTeams delivers later assignments and coordination with its own message source.
  const team = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'agent-teams' } as never });
  remote.onCreate = agent => {
    agent.status = 'running'; agent.pendingPermissions = [{ id: 'escalate', kind: 'tool', name: 'Bash', actions: [
      { id: 'accept', label: 'Allow once', behavior: 'allow' }, { id: 'cancel', label: 'Cancel', behavior: 'deny' }, { id: 'decline', label: 'Deny', behavior: 'deny' }] }];
    void (async () => { while (!remote.answers.length) await pause(5); agent.pendingPermissions = []; remote.append(agent.id, { type: 'assistant_message', text: 'Done' }); agent.status = 'idle'; })();
  };
  const first = user('AgentTeams automatic task assignment: t1');
  assert.equal(text(await collect(adapter.stream(options('', { messages: [first] })))), 'Done');
  assert.match(remote.created!.prompt, /^You are member "coder" of the DSH AgentTeams team "web"/);
  assert.match(remote.created!.prompt, /agent_teams_update_task/); assert.match(remote.created!.prompt, /Nobody can answer approval prompts/);
  assert.match(remote.created!.prompt, /\n\nAgentTeams automatic task assignment: t1$/);
  assert.equal(store.snapshot().tasks[0].unattended, true);
  assert.equal(asked, 0, 'an unattended member does not ask DSH, which would only reject');
  assert.deepEqual(remote.answers[0].answer, { behavior: 'deny', message: remote.answers[0].answer.message, selectedActionId: 'decline' }, 'the denial lets the turn go on');

  let sent = ''; remote.onSend = (agent, message) => { sent = message; remote.append(agent.id, { type: 'assistant_message', text: 'Checked' }); };
  assert.equal(text(await collect(adapter.stream(options('', { messages: [first, team('Captain: also check t2')] })))), 'Checked');
  assert.equal(sent, 'Captain: also check t2', 'a team message is a prompt, without the note again');
  assert.equal(remote.creates, 1); assert.equal(remote.sends, 1);
});

test('injected DSH context still never reaches the CLI as a prompt', async t => {
  const { remote, adapter, options } = await setup(t);
  const injected = createUserMessage({ content: [{ type: 'text', text: 'runtime context' }], source: { kind: 'runtime-context', form: 'snapshot' } as never });
  await collect(adapter.stream(options('', { messages: [user('Fix it'), injected] })));
  assert.equal(remote.created!.prompt, 'Fix it');
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
  assert.deepEqual(whileStreaming, ['turn/start', 'step/start']);
  session.append('step/end', { turn: 1, step: 1 });
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  const events = session.snapshotEvents();
  // DSH refuses to reopen a log whose tool/call precedes its advertising message; its chat needs the row before nested calls.
  assert.deepEqual(events.map(e => e.type), [...whileStreaming, 'assistant/message', 'tool/call', 'tool/ptc-dispatch-start', 'tool/ptc-dispatch', 'tool/result', 'step/end', 'turn/end']);
  assertReleasedV4Relationships({ header: session.header, events, inheritedEventCount: 0 } as unknown as Parameters<typeof assertReleasedV4Relationships>[0], new Set(events.map(e => e.type)));
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

test('an explicit effort selection updates the default and survives restart without sending a turn', async t => {
  const { adapter, options, remote, projects, project, service, store, path } = await setup(t);
  remote.catalog[0].models[0].thinkingOptions!.push({ id: 'low', label: 'Low' }); remote.catalog[0].models[0].defaultThinkingOptionId = 'low';
  await projects.refresh(project.id);
  let refreshes = 0; const off = adapter.onModelInfoChange(() => refreshes++);
  const route = options().model, effortOf = async () => (await adapter.resolveModel(CODEX_PROVIDER, route)).reasoning?.defaultEffort;
  const handler = createHandler(service, projects);
  const select = (reasoningEffort: string) => handler(new Request('http://dsh.test/api/remote-agents', { method: 'POST',
    headers: { 'content-type': 'application/json', 'X-DSH-Remote-Agents': '1' }, body: JSON.stringify({ action: 'setChatEffort', provider: CODEX_PROVIDER, model: route, reasoningEffort }) }));
  assert.equal(await effortOf(), 'low', 'the CLI default before any explicit selection');
  const discoveries = remote.discoveries;
  const selected = await select('high'); assert.equal(selected.status, 200); assert.deepEqual(await selected.json(), { ok: true });
  assert.equal(await effortOf(), 'high'); assert.equal(refreshes, 1, 'DSH is told to reload the catalog');
  assert.equal((await select('high')).status, 200); assert.equal(refreshes, 1, 'an unchanged selection does not reload the catalog');
  assert.equal(remote.creates, 0); assert.equal(remote.sends, 0); assert.equal(remote.discoveries, discoveries, 'selection never probes SSH');
  const reopened = new Store(path); await reopened.open(); assert.equal(reopened.chatEffort(route), 'high');
  const restarted = new RemoteAgentsService(reopened, remote.backend); t.after(() => restarted.close());
  const next = new RemoteCliAdapter(new ChatProjects(restarted), { agent: () => undefined, step: () => undefined }); t.after(() => next.close());
  assert.equal((await next.resolveModel(CODEX_PROVIDER, route)).reasoning?.defaultEffort, 'high', 'the picker default survives restart');
  remote.catalog[0].models[0].thinkingOptions = [{ id: 'low', label: 'Low' }]; await projects.refresh(project.id);
  assert.equal(await effortOf(), 'low', 'a removed effort falls back to the CLI default');
  off(); await projects.setEffort(CODEX_PROVIDER, route, 'low'); assert.equal(refreshes, 1, 'the model-info subscription disposes');
  assert.equal(store.chatEffort('constructor'), undefined);
});

test('turns without an effort use the advertised remembered default, but explicit Low stays Low', async t => {
  const { adapter, options, remote, projects, project, store } = await setup(t);
  remote.catalog[0].models[0].thinkingOptions!.push({ id: 'low', label: 'Low' }); remote.catalog[0].models[0].defaultThinkingOptionId = 'low';
  await projects.refresh(project.id);
  const route = options().model; await projects.setEffort(CODEX_PROVIDER, route, 'high');
  assert.equal((await adapter.resolveModel(CODEX_PROVIDER, route)).reasoning?.defaultEffort, 'high');
  await collect(adapter.stream(options('Use the advertised default')));
  assert.equal(remote.created?.thinkingOptionId, 'high', 'omitting effort must not silently run the CLI default Low');
  await collect(adapter.stream(options('An old chat explicitly requests Low', { reasoningEffort: ReasoningEffortId('low') })));
  assert.equal(store.snapshot().tasks[0].thinkingOptionId, 'low'); assert.equal(store.chatEffort(route), 'high');
  await collect(adapter.stream(options('Use the default again')));
  assert.equal(store.snapshot().tasks[0].thinkingOptionId, 'high');
  remote.catalog[0].models[0].thinkingOptions = [{ id: 'low', label: 'Low' }]; await projects.refresh(project.id);
  await collect(adapter.stream(options('The remembered effort is no longer supported')));
  assert.equal(store.snapshot().tasks[0].thinkingOptionId, 'low'); assert.equal(store.chatEffort(route), 'high', 'fallback is not an explicit selection');
});

test('old Low streams, receipt replay, sync and compaction cannot overwrite an explicit High selection', async t => {
  const { adapter, options, remote, projects, project, store } = await setup(t);
  remote.catalog[0].models[0].thinkingOptions!.push({ id: 'low', label: 'Low' }); remote.catalog[0].models[0].defaultThinkingOptionId = 'low';
  await projects.refresh(project.id);
  const first = options('Old Low turn', { reasoningEffort: ReasoningEffortId('low') }), route = first.model;
  await collect(adapter.stream(first));
  assert.equal(store.chatEffort(route), undefined, 'even a successful turn must not implicitly remember its effort');
  await projects.setEffort(CODEX_PROVIDER, route, 'high');
  let refreshes = 0; adapter.onModelInfoChange(() => refreshes++);
  await collect(adapter.stream(first)); assert.equal(store.chatEffort(route), 'high', 'old receipts do not change the selection');
  const follow = options('Old session continues with Low', { reasoningEffort: ReasoningEffortId('low') });
  await collect(adapter.stream(follow)); assert.equal(store.chatEffort(route), 'high', 'old conversation configuration does not change the selection');
  const task = store.snapshot().tasks[0], delivered = task.chat!.delivered!;
  await store.update(state => { state.tasks[0].chat!.delivered = { messageId: delivered.messageId, cursor: null }; });
  let notice: ReturnType<typeof createUserMessage> | undefined;
  assert.equal(adapter.sync({ session: { id: follow.sessionId!, requestHeader: () => ({ config: { provider: CODEX_PROVIDER, model: route } }) as ReturnType<Session['requestHeader']> },
    send: message => { notice = message; } }), true);
  assert.equal(notice?.source?.kind, SYNC_SOURCE);
  const creates = remote.creates, sends = remote.sends;
  await collect(adapter.stream({ ...follow, messages: [...follow.messages, notice!] }));
  assert.equal(store.chatEffort(route), 'high', 'a sync wake does not remember the old header effort');
  assert.equal(remote.creates, creates); assert.equal(remote.sends, sends, 'sync only follows output');
  await collect(adapter.stream(options('Summarize', { purpose: 'compaction', reasoningEffort: ReasoningEffortId('low') })));
  assert.equal(store.chatEffort(route), 'high', 'compaction never changes the selection');
  assert.equal(refreshes, 0, 'execution never reloads the effort catalog');
});

test('a rejected workspace admission cannot remember a stale conversation effort', async t => {
  const { adapter, options, remote, projects, project, store } = await setup(t, { workspace: async () => ({ hostIds: [], cwd: '/srv/project' }) });
  remote.catalog[0].models[0].thinkingOptions!.push({ id: 'low', label: 'Low' }); await projects.refresh(project.id);
  const route = options().model; await projects.setEffort(CODEX_PROVIDER, route, 'high');
  await assert.rejects(collect(adapter.stream(options('Not admitted', { reasoningEffort: ReasoningEffortId('low') }))), /does not belong/);
  await store.flush(); assert.equal(store.chatEffort(route), 'high'); assert.equal(remote.creates, 0);
});

test('explicit effort selection validates the provider, full route, legacy tier and supported effort', async t => {
  const { service, projects, project, options, remote, store, hostId } = await setup(t);
  remote.catalog[0].models[0].serviceTiers = [{ id: 'priority', label: 'Fast' }];
  remote.catalog[0].models.push({ id: 'plain/model', label: 'No thinking options' }); await projects.refresh(project.id);
  const route = options().model, handler = createHandler(service, projects);
  const post = (input: Record<string, unknown>) => handler(new Request('http://dsh.test/api/remote-agents', { method: 'POST',
    headers: { 'content-type': 'application/json', 'X-DSH-Remote-Agents': '1' }, body: JSON.stringify({ action: 'setChatEffort', provider: CODEX_PROVIDER, model: route, reasoningEffort: 'high', ...input }) }));
  let refreshes = 0; projects.onEffortChange(() => refreshes++);
  const discoveries = remote.discoveries;
  for (const input of [
    { provider: 'codex' }, { provider: 'remote-cli-claude' }, { provider: 'remote-cli-codex-extra' },
    { model: `${project.id}/codex` }, { model: `${project.id}/codex/%ZZ` }, { model: `${route}/priority/extra` },
    { model: `${route}/unavailable` }, { model: `${route}/` }, { model: `${route}/%ZZ` },
    { model: `removed/codex/remote-model` }, { model: `${project.id}/claude/remote-model` },
    { model: chatModelId(project.id, 'codex', 'plain/model') }, { reasoningEffort: 'unsupported' },
    { reasoningEffort: '' }, { reasoningEffort: 1 }, { provider: null }, { model: null },
  ]) {
    const response = await post(input); assert.equal(response.status, 400, JSON.stringify(input));
    assert.equal(store.chatEffort(route), undefined); assert.equal(refreshes, 0);
  }
  assert.equal(remote.discoveries, discoveries); assert.equal(remote.creates, 0);
  assert.equal((await post({ provider: CHAT_PROVIDER })).status, 200, 'the saved aggregate provider remains valid');
  const tierRoute = `${route}/priority`;
  assert.equal((await post({ model: tierRoute })).status, 200); assert.equal(store.chatEffort(tierRoute), 'high');
  const [legacy] = await projects.add({ hostId, cwd: '/srv/legacy', label: 'Legacy project' });
  const legacyRoute = chatModelId(legacy.id, 'codex', 'remote-model', 'priority');
  await projects.setEffort(CODEX_PROVIDER, legacyRoute, 'high'); assert.equal(store.chatEffort(legacyRoute), 'high', 'available legacy project and tier routes remain valid');
  await store.update(state => { state.hosts[0].catalog!.providers[0].status = 'unavailable'; });
  assert.equal((await post({})).status, 400, 'an unavailable provider cannot accept a selection');
});

test('effort selections compare inside the write queue and preserve High-Low-High order', async t => {
  const { projects, project, options, remote, store } = await setup(t);
  remote.catalog[0].models[0].thinkingOptions!.push({ id: 'low', label: 'Low' }); await projects.refresh(project.id);
  const route = options().model;
  await projects.setEffort(CODEX_PROVIDER, route, 'high');
  const changes: (string | undefined)[] = []; projects.onEffortChange(() => changes.push(store.chatEffort(route)));
  await Promise.all(['high', 'low', 'high'].map(effort => projects.setEffort(CODEX_PROVIDER, route, effort)));
  assert.equal(store.chatEffort(route), 'high'); assert.deepEqual(changes, ['low', 'high']);
  const writes = await Promise.allSettled([
    projects.setEffort(CODEX_PROVIDER, route, 'low'), projects.setEffort(CODEX_PROVIDER, route, 'invalid'), projects.setEffort(CODEX_PROVIDER, route, 'high'),
  ]);
  assert.deepEqual(writes.map(write => write.status), ['fulfilled', 'rejected', 'fulfilled']);
  assert.equal(store.chatEffort(route), 'high', 'a rejected selection cannot poison the queue or overwrite the last valid choice');
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

test('follow-ups send the CLI only what it has not seen: never its own replies, but other models\' replies and human turns', async t => {
  const { adapter, options, remote, store, project } = await setup(t);
  remote.onCreate = agent => { remote.append(agent.id, { type: 'assistant_message', text: 'First reply from the CLI' }); };
  const first = options('Fix the tests'), route = first.model;
  await collect(adapter.stream(first));
  const sent = () => String(remote.entries.get(store.snapshot().tasks[0].agentId!)!.findLast(e => e.item.type === 'user_message')!.item.text);
  const own = createAssistantMessage({ source: { provider: CODEX_PROVIDER, model: route }, content: [{ type: 'text', text: 'First reply from the CLI' }] });
  const follow = user('Now run the linter');
  await collect(adapter.stream({ ...first, messages: [...first.messages, own, follow] }));
  assert.equal(sent(), 'Now run the linter', 'the CLI\'s own reply is in its session already');

  const detour = [user('Ask DeepSeek instead'), createAssistantMessage({ source: { provider: 'deepseek', model: 'chat' }, content: [{ type: 'text', text: 'DeepSeek answer' }] }),
    createAssistantMessage({ source: { provider: chatProviderId('claude'), model: `${project.id}/claude/claude-model` }, content: [{ type: 'text', text: 'Claude CLI answer' }] })];
  const back = user('Back to the CLI');
  await collect(adapter.stream({ ...first, messages: [...first.messages, own, follow, own, ...detour, back] }));
  const prompt = sent();
  assert.match(prompt, /^Conversation context \(already occurred; do not repeat completed actions\):\nuser: Ask DeepSeek instead\n\nassistant: DeepSeek answer\n\nassistant: Claude CLI answer\n\nCurrent user request:\nBack to the CLI$/);
  assert.doesNotMatch(prompt, /First reply from the CLI|Now run the linter/);

  // The message sent last was edited and resent, so DSH no longer has it: the CLI's latest reply still bounds the context.
  const edited = user('Back to the CLI, edited');
  await collect(adapter.stream({ ...first, messages: [user('Fix the tests, edited'), own, follow, own, ...detour, own, edited] }));
  assert.equal(sent(), 'Back to the CLI, edited', 'nothing the CLI already saw is sent again');
});

/** What DSH's chat shows of a reply: `block-start` empties a block, deltas append to it and `block-end` replaces it, closed or not. */
function shown(chunks: readonly StreamChunk[]) {
  const blocks: { kind: string; text: string }[] = [];
  for (const chunk of chunks) {
    if (chunk.type === 'block-start') blocks[chunk.index] = { kind: chunk.blockType, text: '' };
    if (chunk.type === 'text-delta') blocks[chunk.index] = { kind: 'text', text: (blocks[chunk.index]?.kind === 'text' ? blocks[chunk.index].text : '') + chunk.text };
    if (chunk.type === 'reasoning-delta') blocks[chunk.index] = { kind: 'reasoning', text: (blocks[chunk.index]?.kind === 'reasoning' ? blocks[chunk.index].text : '') + chunk.text };
    if (chunk.type === 'block-end') blocks[chunk.index] = { kind: chunk.block.type, text: chunk.block.type === 'text' || chunk.block.type === 'reasoning' ? chunk.block.text : '' };
  }
  const part = (kind: string) => blocks.filter(b => b.kind === kind && b.text.trim()).map(b => b.text.trim());
  return { reply: part('text'), reasoning: part('reasoning') };
}
/** Everything DSH's chat showed as the chunks arrived, and what DSH saves of them when the turn ends or is stopped at each point. */
function replay(chunks: readonly StreamChunk[]) {
  const assembler = new BlockAssembler(), screens: string[] = [], stopped: string[] = [];
  chunks.forEach((chunk, index) => {
    assembler.push(chunk); screens.push(shown(chunks.slice(0, index + 1)).reply.join('\n\n'));
    stopped.push(...assembler.interruptedBlocks().flatMap(b => b.type === 'text' || b.type === 'reasoning' ? [b.text] : []));
  });
  const saved = assembler.blocks().filter(b => b.type === 'text' || b.type === 'reasoning').map(b => ({ type: b.type, text: (b as { text: string }).text }));
  return { screens, stopped, saved };
}
async function claudeSetup(t: TestContext, overrides: Partial<ChatHost> = {}) {
  const session = Session.create(SessionId('claude-rows'));
  session.append('turn/start', { turn: 1 }); session.append('step/start', { turn: 1, step: 1 });
  const context = await setup(t, { step: () => ({ session, turn: 1, step: 1 }), ...overrides });
  context.remote.catalog[1] = { id: 'claude', label: 'Claude Code', status: 'ready', models: [{ id: 'claude-model', label: 'Claude model' }], modes: [] };
  await context.projects.refresh(context.project.id);
  const claude = (prompt: string) => context.options(prompt, { provider: chatProviderId('claude'), model: chatModelId(context.project.id, 'claude', 'claude-model') });
  return { ...context, claude };
}

test('Claude’s progress sentences read as the reply, each its own paragraph, while Codex’s reasoning stays folded', async t => {
  const { adapter, remote, claude, options } = await claudeSetup(t);
  const output = (id: string) => {
    remote.append(id, { type: 'reasoning', text: '' });
    remote.append(id, { type: 'assistant_message', text: 'Looking.' });
    remote.append(id, { type: 'reasoning', text: 'Port 4174 is ' }); remote.append(id, { type: 'reasoning', text: 'idle.' });
    // An empty delta belongs to the hidden thinking between two sentences.
    remote.append(id, { type: 'reasoning', text: '' });
    remote.append(id, { type: 'reasoning', text: 'The build passed.' });
    remote.append(id, { type: 'assistant_message', text: 'All done.' });
  };
  remote.onCreate = agent => output(agent.id);
  const fromClaude = replay(await collect(adapter.stream(claude('Check the port'))));
  assert.deepEqual(fromClaude.saved, [{ type: 'text', text: 'Looking.' }, { type: 'text', text: 'Port 4174 is idle.' }, { type: 'text', text: 'The build passed.' }, { type: 'text', text: 'All done.' }]);
  remote.onCreate = agent => output(agent.id);
  const fromCodex = replay(await collect(adapter.stream(options('Check the port', { sessionId: SessionId('codex-conversation') }))));
  assert.deepEqual(fromCodex.saved.filter(b => b.type === 'reasoning').map(b => b.text), ['Port 4174 is idle.The build passed.']);
});

for (const [who, overrides] of [
  ['a delegated subagent', { unattended: () => true }],
  ['a team member', { teamMember: () => ({ team: 'crew', name: 'coder' }) }],
] as [string, Partial<ChatHost>][]) test(`${who}’s result holds no progress sentences, though the running tool still shows`, async t => {
  const { adapter, remote, claude } = await claudeSetup(t, overrides);
  remote.onCreate = agent => {
    remote.append(agent.id, { type: 'reasoning', text: 'Checking the port.' });
    remote.append(agent.id, { type: 'tool_call', callId: 'tool-1', name: 'Bash', status: 'running', detail: { command: 'ls' } });
    remote.append(agent.id, { type: 'tool_call', callId: 'tool-1', name: 'Bash', status: 'completed', detail: 'a.ts' });
    remote.append(agent.id, { type: 'assistant_message', text: 'The result.' });
  };
  const { screens, saved } = replay(await collect(adapter.stream(claude('Check the port'))));
  assert.ok(screens.includes('> Running Bash · `ls`'), screens.join('\n---\n'));
  assert.deepEqual(saved.filter(block => block.type === 'text' && block.text), [{ type: 'text', text: 'The result.' }]);
  assert.deepEqual(saved.filter(block => block.type === 'reasoning').map(block => block.text), ['Checking the port.']);
});

test('thinking too long to be a progress sentence stays folded', async t => {
  const { adapter, remote, claude } = await claudeSetup(t);
  remote.onCreate = agent => {
    remote.append(agent.id, { type: 'reasoning', text: 'a'.repeat(900) });
    remote.append(agent.id, { type: 'reasoning', text: 'b'.repeat(900) });
    remote.append(agent.id, { type: 'assistant_message', text: 'Answer.' });
    remote.append(agent.id, { type: 'tool_call', callId: 'tool-1', name: 'Bash', status: 'running', detail: { command: 'ls' } });
    remote.append(agent.id, { type: 'reasoning', text: 'A new sentence.' });
  };
  assert.deepEqual(replay(await collect(adapter.stream(claude('Think')))).saved, [
    { type: 'text', text: 'a'.repeat(900) }, { type: 'reasoning', text: 'b'.repeat(900) }, { type: 'text', text: 'Answer.' }, { type: 'text', text: 'A new sentence.' },
  ]);
});

test('the tool Claude is running shows at the end of the reply, and DSH never saves it, even when stopped', async t => {
  const { adapter, remote, claude } = await claudeSetup(t);
  remote.onCreate = agent => {
    remote.append(agent.id, { type: 'assistant_message', text: 'Looking.' });
    remote.append(agent.id, { type: 'tool_call', callId: 'tool-1', name: 'Bash', status: 'running', detail: { command: 'pnpm test' } });
    remote.append(agent.id, { type: 'tool_call', callId: 'tool-2', name: 'Read', status: 'running', detail: { file_path: '/srv/a.ts' } });
    remote.append(agent.id, { type: 'tool_call', callId: 'tool-1', name: 'Bash', status: 'completed', detail: '42 pass' });
    remote.append(agent.id, { type: 'tool_call', callId: 'tool-2', name: 'Read', status: 'completed', detail: 'code' });
    remote.append(agent.id, { type: 'tool_call', callId: 'tool-3', name: 'Grep', status: 'running', detail: { pattern: 'foo' } });
    remote.append(agent.id, { type: 'assistant_message', text: 'Done.' });
  };
  const { screens, stopped, saved } = replay(await collect(adapter.stream(claude('Run the tests'))));
  const seen = [...new Set(screens)];
  assert.ok(seen.includes('Looking.\n\n> Running Bash · `pnpm test`'), seen.join('\n---\n'));
  assert.ok(seen.includes('Looking.\n\n> Running Read · `/srv/a.ts` (1 more running)'), seen.join('\n---\n'));
  assert.ok(seen.includes('Looking.\n\n> Running Grep · `foo`'), seen.join('\n---\n'));
  assert.equal(screens.at(-1), 'Looking.\n\nDone.', 'the line is gone when the reply ends');
  assert.ok(!stopped.some(block => block.includes('Running')), 'a Stop at any moment keeps no status');
  assert.deepEqual(saved, [{ type: 'text', text: 'Looking.' }, { type: 'text', text: 'Done.' }]);
});

test('a tool Claude runs before writing anything shows too, in the language of the message, and leaves nothing to read', async t => {
  const { adapter, remote, claude } = await claudeSetup(t);
  remote.onCreate = agent => {
    remote.append(agent.id, { type: 'tool_call', callId: 'tool-1', name: 'Bash', status: 'running', detail: { command: 'ls' } });
    remote.append(agent.id, { type: 'tool_call', callId: 'tool-1', name: 'Bash', status: 'completed', detail: 'a.ts' });
  };
  const { screens, stopped, saved } = replay(await collect(adapter.stream(claude('看看目录'))));
  assert.ok(screens.includes('> 正在运行 Bash · `ls`'), screens.join('\n---\n'));
  assert.equal(screens.at(-1), '');
  assert.deepEqual(stopped, [], 'a Stop saves no reply at all');
  assert.ok(saved.every(block => !block.text.trim()), 'what DSH saves shows nothing');
});

test('a failed turn does not leave the running tool on screen', async t => {
  const { adapter, remote, claude } = await claudeSetup(t);
  remote.onCreate = agent => {
    remote.append(agent.id, { type: 'assistant_message', text: 'Looking.' });
    remote.append(agent.id, { type: 'tool_call', callId: 'tool-1', name: 'Bash', status: 'running', detail: { command: 'ls' } });
    remote.append(agent.id, { type: 'error', message: 'Claude turn failed' });
  };
  const chunks: StreamChunk[] = [];
  await assert.rejects((async () => { for await (const chunk of adapter.stream(claude('Run'))) chunks.push(chunk); })(), /Claude turn failed/);
  assert.equal(replay(chunks).screens.at(-1), 'Looking.');
});

test('Codex replies show no running-tool line', async t => {
  const { adapter, remote, options } = await setup(t);
  remote.onCreate = agent => {
    remote.append(agent.id, { type: 'assistant_message', text: 'Looking.' });
    remote.append(agent.id, { type: 'tool_call', callId: 'tool-1', name: 'Bash', status: 'running', detail: { command: 'ls' } });
    remote.append(agent.id, { type: 'tool_call', callId: 'tool-1', name: 'Bash', status: 'completed', detail: 'a.ts' });
  };
  assert.deepEqual([...new Set(replay(await collect(adapter.stream(options()))).screens)], ['', 'Looking.']);
});

test('the running-tool line names the tool’s target on one short line that markdown cannot break', () => {
  const call = (name: string, detail: unknown) => ({ type: 'tool_call' as const, callId: name, name, status: 'running', detail });
  assert.equal(toolStatus([], 'Fix'), '');
  assert.equal(toolStatus([call('Bash', { command: 'pnpm  test\n  --watch', description: 'Run tests' })], 'Fix'), '> Running Bash · `pnpm test --watch`');
  assert.equal(toolStatus([call('Bash', { command: 'echo `date`' })], 'Fix'), "> Running Bash · `echo 'date'`");
  assert.equal(toolStatus([call('Skill', {})], 'Fix'), '> Running Skill');
  assert.equal(toolStatus([call('Other', 'not an object')], '修复'), '> 正在运行 Other');
  assert.equal(toolStatus([call('Read', { file_path: '/a' }), call('Agent', { description: 'Look around' })], '修复'), '> 正在运行 Agent · `Look around`（另有 1 个工具在运行）');
  const long = toolStatus([call('Bash', { command: 'x'.repeat(500) })], 'Fix');
  assert.equal(long, `> Running Bash · \`${'x'.repeat(100)}…\``);
});
