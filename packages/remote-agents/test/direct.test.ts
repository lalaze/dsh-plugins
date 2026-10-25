import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SshBackend, CLI_PROVIDERS } from '../src/backend.js';
import { JsonlPeer, quote, type Child, type SshTransport, type WireMessage } from '../src/ssh.js';
import { Store } from '../src/store.js';
import { TaskHistory } from '../src/history.js';
import { RemoteAgentsService } from '../src/service.js';
import { claimClaudeRuntime } from '../../claude-ssh/src/runtime-owner.js';
import { decodeAntigravityModels } from '../src/antigravity.js';

class FakeCli implements Child {
  sent: WireMessage[] = [];
  stopped = false;
  data: ((data: Buffer) => void)[] = [];
  exits: ((error: Error) => void)[] = [];
  prompt?: WireMessage;
  configOptions?: any[];
  readonly conversationId: string;
  constructor(readonly provider: string, readonly argv: string[], readonly transport: FakeSsh) {
    this.conversationId = argv.includes('--conversation') ? argv[argv.indexOf('--conversation') + 1] : randomUUID();
    if (provider === 'agy') queueMicrotask(() => this.emit({ event: 'init', conversation_id: this.conversationId, init: {} }));
  }
  write(line: string) {
    const m = JSON.parse(line); this.sent.push(m);
    queueMicrotask(() => this.handle(m));
  }
  emit(message: WireMessage) { for (const fn of this.data) fn(Buffer.from(JSON.stringify(message) + '\n')); }
  reply(m: WireMessage, result: unknown) { this.emit({ jsonrpc: '2.0', id: m.id, result }); }
  control(m: WireMessage, response: unknown) { this.emit({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response } }); }
  handle(m: WireMessage) {
    if (this.stopped) return;
    if (m.event === 'dsh_interrupt') { this.emit({ event: 'result', result: { status: 'ERROR', error: 'cancelled' } }); this.exit(new Error('Antigravity interrupted')); return; }
    if (m.type === 'control_request') {
      if (m.request.subtype === 'interrupt') this.finish();
      this.control(m, m.request.subtype === 'list_models' ? { models: [{ value: 'claude-remote', displayName: 'Claude remote', supportedEffortLevels: ['high'] }] } : {});
      return;
    }
    if (m.type === 'user' || m.event === 'user' || m.method === 'turn/start' || m.method === 'session/prompt') {
      this.prompt = m;
      this.transport.admissions.push({ provider: this.provider, binding: this.transport.store?.snapshot().tasks.at(-1)?.native });
      if (this.transport.dropPrompt) { this.exit(new Error('Connection lost after prompt write')); return; }
      if (m.method === 'turn/start') this.reply(m, { turn: { id: 'turn-remote' } });
      return;
    }
    if (m.method === 'initialize') this.reply(m, this.provider === 'codex' ? { userAgent: 'fake-codex' } : { protocolVersion: 1, agentCapabilities: this.provider === 'dsh' ? { sessionCapabilities: { resume: {}, close: {} } } : { loadSession: this.transport.loadSession } });
    if (m.method === 'model/list') this.reply(m, { data: [{ id: 'model-id', model: this.transport.model, displayName: 'Remote model', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }], nextCursor: null });
    if (m.method === 'thread/start' || m.method === 'thread/resume') this.reply(m, { thread: { id: m.params.threadId ?? 'thread-remote' } });
    if (m.method === 'session/new' || m.method === 'session/load' || m.method === 'session/resume') {
      this.configOptions = structuredClone(this.transport.configOptions);
      this.reply(m, { sessionId: m.params.sessionId ?? 'acp-session', configOptions: this.configOptions, models: this.transport.acpModels ? { currentModelId: 'acp-remote', availableModels: [{ modelId: 'acp-remote', name: 'ACP remote' }] } : undefined, modes: this.transport.acpModes ? { currentModeId: 'ask', availableModes: [{ id: 'ask', name: 'Ask' }] } : undefined });
    }
    if (m.method === 'session/set_config_option') {
      const option = this.configOptions!.find(o => o.id === m.params.configId)!;
      option.currentValue = m.params.value;
      if (option.category === 'model') {
        const thought = this.configOptions!.find(o => o.category === 'thought_level')!;
        thought.currentValue = m.params.value === 'acp-next' ? 'max' : 'high';
        thought.options = (m.params.value === 'acp-next' ? ['low', 'max'] : ['low', 'high']).map(value => ({ value, name: value }));
      }
      this.reply(m, { configOptions: this.configOptions });
    }
    if (m.method === 'session/set_model' || m.method === 'session/set_mode') this.reply(m, {});
    if (m.method === 'session/close') this.reply(m, {});
    if (m.method === 'turn/interrupt') { this.reply(m, {}); this.emit({ method: 'turn/completed', params: { turn: { id: 'turn-remote', status: 'interrupted' } } }); }
    if (m.method === 'session/cancel') this.finish();
  }
  finish() {
    if (this.provider === 'agy') {
      this.emit({ event: 'step_update', step_update: { step_type: 'agent_response', step_index: 1, text_delta: '远程结果 🌏', state: 'DONE' } });
      this.emit({ event: 'result', result: { conversation_id: this.conversationId, status: 'SUCCESS', response: '远程结果 🌏' } });
    } else if (this.provider === 'codex') {
      this.emit({ method: 'item/agentMessage/delta', params: { delta: '远程结果 🌏' } });
      this.emit({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
    } else if (this.provider === 'claude') {
      this.emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '远程结果 🌏' } } });
      this.emit({ type: 'assistant', message: { content: [{ type: 'text', text: '远程结果 🌏' }] } });
      this.emit({ type: 'result', subtype: 'success' });
    } else {
      this.emit({ method: 'session/update', params: { sessionId: 'acp-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '远程结果 🌏' } } } });
      if (this.prompt) this.reply(this.prompt, { stopReason: 'end_turn' });
    }
  }
  exit(error: Error) { if (this.stopped) return; this.stopped = true; for (const fn of this.exits) fn(error); }
  stop() { this.exit(new Error('CLI closed')); }
  onData(fn: (data: Buffer) => void) { this.data.push(fn); }
  onExit(fn: (error: Error) => void) { this.exits.push(fn); }
}
class FakeSsh implements SshTransport {
  children: FakeCli[] = [];
  scripts: string[] = [];
  admissions: { provider: string; binding: unknown }[] = [];
  model = 'codex-remote'; loadSession = true; acpModels = true; acpModes = true; dropPrompt = false;
  configOptions?: any[];
  store?: Store;
  constructor(readonly installed = ['codex']) {}
  async exec(script: string) {
    this.scripts.push(script);
    if (script.includes('uname -n')) return 'machine\0builder\0machine-id-1\0';
    if (script === 'node --version') return 'v22.23.2\n';
    if (script.endsWith("' models")) return 'Fetching available models...\nagy-remote\tAntigravity remote\n';
    return '/srv/canonical\0' + CLI_PROVIDERS.map(p => `${p.id}\0${this.installed.includes(p.id) ? `/usr/bin/${p.command}` : ''}\0`).join('');
  }
  start(_cwd: string, argv: string[]) {
    const command = argv[0] === 'node' ? argv[argv.indexOf('--') + 1] : argv[0];
    const child = new FakeCli(command.split('/').at(-1)!, argv, this); this.children.push(child); return child;
  }
  get live() { return this.children.findLast(c => !c.stopped)!; }
}
async function fixture(t: TestContext, provider = 'codex') {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-direct-'));
  const store = new Store(join(directory, 'state.json')); await store.open();
  const ssh = new FakeSsh([provider]); ssh.store = store;
  let backend!: SshBackend;
  const service = new RemoteAgentsService(store, host => backend = new SshBackend(host, store, ssh));
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  const hostId = (await service.addHost({ label: 'SSH host', connection: 'builder@machine' })).hosts[0].id;
  const request = { id: randomUUID(), hostId, cwd: '/srv/project', provider, model: provider === 'codex' ? ssh.model : provider === 'claude' ? 'claude-remote' : provider === 'antigravity' ? 'agy-remote' : 'acp-remote', prompt: 'Fix remote project' };
  return { directory, store, ssh, service, hostId, request, backend: () => backend };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('SSH discovery asks each installed native CLI for models without sending a prompt', async t => {
  const { ssh, service, hostId } = await fixture(t);
  ssh.installed.splice(0, 1, 'codex', 'claude', 'dsh', 'antigravity', 'grok', 'codebuddy');
  const catalog = await service.providers(hostId, "/srv/project's $(touch ignored)");
  assert.equal(catalog.length, 6); assert.ok(catalog.every(p => p.status === 'ready'));
  assert.equal(catalog.find(p => p.id === 'claude')!.models[0].thinkingOptions![0].id, 'high');
  assert.equal(ssh.admissions.length, 0);
  assert.ok(ssh.children.every(c => c.stopped));
  assert.deepEqual(ssh.children.find(c => c.provider === 'dsh')!.argv.slice(1), ['--profile', 'acp']);
  assert.deepEqual(ssh.children.find(c => c.provider === 'grok')!.argv.slice(1), ['agent', '--no-leader', 'stdio']);
  assert.deepEqual(ssh.children.find(c => c.provider === 'codebuddy')!.argv.slice(1), ['--acp']);
  assert.ok(ssh.scripts.some(s => s.includes(quote("/srv/project's $(touch ignored)"))));
});

test('Codex binding is durable before inference; permissions, output, follow-ups and cancel use app-server', async t => {
  const { service, ssh, request, store } = await fixture(t);
  const task = await service.create({ ...request, modeId: 'workspace-write', thinkingOptionId: 'high' });
  const cli = ssh.live;
  assert.equal(ssh.admissions.length, 1);
  assert.deepEqual((ssh.admissions[0].binding as any).sessionId, 'thread-remote');
  assert.equal((ssh.admissions[0].binding as any).initialSent, true);
  assert.equal(cli.argv[1], 'app-server');
  assert.equal(cli.sent.find(m => m.method === 'turn/start')!.params.effort, 'high');
  cli.emit({ id: 42, method: 'item/commandExecution/requestApproval', params: { command: 'pnpm test', availableDecisions: ['accept', 'decline'] } });
  let detail = await service.detail(task.id); assert.equal(detail.agent!.pendingPermissions[0].id, 'rpc-42');
  await service.respond(task.id, 'rpc-42', { behavior: 'allow', selectedActionId: 'accept' });
  assert.deepEqual(cli.sent.find(m => m.id === 42)!.result, { decision: 'accept' });
  cli.finish(); await tick();
  detail = await service.detail(task.id);
  assert.equal(detail.agent!.status, 'idle');
  assert.equal(detail.timeline!.entries.filter(e => e.item.type === 'assistant_message').length, 1);
  const message = { id: randomUUID(), text: 'Review again' };
  await service.send(task.id, message); await service.send(task.id, message);
  assert.equal(ssh.admissions.length, 2);
  await service.stop(task.id); assert.ok(cli.sent.some(m => m.method === 'turn/interrupt'));
  assert.equal(store.snapshot().tasks[0].native!.initialConfirmed, true);
});

test('restart resumes the saved native thread without replaying an uncertain prompt', async t => {
  const { ssh, service, request, store } = await fixture(t); ssh.dropPrompt = true;
  const task = await service.create({ ...request, modeId: 'read-only' }); await tick();
  assert.equal(ssh.admissions.length, 1); await service.close();
  const reopened = new Store(join(store.directory, 'state.json')); await reopened.open(); ssh.dropPrompt = false;
  const resumed = new RemoteAgentsService(reopened, host => new SshBackend(host, reopened, ssh)); t.after(() => resumed.close());
  assert.equal((await resumed.detail(task.id)).agent!.status, 'closed');
  await resumed.retry(task.id);
  assert.equal(ssh.admissions.length, 1);
  const resumedParams = ssh.live.sent.find(m => m.method === 'thread/resume')!.params;
  assert.equal(resumedParams.threadId, 'thread-remote');
  assert.equal(resumedParams.sandbox, 'read-only');
  assert.equal(resumedParams.approvalPolicy, 'on-request');
  assert.equal((await resumed.detail(task.id)).agent!.status, 'idle');
  assert.equal(reopened.snapshot().tasks[0].native!.initialConfirmed, undefined);
  assert.ok((await resumed.detail(task.id)).timeline!.entries.some(e => e.item.type === 'user_message'));
});

test('saved task output remains readable when its SSH host is unavailable', async t => {
  const { ssh, service, request, store } = await fixture(t);
  const task = await service.create(request); ssh.live.finish(); await tick(); await service.close();
  const reopened = new Store(join(store.directory, 'state.json')); await reopened.open();
  ssh.exec = async () => { throw new Error('SSH host is offline'); };
  const resumed = new RemoteAgentsService(reopened, host => new SshBackend(host, reopened, ssh)); t.after(() => resumed.close());
  const detail = await resumed.detail(task.id);
  assert.equal(detail.agent!.status, 'closed');
  assert.ok(detail.timeline!.entries.some(e => e.item.text === '远程结果 🌏'));
  await assert.rejects(resumed.retry(task.id), /SSH host is offline/);
  assert.equal(ssh.admissions.length, 1);
});

test('unloading during discovery cannot start a CLI after the backend has closed', async t => {
  const { ssh, service, hostId, request } = await fixture(t);
  const exec = ssh.exec.bind(ssh);
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const probing = new Promise<void>(resolve => { entered = resolve; });
  ssh.exec = async script => { if (script.startsWith('cd ')) { entered(); await blocked; } return exec(script); };
  const discovery = service.providers(hostId, request.cwd);
  await probing;
  const shutdown = service.close(); release();
  await assert.rejects(discovery, /backend has stopped/); await shutdown;
  assert.equal(ssh.children.length, 0);
});

for (const provider of ['grok', 'codebuddy']) test(`${provider} uses native ACP permission option IDs, model/mode configuration, cancellation and session recovery`, async t => {
  const { service, ssh, request } = await fixture(t, provider);
  const task = await service.create({ ...request, modeId: 'ask' }); const cli = ssh.live;
  cli.emit({ jsonrpc: '2.0', id: 77, method: 'session/request_permission', params: { sessionId: 'acp-session', toolCall: { title: 'Run checks' }, options: [{ optionId: 'remote-allow-once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'remote-reject', name: 'Reject', kind: 'reject_once' }] } });
  await service.respond(task.id, 'rpc-77', { behavior: 'allow', selectedActionId: 'remote-allow-once' });
  assert.deepEqual(cli.sent.find(m => m.id === 77)!.result, { outcome: { outcome: 'selected', optionId: 'remote-allow-once' } });
  assert.ok(cli.sent.some(m => m.method === 'session/set_mode' && m.params.modeId === 'ask'));
  await service.stop(task.id); assert.equal((await service.detail(task.id)).agent!.status, 'idle');
  cli.exit(new Error('SSH dropped')); await service.retry(task.id);
  assert.ok(ssh.live.sent.some(m => m.method === 'session/load' && m.params.sessionId === 'acp-session'));
  assert.equal(ssh.admissions.length, 1);
});

test('DSH discovers opaque ACP model routes, applies reasoning and resumes through session/resume without replay', async t => {
  const { service, ssh, request, hostId } = await fixture(t, 'dsh');
  ssh.acpModels = false; ssh.acpModes = false;
  ssh.configOptions = [
    { id: 'model', category: 'model', type: 'select', currentValue: 'route-a', options: [{ value: 'route-a', name: 'Remote provider A' }, { value: 'route-b', name: 'Remote provider B' }] },
    { id: 'reasoning_effort', category: 'thought_level', type: 'select', currentValue: 'high', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
  ];
  const provider = (await service.providers(hostId, request.cwd)).find(p => p.id === 'dsh')!;
  assert.deepEqual(provider.models.map(m => m.id), ['route-a', 'route-b']); assert.deepEqual(provider.modes, []);
  assert.ok(ssh.children[0].sent.some(m => m.method === 'session/close'));
  const task = await service.create({ ...request, model: 'route-b', thinkingOptionId: 'low' });
  assert.equal(task.state, 'ready');
  assert.ok(ssh.live.sent.some(m => m.method === 'session/set_config_option' && m.params.configId === 'reasoning_effort' && m.params.value === 'low'));
  assert.ok(!ssh.live.sent.some(m => m.method === 'session/set_mode' || m.method === 'session/set_model'));
  await service.stop(task.id);
  ssh.live.exit(new Error('SSH disconnected')); await service.retry(task.id);
  assert.ok(ssh.live.sent.some(m => m.method === 'session/resume' && m.params.sessionId === task.native!.sessionId));
  assert.ok(!ssh.live.sent.some(m => m.method === 'session/load'));
  assert.equal(ssh.admissions.length, 1);
});

test('ACP configOptions discover grouped models and per-model reasoning, and restore the selected configuration', async t => {
  const { service, ssh, request, hostId } = await fixture(t, 'codebuddy');
  ssh.configOptions = [
    { id: 'native-model', category: 'model', type: 'select', currentValue: 'acp-remote', options: [{ group: 'models', name: 'Models', options: [{ value: 'acp-remote', name: 'Remote' }, { value: 'acp-next', name: 'Next' }] }] },
    { id: 'native-mode', category: 'mode', type: 'select', currentValue: 'ask', options: [{ value: 'ask', name: 'Ask' }, { value: 'plan', name: 'Plan' }] },
    { id: 'native-effort', category: 'thought_level', type: 'select', currentValue: 'high', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
  ];
  const provider = (await service.providers(hostId, request.cwd)).find(p => p.id === 'codebuddy')!;
  assert.deepEqual(provider.models.map(m => m.id), ['acp-remote', 'acp-next']);
  assert.deepEqual(provider.models[1].thinkingOptions!.map(o => o.id), ['low', 'max']);
  assert.equal(provider.models[1].defaultThinkingOptionId, 'max');
  assert.equal(ssh.admissions.length, 0);
  const task = await service.create({ ...request, model: 'acp-next', modeId: 'plan', thinkingOptionId: 'low' });
  assert.equal(task.state, 'ready');
  const settings = () => ssh.live.sent.filter(m => m.method === 'session/set_config_option').map(m => [m.params.configId, m.params.value]);
  assert.deepEqual(settings(), [['native-model', 'acp-next'], ['native-mode', 'plan'], ['native-effort', 'low']]);
  assert.ok(!ssh.live.sent.some(m => m.method === 'session/set_model' || m.method === 'session/set_mode'));
  ssh.live.finish(); await tick(); ssh.live.exit(new Error('SSH dropped'));
  await service.retry(task.id);
  assert.deepEqual(settings(), [['native-model', 'acp-next'], ['native-mode', 'plan'], ['native-effort', 'low']]);
  assert.equal(ssh.admissions.length, 1);
});

test('ACP agents without model discovery use CLI default, and unsupported resume never resubmits', async t => {
  const { service, ssh, request, hostId } = await fixture(t, 'grok'); ssh.acpModels = false; ssh.loadSession = false;
  assert.equal((await service.providers(hostId, request.cwd)).find(p => p.id === 'grok')!.models[0].id, 'default');
  const task = await service.create({ ...request, model: 'default' }); ssh.live.finish(); await tick();
  ssh.live.exit(new Error('closed'));
  await assert.rejects(service.retry(task.id), /cannot resume/);
  assert.equal(ssh.admissions.length, 1);
});

test('Antigravity uses its native JSONL, persists the conversation before prompting, and interrupts through the SSH runner', async t => {
  const { service, ssh, request, hostId } = await fixture(t, 'antigravity');
  const provider = (await service.providers(hostId, request.cwd)).find(p => p.id === 'antigravity')!;
  assert.equal(provider.status, 'ready'); assert.match(provider.notice!, /interactive approval/);
  assert.deepEqual(decodeAntigravityModels('Fetching available models...\ngemini-model\tGemini model\nclaude-model\tClaude model\n').map(m => m.id), ['gemini-model', 'claude-model']);
  const task = await service.create({ ...request, modeId: 'plan' }), cli = ssh.live;
  assert.equal(task.state, 'ready');
  assert.equal(task.native!.sessionId, cli.conversationId);
  assert.equal((ssh.admissions[0].binding as any).sessionId, cli.conversationId);
  assert.equal((ssh.admissions[0].binding as any).initialSent, true);
  assert.deepEqual(cli.sent[0], { event: 'user', message: { content: request.prompt } });
  assert.equal(cli.argv[0], 'node'); assert.ok(cli.argv.includes('stream-json'));
  assert.equal(task.native!.argv[0], '/usr/bin/agy');
  cli.finish(); await tick();
  assert.equal((await service.detail(task.id)).timeline!.entries.filter(e => e.item.type === 'assistant_message').length, 1);
  await service.send(task.id, { id: randomUUID(), text: 'Continue the native conversation' });
  await service.stop(task.id);
  assert.ok(cli.sent.some(m => m.event === 'dsh_interrupt')); assert.ok(cli.stopped);
  assert.equal((await service.detail(task.id)).agent!.status, 'closed');
  await service.retry(task.id);
  assert.equal(ssh.live.argv[ssh.live.argv.indexOf('--conversation') + 1], task.native!.sessionId);
  assert.equal(ssh.admissions.length, 2);
  assert.ok(!ssh.live.sent.some(m => m.type === 'control_request' || m.method));
});

test('Antigravity reports a missing remote Node runtime without starting a task', async t => {
  const { service, ssh, request, hostId } = await fixture(t, 'antigravity');
  const exec = ssh.exec.bind(ssh); ssh.exec = async script => script === 'node --version' ? 'v20.0.0\n' : exec(script);
  const provider = (await service.providers(hostId, request.cwd)).find(p => p.id === 'antigravity')!;
  assert.equal(provider.status, 'error'); assert.match(provider.error!, /Node.js 22/);
  await assert.rejects(service.create(request), /CLI is not ready/);
  assert.equal(ssh.admissions.length, 0);
});

test('Claude streams once, returns structured questions and resumes its UUID over the same SSH transport', async t => {
  const { service, ssh, request } = await fixture(t, 'claude');
  const task = await service.create(request), cli = ssh.live;
  const sessionId = cli.argv[cli.argv.indexOf('--session-id') + 1]; assert.match(sessionId, /^[0-9a-f-]{36}$/);
  const questions = [{ header: 'Checks', question: 'Which checks should run?', options: [{ label: 'Tests' }] }, { header: 'Scope', question: 'Where should changes apply?', options: [{ label: 'Remote project' }] }];
  cli.emit({ type: 'control_request', request_id: 'question', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions } } });
  await service.respond(task.id, 'claude-question', { behavior: 'allow', answers: { Checks: 'Tests', Scope: 'Remote project' } });
  const updated = cli.sent.find(m => m.type === 'control_response')!.response.response.updatedInput;
  assert.deepEqual(updated.answers, { 'Which checks should run?': 'Tests', 'Where should changes apply?': 'Remote project' });
  assert.deepEqual(updated.questions, questions);
  cli.finish(); await tick();
  assert.equal((await service.detail(task.id)).timeline!.entries.filter(e => e.item.type === 'assistant_message').length, 1);
  cli.exit(new Error('disconnected')); await service.retry(task.id);
  assert.equal(ssh.live.argv[ssh.live.argv.indexOf('--resume') + 1], sessionId);
  assert.equal(ssh.admissions.length, 1);
});

test('completed sessions are reclaimed so a host can execute more than eight tasks and resume old tasks without replay', async t => {
  const { service, ssh, request } = await fixture(t);
  const tasks = [];
  for (let index = 0; index < 12; index++) {
    const task = await service.create({ ...request, id: randomUUID() });
    assert.equal(task.state, 'ready', task.error);
    tasks.push(task); ssh.live.finish(); await tick();
  }
  assert.equal(ssh.children.filter(c => !c.stopped).length, 8);
  assert.equal((await service.detail(tasks[0].id)).agent!.status, 'closed');
  const nativeId = tasks[0].native!.sessionId;
  await service.retry(tasks[0].id);
  assert.equal(ssh.live.sent.find(m => m.method === 'thread/resume')!.params.threadId, nativeId);
  assert.equal(ssh.admissions.length, 12);
  await service.send(tasks[0].id, { id: randomUUID(), text: 'Continue the first task' });
  assert.equal(ssh.admissions.length, 13);
});

test('session recycling never interrupts running tasks or pending approvals', async t => {
  const { service, ssh, request } = await fixture(t);
  const tasks = [];
  for (let index = 0; index < 8; index++) tasks.push(await service.create({ ...request, id: randomUUID() }));
  const live = ssh.children.filter(c => !c.stopped);
  live[0].emit({ id: 42, method: 'item/commandExecution/requestApproval', params: { command: 'pnpm test' } });
  const ninth = await service.create({ ...request, id: randomUUID() });
  assert.equal(ninth.state, 'uncertain');
  assert.match(ninth.error!, /eight open CLI sessions/);
  assert.ok(live.every(c => !c.stopped));
  assert.equal((await service.detail(tasks[0].id)).agent!.pendingPermissions.length, 1);
  live[1].finish(); await tick();
  assert.equal((await service.retry(ninth.id)).state, 'ready');
  assert.ok(live[1].stopped);
  assert.equal(live[0].stopped, false);
  assert.equal(ssh.admissions.length, 9);
});

test('session recycling protects a follow-up while its delivery record is being saved', async t => {
  const { service, ssh, request } = await fixture(t);
  const tasks = [];
  for (let index = 0; index < 8; index++) tasks.push(await service.create({ ...request, id: randomUUID() }));
  const first = ssh.children.find(c => !c.stopped)!, messageId = randomUUID();
  first.finish(); await tick();
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const original = TaskHistory.prototype.hasMessage;
  t.mock.method(TaskHistory.prototype, 'hasMessage', async function(this: TaskHistory, id: string) {
    if (id === messageId) { entered(); await blocked; }
    return original.call(this, id);
  });
  const send = service.send(tasks[0].id, { id: messageId, text: 'Continue while another task starts' });
  try {
    await waiting;
    assert.equal((await service.create({ ...request, id: randomUUID() })).state, 'uncertain');
    assert.equal(first.stopped, false);
  } finally { release(); await send; }
  assert.equal(ssh.admissions.length, 9);
});

test('JSONL preserves split UTF-8 and correlates replies; closing rejects in-flight requests', async () => {
  const ssh = new FakeSsh(), cli = new FakeCli('codex', [], ssh), peer = new JsonlPeer(cli);
  const messages: WireMessage[] = []; peer.onMessage(m => messages.push(m));
  const raw = Buffer.from(JSON.stringify({ method: 'event', params: { text: '🌏中文' } }) + '\n');
  const split = raw.indexOf(Buffer.from('🌏')) + 2;
  for (const fn of cli.data) { fn(raw.subarray(0, split)); fn(raw.subarray(split)); }
  assert.equal(messages[0].params.text, '🌏中文');
  const pending = peer.request('never-responds'); peer.close();
  await assert.rejects(pending, /connection closed/); assert.equal(cli.stopped, true);
});

test('history is durable, private, paginated and rejects truncated logs before appending', async t => {
  const { directory } = await fixture(t); const id = randomUUID(), history = new TaskHistory(directory, id); await history.open();
  await Promise.all(Array.from({ length: 205 }, (_, i) => history.append({ type: 'assistant_message', text: String(i) })));
  const page = await history.page(); assert.equal(page.entries.length, 100); assert.equal(page.startCursor!.seq, 106);
  assert.equal((await history.page(page.startCursor!, 'before')).entries.at(-1)!.seqEnd, 105);
  const reset = await history.page({ epoch: 'old', seq: 1 }); assert.equal(reset.reset, true);
  const path = join(directory, 'events', `${id}.jsonl`); assert.equal((await stat(path)).mode & 0o777, 0o600);
  const reopened = new TaskHistory(directory, id); await reopened.open(); assert.equal((await reopened.page()).endCursor!.seq, 205);
  const data = await readFile(path, 'utf8'); await writeFile(path, data.slice(0, -1));
  await assert.rejects(new TaskHistory(directory, id).open(), /incomplete record/);
});

test('standalone and embedded Claude engines share one provider ownership guard', () => {
  const provider = `test-${randomUUID()}`, first = {}, second = {};
  const release = claimClaudeRuntime(first, provider);
  assert.throws(() => claimClaudeRuntime(second, provider), /already enabled/);
  release(); const next = claimClaudeRuntime(second, provider); release();
  assert.throws(() => claimClaudeRuntime(first, provider), /already enabled/); next();
});
