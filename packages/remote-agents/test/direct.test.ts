import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SshBackend, CLI_PROVIDERS } from '../src/agents/backend.js';
import { JsonlPeer, quote, type Child, type SshTransport, type WireMessage } from '../src/core/ssh.js';
import { Store } from '../src/core/store.js';
import { TaskHistory } from '../src/agents/history.js';
import { RemoteAgentsService } from '../src/agents/service.js';
import { decodeAntigravityModels } from '../src/agents/antigravity.js';

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
      if (m.request.subtype === 'interrupt') { if (this.transport.claudeInterruptError) this.emit({ type: 'result', subtype: 'error_during_execution', is_error: true }); else this.finish(); }
      const usage: Record<string, unknown> = { initialize: { account: { email: 'dev@example.com', subscriptionType: 'Claude Pro' } }, get_context_usage: this.transport.claudeContext, get_usage: this.transport.claudeUsage };
      if (m.request.subtype === 'get_usage') this.transport.accountChecks.push(this.provider);
      this.control(m, m.request.subtype === 'list_models' ? { models: [{ value: 'claude-remote', displayName: 'Claude remote', supportedEffortLevels: ['high'] }] } : usage[m.request.subtype] ?? {});
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
    if (m.method === 'model/list') this.reply(m, { data: [{ id: 'model-id', model: this.transport.model, displayName: 'Remote model', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'high' }], ...this.transport.speeds }], nextCursor: null });
    if (m.method === 'thread/start' || m.method === 'thread/resume') this.reply(m, { thread: { id: m.params.threadId ?? 'thread-remote' } });
    if (m.method === 'account/read') this.reply(m, { account: { type: 'chatgpt', email: 'dev@example.com', planType: 'plus' } });
    if (m.method === 'account/rateLimits/read') { this.transport.accountChecks.push(this.provider); this.reply(m, { rateLimits: { limitId: 'codex', primary: { usedPercent: 18, windowDurationMins: 300 } } }); }
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
  model = 'codex-remote'; loadSession = true; acpModels = true; acpModes = true; dropPrompt = false; claudeInterruptError = false;
  configOptions?: any[];
  speeds: Record<string, unknown> = {};
  claudeContext?: unknown; claudeUsage?: unknown;
  accountChecks: string[] = [];
  store?: Store;
  missingPath?: string;
  constructor(readonly installed = ['codex']) {}
  async exec(script: string) {
    this.scripts.push(script);
    if (this.missingPath && script.startsWith(`cd ${quote(this.missingPath)} &&`)) throw new Error(`Remote directory does not exist: ${this.missingPath}`);
    if (script === 'printf \'%s\' "$HOME"') return '/home/builder';
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
const native = (store: Store, id: string) => store.snapshot().tasks.find(t => t.id === id)!.native!;
const types = (entries: { item: { type: string } }[]) => entries.map(e => e.item.type);

test('disabled CLI executables are never probed and changing selection invalidates the catalog cache', async t => {
  const { service, ssh, hostId, store } = await fixture(t);
  ssh.installed.push('codebuddy', 'antigravity');
  await store.update(s => { s.hosts[0].enabledProviders = ['codex']; });
  const first = await service.providers(hostId, '/srv/project');
  assert.deepEqual(first.map(p => p.id), ['codex']);
  assert.ok(ssh.children.every(c => c.provider === 'codex'));
  assert.ok(ssh.scripts.every(s => !s.includes("command -v 'agy'") && !s.includes("command -v 'codebuddy'")));
  const before = ssh.children.length;
  await store.update(s => { s.hosts[0].enabledProviders = ['codebuddy']; });
  const next = await service.providers(hostId, '/srv/project');
  assert.deepEqual(next.map(p => p.id), ['codebuddy']);
  assert.ok(ssh.children.slice(before).every(c => c.provider === 'codebuddy'));
  assert.equal(ssh.admissions.length, 0);
});

test('changing a model resumes the same native thread and preserves earlier output', async t => {
  const { service, ssh, request, store, hostId } = await fixture(t);
  const agent = await service.create(request); await tick(); ssh.live.finish(); await tick();
  const thread = native(store, agent.id).sessionId;
  ssh.model = 'codex-next'; await service.providers(hostId, request.cwd, true);
  await service.setModel(agent.id, 'codex-next', 'high');
  await service.send(agent.id, { id: randomUUID(), text: 'Continue with the new model' }, { interrupt: false }); await tick();
  assert.equal(native(store, agent.id).sessionId, thread);
  const resume = ssh.live.sent.find(m => m.method === 'thread/resume');
  assert.equal(resume?.params.threadId, thread); assert.equal(resume?.params.model, 'codex-next');
  assert.equal(ssh.live.sent.find(m => m.method === 'turn/start')?.params.effort, 'high');
  const timeline = (await service.detail(agent.id)).timeline!;
  assert.equal(timeline.entries.filter(e => e.item.type === 'user_message').length, 2);
  assert.ok(timeline.entries.some(e => e.item.text === '远程结果 🌏'));
});

test('Codex speed tiers come from the model catalog and apply to the thread and every turn', async t => {
  const { service, ssh, request, store, hostId } = await fixture(t);
  const tiers = async () => (await service.providers(hostId, request.cwd, true)).find(p => p.id === 'codex')!.models[0].serviceTiers;
  ssh.speeds = { additionalSpeedTiers: ['fast'] };
  assert.deepEqual(await tiers(), [{ id: 'fast', label: 'Fast' }], 'older CLIs only name their tiers');
  ssh.speeds = { additionalSpeedTiers: ['fast'], serviceTiers: [{ id: 'priority', name: 'Fast', description: '1.5x speed, increased usage' }] };
  assert.deepEqual(await tiers(), [{ id: 'priority', label: 'Fast' }]);
  await assert.rejects(service.create({ ...request, serviceTier: 'ultrafast' }), /speed is unavailable/);
  const agent = await service.create({ ...request, id: randomUUID(), serviceTier: 'priority' }); await tick();
  assert.equal(ssh.live.sent.find(m => m.method === 'thread/start')?.params.serviceTier, 'priority');
  assert.equal(ssh.live.sent.find(m => m.method === 'turn/start')?.params.serviceTier, 'priority');
  assert.equal((await service.summary(agent.id)).serviceTier, 'priority');
  ssh.live.finish(); await tick();
  const thread = native(store, agent.id).sessionId;
  await service.setModel(agent.id, request.model);
  await service.send(agent.id, { id: randomUUID(), text: 'Continue at the configured speed' }, { interrupt: false }); await tick();
  const resume = ssh.live.sent.find(m => m.method === 'thread/resume')!;
  assert.equal(resume.params.threadId, thread);
  assert.equal('serviceTier' in resume.params, false, 'the CLI configuration applies again');
  assert.equal('serviceTier' in ssh.live.sent.find(m => m.method === 'turn/start')!.params, false);
});

test('finished turns record their token usage in the timeline and report it once', async t => {
  for (const provider of ['claude', 'codex', 'grok']) {
    const { service, ssh, request, store } = await fixture(t, provider);
    const reports: { taskId: string; usage: unknown; failed: boolean; model?: string }[] = [];
    store.usageListeners.add((taskId, usage, turn) => reports.push({ taskId, usage, failed: turn.failed, model: turn.model }));
    const agent = await service.create(request); await tick();
    const live = ssh.live;
    if (provider === 'claude') {
      // The picker's alias resolves to a full model ID; subagents and Claude's own notices do not name the turn's model.
      live.emit({ type: 'assistant', parent_tool_use_id: null, message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Looking' }] } });
      live.emit({ type: 'assistant', parent_tool_use_id: 'task-1', message: { model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'Searching' }] } });
      live.emit({ type: 'assistant', parent_tool_use_id: null, message: { model: '<synthetic>', content: [{ type: 'text', text: 'Notice' }] } });
      live.emit({ type: 'result', subtype: 'success', usage: { input_tokens: 7, output_tokens: 90, cache_read_input_tokens: 4000 } });
    }
    if (provider === 'codex') {
      live.emit({ method: 'thread/tokenUsage/updated', params: { tokenUsage: { total: { inputTokens: 1000, cachedInputTokens: 600, outputTokens: 50, totalTokens: 1050 } } } });
      live.emit({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
    }
    if (provider === 'grok') live.reply(live.prompt!, { stopReason: 'end_turn', usage: { inputTokens: 30, outputTokens: 4, totalTokens: 34 } });
    await tick();
    const expected = provider === 'claude' ? { inputTokens: 7, outputTokens: 90, cacheReadTokens: 4000 } : provider === 'codex' ? { inputTokens: 400, outputTokens: 50, cacheReadTokens: 600, totalTokens: 1050 } : { inputTokens: 30, outputTokens: 4, totalTokens: 34 };
    assert.deepEqual(reports, [{ taskId: agent.id, usage: expected, failed: false, model: provider === 'claude' ? 'claude-opus-5-5' : undefined }], provider);
    const entries = (await service.detail(agent.id)).timeline!.entries;
    const at = types(entries).indexOf('usage');
    assert.ok(at >= 0 && at < types(entries).indexOf('turn_end'), `${provider}: usage is recorded before the turn ends`);
    assert.deepEqual(entries[at].item.usage, expected);
    if (provider === 'codex') {
      // The next turn reports only what it added to the thread's running totals.
      await service.send(agent.id, { id: randomUUID(), text: 'Continue' }); await tick();
      ssh.live.emit({ method: 'turn/started', params: { turn: { id: 'turn-2' } } });
      ssh.live.emit({ method: 'thread/tokenUsage/updated', params: { tokenUsage: { total: { inputTokens: 3000, cachedInputTokens: 2200, outputTokens: 80, totalTokens: 3080 } } } });
      ssh.live.emit({ method: 'turn/completed', params: { turn: { status: 'completed' } } }); await tick();
      assert.deepEqual(reports[1].usage, { inputTokens: 400, outputTokens: 30, cacheReadTokens: 1600, totalTokens: 2030 });
    }
    if (provider === 'claude') {
      // A turn that names no model leaves the record to the task's selection.
      await service.send(agent.id, { id: randomUUID(), text: 'Continue' }); await tick();
      ssh.live.emit({ type: 'result', subtype: 'success', usage: { input_tokens: 3, output_tokens: 5 } }); await tick();
      assert.equal(reports[1].model, undefined);
    }
  }
});

test('Codex context and cache snapshots survive detach, restart and resume without double counting', async t => {
  const { service, ssh, request, store } = await fixture(t);
  const route = `${request.hostId}/codex/codex-remote`;
  const agent = await service.create(request, { chat: { sessionId: 'chat-usage', route } }); await tick();
  const tokenUsage = { last: { inputTokens: 40_000, cachedInputTokens: 30_000, outputTokens: 2000 }, total: { inputTokens: 85_000, cachedInputTokens: 60_000, outputTokens: 5000 } };
  const report = { method: 'thread/tokenUsage/updated', params: { threadId: 'thread-remote', turnId: 'turn-remote', tokenUsage: { last: { ...tokenUsage.last, totalTokens: 42_000 }, total: { ...tokenUsage.total, totalTokens: 90_000 }, modelContextWindow: 258_000 } } };
  ssh.live.emit(report); ssh.live.emit(report);
  assert.deepEqual((await service.usage('chat-usage', { route }))?.context, { used: 42_000, max: 258_000 });
  assert.deepEqual((await service.usage('chat-usage', { route }))?.tokenUsage, tokenUsage, 'repeated reports replace rather than accumulate');
  await store.flush();
  assert.deepEqual(store.snapshot().tasks[0].tokenUsage, tokenUsage, 'request usage is saved during a running turn');
  ssh.live.finish(); await tick(); await store.flush();
  assert.deepEqual(store.snapshot().tasks[0].context, { used: 42_000, max: 258_000 });
  await service.archive(agent.id);
  assert.deepEqual((await service.usage('chat-usage', { route }))?.context, { used: 42_000, max: 258_000 });
  assert.deepEqual((await service.usage('chat-usage', { route }))?.tokenUsage, tokenUsage);
  const reopened = new Store(join(store.directory, 'state.json')); await reopened.open();
  assert.deepEqual(reopened.snapshot().tasks[0].tokenUsage, tokenUsage);
  await service.send(agent.id, { id: randomUUID(), text: 'Continue' }); await tick();
  ssh.live.emit({ method: 'thread/tokenUsage/updated', params: { tokenUsage: { last: { totalTokens: 50_000 }, modelContextWindow: 258_000 } } });
  assert.deepEqual((await service.usage('chat-usage', { route }))?.context, { used: 50_000, max: 258_000 });
  assert.equal((await service.usage('chat-usage', { route }))?.tokenUsage, undefined, 'a report without cache counters cannot show a stale hit');
  await store.flush();
  assert.equal(store.snapshot().tasks[0].tokenUsage, undefined);
});

test('Claude context and cache usage follow main-agent requests and survive detach', async t => {
  const { service, ssh, request, store } = await fixture(t, 'claude');
  const route = `${request.hostId}/claude/claude-remote`;
  ssh.claudeContext = { totalTokens: 12_000, maxTokens: 200_000 };
  const agent = await service.create(request, { chat: { sessionId: 'chat-claude', route } }); await tick();
  assert.deepEqual((await service.usage('chat-claude', { route }))?.context, { used: 12_000, max: 200_000 });
  ssh.live.emit({ type: 'assistant', parent_tool_use_id: null, message: { content: [], usage: { input_tokens: 5, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 1000, output_tokens: 300 } } });
  assert.deepEqual((await service.usage('chat-claude', { route }))?.context, { used: 21_305, max: 200_000 });
  const tokenUsage = { last: { inputTokens: 21_005, cachedInputTokens: 20_000, cacheWriteInputTokens: 1000, outputTokens: 300 } };
  assert.deepEqual((await service.usage('chat-claude', { route }))?.tokenUsage, tokenUsage);
  ssh.live.emit({ type: 'assistant', parent_tool_use_id: 'task-1', message: { content: [], usage: { input_tokens: 90_000 } } });
  assert.equal((await service.usage('chat-claude', { route }))?.context?.used, 21_305, 'subagents have their own context window');
  assert.deepEqual((await service.usage('chat-claude', { route }))?.tokenUsage, tokenUsage, 'subagents cannot replace the main request cache counts');
  ssh.claudeContext = { totalTokens: 22_000, maxTokens: 200_000 };
  ssh.live.finish(); await tick();
  assert.deepEqual((await service.summary(agent.id)).status, 'idle');
  assert.deepEqual((await service.usage('chat-claude', { route }))?.context, { used: 22_000, max: 200_000 });
  await store.flush();
  assert.deepEqual(store.snapshot().tasks[0].tokenUsage, tokenUsage);
  await service.archive(agent.id);
  assert.deepEqual((await service.usage('chat-claude', { route }))?.tokenUsage, tokenUsage);
  await service.send(agent.id, { id: randomUUID(), text: 'Continue' }); await tick();
  ssh.live.emit({ type: 'assistant', message: { content: [], usage: { input_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 5 } } });
  assert.deepEqual((await service.usage('chat-claude', { route }))?.tokenUsage?.last, { inputTokens: 200, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 5 });
});

test('ACP usage updates fill the ring', async t => {
  const { service, ssh, request } = await fixture(t, 'grok');
  const route = `${request.hostId}/grok/acp-remote`;
  await service.create(request, { chat: { sessionId: 'chat-acp', route } }); await tick();
  ssh.live.emit({ method: 'session/update', params: { sessionId: 'acp-session', update: { sessionUpdate: 'usage_update', used: 3000, size: 128_000 } } });
  assert.deepEqual((await service.usage('chat-acp', { route }))?.context, { used: 3000, max: 128_000 });
});

test('plan limits are read through a running CLI or a prompt-free probe, cached until a turn ends', async t => {
  const { service, ssh, request, hostId } = await fixture(t);
  const route = `${hostId}/codex/codex-remote`, target = { hostId, provider: 'codex' };
  const before = ssh.children.length;
  const probed = await service.usage('chat-limits', { route, target, account: true });
  assert.deepEqual(probed?.account?.windows, [{ id: 'codex:primary', label: 'Session', usedPercent: 18 }]);
  assert.equal(probed?.account?.email, 'dev@example.com'); assert.equal(probed?.account?.plan, 'Plus');
  assert.equal(ssh.children.length, before + 1); assert.ok(ssh.children.at(-1)!.stopped, 'the probe exits after reading');
  assert.equal(ssh.children.at(-1)!.sent.some(m => m.method === 'turn/start' || m.method === 'thread/start'), false);
  await service.usage('chat-limits', { route, target, account: true });
  assert.equal(ssh.accountChecks.length, 1, 'cached for five minutes');
  await service.create(request, { chat: { sessionId: 'chat-limits', route } }); await tick();
  const children = ssh.children.length;
  await service.usage('chat-limits', { route, account: true, refresh: true });
  assert.equal(ssh.accountChecks.length, 2); assert.equal(ssh.children.length, children, 'a running session answers without a new process');
  ssh.live.finish(); await tick();
  await service.usage('chat-limits', { route, account: true });
  assert.equal(ssh.accountChecks.length, 3, 'a finished turn changed the usage');
});

test('Claude plan limits come from its own /usage data on the SSH host', async t => {
  const { service, ssh, hostId } = await fixture(t, 'claude');
  ssh.claudeUsage = { subscription_type: 'pro', rate_limits: { five_hour: { utilization: 31, resets_at: '2026-10-26T22:50:00Z' }, seven_day: { utilization: 36 }, extra_usage: { is_enabled: false } } };
  const report = await service.usage('chat-claude-limits', { route: `${hostId}/claude/claude-remote`, target: { hostId, provider: 'claude' }, account: true });
  assert.deepEqual(report?.account?.windows.map(w => [w.label, w.usedPercent]), [['Session', 31], ['Weekly', 36]]);
  assert.equal(report?.account?.plan, 'Pro'); assert.equal(report?.account?.email, 'dev@example.com'); assert.equal(report?.account?.extraUsage, false);
  assert.deepEqual(ssh.children.at(-1)!.argv.slice(1), ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence']);
  assert.equal(ssh.admissions.length, 0, 'no prompt is sent');
});

test('Codex MCP tool approvals become permission prompts; other elicitations are declined', async t => {
  const { service, ssh, request } = await fixture(t);
  const agent = await service.create(request); await tick();
  const cli = ssh.live;
  cli.emit({ id: 7, method: 'mcpServer/elicitation/request', params: { threadId: 'thread-remote', serverName: 'github', mode: 'form', message: 'Allow github to create an issue?', requestedSchema: { type: 'object', properties: {} } } });
  const [permission] = (await service.detail(agent.id)).permissions;
  assert.equal(permission.id, 'rpc-7'); assert.equal(permission.name, 'MCP · github'); assert.equal(permission.description, 'Allow github to create an issue?');
  await service.respond(agent.id, 'rpc-7', { behavior: 'allow' });
  assert.deepEqual(cli.sent.find(m => m.id === 7)!.result, { action: 'accept', content: {}, _meta: null });
  cli.emit({ id: 8, method: 'mcpServer/elicitation/request', params: { threadId: 'thread-remote', serverName: 'github', mode: 'form', message: 'Allow again?', requestedSchema: { type: 'object', properties: {} } } });
  await service.respond(agent.id, 'rpc-8', { behavior: 'deny' });
  assert.deepEqual(cli.sent.find(m => m.id === 8)!.result, { action: 'decline', content: null, _meta: null });
  cli.emit({ id: 9, method: 'mcpServer/elicitation/request', params: { threadId: 'thread-remote', serverName: 'auth', mode: 'url', message: 'Sign in', url: 'https://example.com', elicitationId: 'e1' } });
  cli.emit({ id: 10, method: 'mcpServer/elicitation/request', params: { threadId: 'thread-remote', serverName: 'db', mode: 'form', message: 'Password?', requestedSchema: { type: 'object', properties: { password: { type: 'string' } }, required: ['password'] } } });
  assert.equal(cli.sent.find(m => m.id === 9)!.result.action, 'decline');
  assert.equal(cli.sent.find(m => m.id === 10)!.result.action, 'decline');
  assert.equal((await service.detail(agent.id)).permissions.length, 0);
});

test('a non-resumable CLI refuses a model change without closing its live session', async t => {
  const { service, ssh, request } = await fixture(t, 'grok'); ssh.loadSession = false;
  const agent = await service.create(request); await tick(); ssh.live.finish(); await tick();
  const before = ssh.live;
  await assert.rejects(service.setModel(agent.id, 'different-model'), /cannot resume/);
  assert.equal(before.stopped, false);
  await service.send(agent.id, { id: randomUUID(), text: 'Keep working' });
  assert.equal(ssh.live, before);
});

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
  const agent = await service.create({ ...request, modeId: 'workspace-write', thinkingOptionId: 'high' });
  const cli = ssh.live;
  assert.equal(ssh.admissions.length, 1);
  assert.deepEqual((ssh.admissions[0].binding as any).sessionId, 'thread-remote');
  assert.equal((ssh.admissions[0].binding as any).initialSent, true);
  assert.equal(cli.argv[1], 'app-server');
  assert.equal(cli.sent.find(m => m.method === 'turn/start')!.params.effort, 'high');
  cli.emit({ id: 42, method: 'item/commandExecution/requestApproval', params: { command: 'pnpm test', availableDecisions: ['accept', 'decline'] } });
  let detail = await service.detail(agent.id);
  assert.equal(detail.agent.status, 'attention'); assert.equal(detail.permissions[0].id, 'rpc-42');
  await service.respond(agent.id, 'rpc-42', { behavior: 'allow', selectedActionId: 'accept' });
  assert.deepEqual(cli.sent.find(m => m.id === 42)!.result, { decision: 'accept' });
  cli.finish(); await tick();
  detail = await service.detail(agent.id);
  assert.equal(detail.agent.status, 'idle');
  assert.equal(detail.timeline!.entries.filter(e => e.item.type === 'assistant_message').length, 1);
  assert.ok(detail.timeline!.entries.some(e => e.item.type === 'delivery' && e.item.clientMessageId === agent.id));
  assert.equal(await service.reply(agent.id), '远程结果 🌏');
  const message = { id: randomUUID(), text: 'Review again' };
  await service.send(agent.id, message); await service.send(agent.id, message);
  assert.equal(ssh.admissions.length, 2);
  await service.stop(agent.id); assert.ok(cli.sent.some(m => m.method === 'turn/interrupt'));
  assert.equal(native(store, agent.id).sessionId, 'thread-remote');
});

test('a message to a running Codex agent interrupts its turn natively before starting the next one', async t => {
  const { service, ssh, request } = await fixture(t);
  const agent = await service.create(request), cli = ssh.live;
  assert.equal((await service.summary(agent.id)).status, 'running');
  await service.send(agent.id, { id: randomUUID(), text: 'Stop that and run the linter' });
  const methods = cli.sent.map(m => m.method);
  assert.ok(methods.indexOf('turn/interrupt') > 0 && methods.indexOf('turn/interrupt') < methods.lastIndexOf('turn/start'));
  assert.equal(cli.sent.filter(m => m.method === 'turn/start').at(-1)!.params.input[0].text, 'Stop that and run the linter');
  const entries = types((await service.detail(agent.id)).timeline!.entries);
  assert.ok(entries.includes('interrupted')); assert.ok(!entries.includes('error'));
  assert.equal(ssh.admissions.length, 2); assert.equal(ssh.children.filter(c => !c.stopped).length, 1);
});

test('Claude reports a user interrupt as interrupted, not as a failed turn, and keeps its process', async t => {
  const { service, ssh, request } = await fixture(t, 'claude'); ssh.claudeInterruptError = true;
  const agent = await service.create(request), cli = ssh.live;
  await service.stop(agent.id);
  const detail = await service.detail(agent.id);
  assert.equal(detail.agent.status, 'idle'); assert.equal(cli.stopped, false);
  assert.deepEqual(types(detail.timeline!.entries).filter(t => t === 'error' || t === 'interrupted'), ['interrupted']);
});

test('restart resumes the saved native thread without replaying an uncertain prompt', async t => {
  const { ssh, service, request, store } = await fixture(t); ssh.dropPrompt = true;
  const agent = await service.create({ ...request, modeId: 'read-only' }); await tick();
  assert.equal(ssh.admissions.length, 1); await service.close();
  const reopened = new Store(join(store.directory, 'state.json')); await reopened.open(); ssh.dropPrompt = false;
  const resumed = new RemoteAgentsService(reopened, host => new SshBackend(host, reopened, ssh)); t.after(() => resumed.close());
  assert.equal((await resumed.detail(agent.id)).agent.status, 'idle', 'a detached resumable session is idle');
  await resumed.retry(agent.id);
  assert.equal(ssh.admissions.length, 1);
  const resumedParams = ssh.live.sent.find(m => m.method === 'thread/resume')!.params;
  assert.equal(resumedParams.threadId, 'thread-remote');
  assert.equal(resumedParams.sandbox, 'read-only');
  assert.equal(resumedParams.approvalPolicy, 'on-request');
  assert.equal(resumedParams.approvalsReviewer, 'user', 'a resumed thread drops a reviewer it had before');
  const detail = await resumed.detail(agent.id);
  assert.equal(detail.agent.status, 'idle');
  assert.ok(detail.timeline!.entries.some(e => e.item.type === 'user_message' && e.item.delivery === 'pending'));
  assert.ok(!detail.timeline!.entries.some(e => e.item.type === 'delivery'), 'the dropped prompt stays unconfirmed');
});

test('Codex inherit mode leaves approval policy and sandbox to the remote config', async t => {
  const { ssh, service, request } = await fixture(t);
  await service.create({ ...request, modeId: 'inherit' }); await tick();
  const params = ssh.live.sent.find(m => m.method === 'thread/start')!.params;
  assert.equal(params.approvalPolicy, undefined); assert.equal(params.sandbox, undefined); assert.equal(params.approvalsReviewer, undefined);
});

test('Codex auto review writes to the workspace and routes approval requests to its reviewer', async t => {
  const { ssh, service, request } = await fixture(t);
  await service.create({ ...request, modeId: 'auto-review' }); await tick();
  const params = ssh.live.sent.find(m => m.method === 'thread/start')!.params;
  assert.equal(params.sandbox, 'workspace-write'); assert.equal(params.approvalPolicy, 'on-request'); assert.equal(params.approvalsReviewer, 'auto_review');
});

test('saved agent output remains readable when its SSH host is unavailable', async t => {
  const { ssh, service, request, store } = await fixture(t);
  const agent = await service.create(request); ssh.live.finish(); await tick(); await service.close();
  const reopened = new Store(join(store.directory, 'state.json')); await reopened.open();
  ssh.exec = async () => { throw new Error('SSH host is offline'); };
  const resumed = new RemoteAgentsService(reopened, host => new SshBackend(host, reopened, ssh)); t.after(() => resumed.close());
  const detail = await resumed.detail(agent.id);
  assert.equal(detail.agent.status, 'idle');
  assert.ok(detail.timeline!.entries.some(e => e.item.text === '远程结果 🌏'));
  assert.equal(await resumed.reply(agent.id), '远程结果 🌏');
  await assert.rejects(resumed.retry(agent.id), /SSH host is offline/);
  await assert.rejects(resumed.send(agent.id, { id: randomUUID(), text: 'Continue' }), /SSH host is offline/);
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
  const agent = await service.create({ ...request, modeId: 'ask' }); const cli = ssh.live;
  cli.emit({ jsonrpc: '2.0', id: 77, method: 'session/request_permission', params: { sessionId: 'acp-session', toolCall: { title: 'Run checks' }, options: [{ optionId: 'remote-allow-once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'remote-reject', name: 'Reject', kind: 'reject_once' }] } });
  await service.respond(agent.id, 'rpc-77', { behavior: 'allow', selectedActionId: 'remote-allow-once' });
  assert.deepEqual(cli.sent.find(m => m.id === 77)!.result, { outcome: { outcome: 'selected', optionId: 'remote-allow-once' } });
  assert.ok(cli.sent.some(m => m.method === 'session/set_mode' && m.params.modeId === 'ask'));
  await service.stop(agent.id); assert.equal((await service.detail(agent.id)).agent.status, 'idle');
  cli.exit(new Error('SSH dropped')); await service.retry(agent.id);
  assert.ok(ssh.live.sent.some(m => m.method === 'session/load' && m.params.sessionId === 'acp-session'));
  assert.equal(ssh.admissions.length, 1);
});

test('DSH discovers opaque ACP model routes, applies reasoning and resumes through session/resume without replay', async t => {
  const { service, ssh, request, hostId, store } = await fixture(t, 'dsh');
  ssh.acpModels = false; ssh.acpModes = false;
  ssh.configOptions = [
    { id: 'model', category: 'model', type: 'select', currentValue: 'route-a', options: [{ value: 'route-a', name: 'Remote provider A' }, { value: 'route-b', name: 'Remote provider B' }] },
    { id: 'reasoning_effort', category: 'thought_level', type: 'select', currentValue: 'high', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
  ];
  const provider = (await service.providers(hostId, request.cwd)).find(p => p.id === 'dsh')!;
  assert.deepEqual(provider.models.map(m => m.id), ['route-a', 'route-b']); assert.deepEqual(provider.modes, []);
  assert.ok(ssh.children[0].sent.some(m => m.method === 'session/close'));
  const agent = await service.create({ ...request, model: 'route-b', thinkingOptionId: 'low' });
  assert.notEqual(agent.status, 'error', agent.error);
  assert.ok(ssh.live.sent.some(m => m.method === 'session/set_config_option' && m.params.configId === 'reasoning_effort' && m.params.value === 'low'));
  assert.ok(!ssh.live.sent.some(m => m.method === 'session/set_mode' || m.method === 'session/set_model'));
  await service.stop(agent.id);
  ssh.live.exit(new Error('SSH disconnected')); await service.retry(agent.id);
  assert.ok(ssh.live.sent.some(m => m.method === 'session/resume' && m.params.sessionId === native(store, agent.id).sessionId));
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
  const agent = await service.create({ ...request, model: 'acp-next', modeId: 'plan', thinkingOptionId: 'low' });
  assert.notEqual(agent.status, 'error', agent.error);
  const settings = () => ssh.live.sent.filter(m => m.method === 'session/set_config_option').map(m => [m.params.configId, m.params.value]);
  assert.deepEqual(settings(), [['native-model', 'acp-next'], ['native-mode', 'plan'], ['native-effort', 'low']]);
  assert.ok(!ssh.live.sent.some(m => m.method === 'session/set_model' || m.method === 'session/set_mode'));
  ssh.live.finish(); await tick(); ssh.live.exit(new Error('SSH dropped'));
  await service.retry(agent.id);
  assert.deepEqual(settings(), [['native-model', 'acp-next'], ['native-mode', 'plan'], ['native-effort', 'low']]);
  assert.equal(ssh.admissions.length, 1);
});

test('ACP agents without model discovery use CLI default, and unsupported resume never resubmits', async t => {
  const { service, ssh, request, hostId } = await fixture(t, 'grok'); ssh.acpModels = false; ssh.loadSession = false;
  assert.equal((await service.providers(hostId, request.cwd)).find(p => p.id === 'grok')!.models[0].id, 'default');
  const agent = await service.create({ ...request, model: 'default' }); ssh.live.finish(); await tick();
  ssh.live.exit(new Error('closed'));
  await assert.rejects(service.retry(agent.id), /cannot resume/);
  assert.equal(ssh.admissions.length, 1);
});

test('Antigravity uses its native JSONL, persists the conversation before prompting, and interrupts through the SSH runner', async t => {
  const { service, ssh, request, hostId, store } = await fixture(t, 'antigravity');
  const provider = (await service.providers(hostId, request.cwd)).find(p => p.id === 'antigravity')!;
  assert.equal(provider.status, 'ready'); assert.match(provider.notice!, /interactive approval/);
  assert.deepEqual(decodeAntigravityModels('Fetching available models...\ngemini-model\tGemini model\nclaude-model\tClaude model\n').map(m => m.id), ['gemini-model', 'claude-model']);
  const agent = await service.create({ ...request, modeId: 'plan' }), cli = ssh.live;
  assert.notEqual(agent.status, 'error', agent.error);
  assert.equal(native(store, agent.id).sessionId, cli.conversationId);
  assert.equal((ssh.admissions[0].binding as any).sessionId, cli.conversationId);
  assert.equal((ssh.admissions[0].binding as any).initialSent, true);
  assert.deepEqual(cli.sent[0], { event: 'user', message: { content: request.prompt } });
  assert.equal(cli.argv[0], 'node'); assert.ok(cli.argv.includes('stream-json'));
  assert.equal(native(store, agent.id).argv[0], '/usr/bin/agy');
  cli.finish(); await tick();
  assert.equal((await service.detail(agent.id)).timeline!.entries.filter(e => e.item.type === 'assistant_message').length, 1);
  await service.send(agent.id, { id: randomUUID(), text: 'Continue the native conversation' });
  await service.stop(agent.id);
  assert.ok(cli.sent.some(m => m.event === 'dsh_interrupt')); assert.ok(cli.stopped);
  assert.equal((await service.detail(agent.id)).agent.status, 'idle');
  await service.send(agent.id, { id: randomUUID(), text: 'Resume after the runner stopped' });
  assert.equal(ssh.live.argv[ssh.live.argv.indexOf('--conversation') + 1], native(store, agent.id).sessionId);
  assert.equal(ssh.admissions.length, 3);
  assert.ok(!ssh.live.sent.some(m => m.type === 'control_request' || m.method));
});

test('Antigravity reports a missing remote Node runtime without starting an agent', async t => {
  const { service, ssh, request, hostId } = await fixture(t, 'antigravity');
  const exec = ssh.exec.bind(ssh); ssh.exec = async script => script === 'node --version' ? 'v20.0.0\n' : exec(script);
  const provider = (await service.providers(hostId, request.cwd)).find(p => p.id === 'antigravity')!;
  assert.equal(provider.status, 'error'); assert.match(provider.error!, /Node.js 22/);
  await assert.rejects(service.create(request), /CLI is not ready/);
  assert.equal(ssh.admissions.length, 0);
});

test('Claude streams once, returns structured questions and resumes its UUID over the same SSH transport', async t => {
  const { service, ssh, request } = await fixture(t, 'claude');
  const agent = await service.create(request), cli = ssh.live;
  const sessionId = cli.argv[cli.argv.indexOf('--session-id') + 1]; assert.match(sessionId, /^[0-9a-f-]{36}$/);
  const questions = [{ header: 'Checks', question: 'Which checks should run?', options: [{ label: 'Tests' }] }, { header: 'Scope', question: 'Where should changes apply?', options: [{ label: 'Remote project' }] }];
  cli.emit({ type: 'control_request', request_id: 'question', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions } } });
  await service.respond(agent.id, 'claude-question', { behavior: 'allow', answers: { Checks: 'Tests', Scope: 'Remote project' } });
  const updated = cli.sent.find(m => m.type === 'control_response')!.response.response.updatedInput;
  assert.deepEqual(updated.answers, { 'Which checks should run?': 'Tests', 'Where should changes apply?': 'Remote project' });
  assert.deepEqual(updated.questions, questions);
  cli.finish(); await tick();
  assert.equal((await service.detail(agent.id)).timeline!.entries.filter(e => e.item.type === 'assistant_message').length, 1);
  cli.exit(new Error('disconnected')); await service.retry(agent.id);
  assert.equal(ssh.live.argv[ssh.live.argv.indexOf('--resume') + 1], sessionId);
  assert.equal(ssh.admissions.length, 1);
});

test('mode changes release the idle session, and the next message resumes it with the new mode', async t => {
  const { service, ssh, request } = await fixture(t, 'claude');
  const agent = await service.create(request), cli = ssh.live;
  cli.finish(); await tick();
  await service.setMode(agent.id, 'plan');
  assert.equal(cli.stopped, true);
  await service.send(agent.id, { id: randomUUID(), text: 'Plan the migration' });
  const argv = ssh.live.argv;
  assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'plan');
  assert.equal(argv[argv.indexOf('--resume') + 1], cli.argv[cli.argv.indexOf('--session-id') + 1]);
  assert.equal(ssh.admissions.length, 2);
});

test('Claude Auto is available for new sessions and is explicitly passed to the non-interactive CLI', async t => {
  const { service, ssh, request, hostId } = await fixture(t, 'claude');
  const provider = (await service.providers(hostId, request.cwd)).find(p => p.id === 'claude')!;
  assert.ok(provider.modes.some(m => m.id === 'auto'));
  await service.create({ ...request, modeId: 'auto' });
  assert.equal(ssh.live.argv[ssh.live.argv.indexOf('--permission-mode') + 1], 'auto');
  assert.equal(ssh.live.argv.includes('--dangerously-skip-permissions'), false);
});

test('pre-upgrade Claude sessions can select Auto and retain it across messages and reconnects', async t => {
  const { service, ssh, request, store } = await fixture(t, 'claude');
  const agent = await service.create(request), first = ssh.live;
  const sessionId = first.argv[first.argv.indexOf('--session-id') + 1];
  first.finish(); await tick();
  await store.update(state => { state.tasks.find(task => task.id === agent.id)!.modes = [{ id: 'default', label: 'Ask before tools' }]; });
  assert.ok((await service.summary(agent.id)).modes.some(m => m.id === 'auto'));
  await service.setMode(agent.id, 'auto');
  await service.send(agent.id, { id: randomUUID(), text: 'Continue with classifier checks' });
  assert.equal(ssh.live.argv[ssh.live.argv.indexOf('--permission-mode') + 1], 'auto');
  assert.equal(ssh.live.argv[ssh.live.argv.indexOf('--resume') + 1], sessionId);
  ssh.live.finish(); await tick();
  ssh.live.exit(new Error('disconnected')); await service.retry(agent.id);
  assert.equal(ssh.live.argv[ssh.live.argv.indexOf('--permission-mode') + 1], 'auto');
  assert.equal(ssh.live.argv[ssh.live.argv.indexOf('--resume') + 1], sessionId);
  assert.equal(store.snapshot().tasks[0].modeId, 'auto');
});

test('Claude inherits remote permission settings unless a mode is explicitly selected, including after resume', async t => {
  const { service, ssh, request, hostId, store } = await fixture(t, 'claude');
  const provider = (await service.providers(hostId, request.cwd)).find(p => p.id === 'claude')!;
  assert.equal(provider.defaultModeId, 'inherit');
  const agent = await service.create(request), first = ssh.live;
  assert.equal(first.argv.includes('--permission-mode'), false);
  first.finish(); await tick();
  await service.setMode(agent.id, 'acceptEdits');
  await service.send(agent.id, { id: randomUUID(), text: 'Edit files' });
  assert.equal(ssh.live.argv[ssh.live.argv.indexOf('--permission-mode') + 1], 'acceptEdits');
  ssh.live.finish(); await tick();
  // A pre-upgrade task saved its choices without the inherit option.
  await store.update(state => { const saved = state.tasks.find(task => task.id === agent.id)!; saved.modes = saved.modes!.filter(m => m.id !== 'inherit'); });
  assert.ok((await service.summary(agent.id)).modes.some(m => m.id === 'inherit'));
  await service.setMode(agent.id, 'inherit');
  await service.send(agent.id, { id: randomUUID(), text: 'Use remote settings again' });
  assert.equal(ssh.live.argv.includes('--permission-mode'), false);
  assert.equal(ssh.live.argv[ssh.live.argv.indexOf('--resume') + 1], first.argv[first.argv.indexOf('--session-id') + 1]);
});

for (const destination of ['session', 'localSettings']) test(`Claude forwards explicitly selected ${destination} approval rules without broadening one-time approvals`, async t => {
  const { service, ssh, request } = await fixture(t, 'claude');
  const agent = await service.create(request), cli = ssh.live;
  const suggestion = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'pnpm test *' }], behavior: 'allow', destination };
  const ask = (id: string) => cli.emit({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'pnpm test' }, permission_suggestions: [suggestion] } });
  ask('once');
  let permission = (await service.state(agent.id)).permissions[0];
  assert.equal(permission.actions?.length, 3);
  const remembered = permission.actions!.find(a => a.scope === (destination === 'session' ? 'session' : 'project'))!;
  assert.ok(remembered);
  assert.deepEqual(permission.detail, { input: { command: 'pnpm test' }, permissionSuggestions: [suggestion] });
  await service.respond(agent.id, permission.id, { behavior: 'allow', selectedActionId: 'once' });
  assert.deepEqual(cli.sent.find(m => m.response?.request_id === 'once')!.response.response, { behavior: 'allow', updatedInput: { command: 'pnpm test' } });
  ask('remember'); permission = (await service.state(agent.id)).permissions[0];
  await assert.rejects(service.respond(agent.id, permission.id, { behavior: 'allow', selectedActionId: 'not-offered' }), /Invalid permission action/);
  await service.respond(agent.id, permission.id, { behavior: 'allow', selectedActionId: remembered.id, updatedPermissions: [{ type: 'setMode', mode: 'bypassPermissions' }] });
  assert.deepEqual(cli.sent.find(m => m.response?.request_id === 'remember')!.response.response, { behavior: 'allow', updatedInput: { command: 'pnpm test' }, updatedPermissions: [suggestion] });
});

test('Claude does not offer persistent grants for suppressed, global, malformed or mode-changing suggestions', async t => {
  const { service, ssh, request } = await fixture(t, 'claude');
  const agent = await service.create(request), cli = ssh.live;
  const rule = { type: 'addRules', behavior: 'allow', destination: 'localSettings', rules: [{ toolName: 'Bash', ruleContent: 'pnpm test *' }] };
  for (const [index, extra] of [
    { suppress_always_allow_rule: true, permission_suggestions: [rule] },
    { permission_suggestions: [{ ...rule, destination: 'userSettings' }] },
    { permission_suggestions: [{ type: 'setMode', mode: 'bypassPermissions', destination: 'session' }] },
    { permission_suggestions: [{ ...rule, rules: [] }, { ...rule, behavior: 'deny' }, { ...rule, rules: [null] }] },
  ].entries()) {
    cli.emit({ type: 'control_request', request_id: `invalid-${index}`, request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'pnpm test' }, ...extra } });
    const permission = (await service.state(agent.id)).permissions[0];
    assert.equal(permission.actions?.some(a => a.scope !== 'once' && a.behavior === 'allow') ?? false, false);
    await service.respond(agent.id, permission.id, { behavior: 'deny' });
  }
});

for (const provider of ['codex', 'dsh']) test(`${provider} completed sessions are reclaimed, and messaging one resumes it without replay`, async t => {
  const { service, ssh, request, store } = await fixture(t, provider);
  const agents = [];
  for (let index = 0; index < 12; index++) {
    const agent = await service.create({ ...request, id: randomUUID() });
    assert.notEqual(agent.status, 'error', agent.error);
    agents.push(agent); ssh.live.finish(); await tick();
  }
  assert.equal(ssh.children.filter(c => !c.stopped).length, 8);
  const nativeId = native(store, agents[0].id).sessionId;
  await service.send(agents[0].id, { id: randomUUID(), text: 'Continue the first agent' });
  const resumed = ssh.live.sent.find(m => m.method === (provider === 'dsh' ? 'session/resume' : 'thread/resume'))!;
  assert.equal(provider === 'dsh' ? resumed.params.sessionId : resumed.params.threadId, nativeId);
  assert.equal(ssh.admissions.length, 13);
  assert.equal(ssh.children.filter(c => !c.stopped).length, 8);
});

test('session recycling never interrupts running agents or pending approvals', async t => {
  const { service, ssh, request } = await fixture(t);
  const agents = [];
  for (let index = 0; index < 8; index++) agents.push(await service.create({ ...request, id: randomUUID() }));
  const live = ssh.children.filter(c => !c.stopped);
  live[0].emit({ id: 42, method: 'item/commandExecution/requestApproval', params: { command: 'pnpm test' } });
  const ninth = await service.create({ ...request, id: randomUUID() });
  assert.equal(ninth.status, 'error');
  assert.match(ninth.error!, /8 working CLI sessions/);
  assert.ok(live.every(c => !c.stopped));
  assert.equal((await service.detail(agents[0].id)).permissions.length, 1);
  live[1].finish(); await tick();
  assert.notEqual((await service.retry(ninth.id)).status, 'error');
  assert.ok(live[1].stopped);
  assert.equal(live[0].stopped, false);
  assert.equal(ssh.admissions.length, 9);
});

test('session recycling protects a follow-up while its delivery record is being saved', async t => {
  const { service, ssh, request } = await fixture(t);
  const agents = [];
  for (let index = 0; index < 8; index++) agents.push(await service.create({ ...request, id: randomUUID() }));
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
  const send = service.send(agents[0].id, { id: messageId, text: 'Continue while another agent starts' });
  try {
    await waiting;
    assert.equal((await service.create({ ...request, id: randomUUID() })).status, 'error');
    assert.equal(first.stopped, false);
  } finally { release(); await send; }
  assert.equal(ssh.admissions.length, 9);
});

test('a failed registry write rejects a follow-up before sending and leaks no session lease', async t => {
  const { service, ssh, request, store } = await fixture(t);
  const agents = [];
  for (let index = 0; index < 8; index++) agents.push(await service.create({ ...request, id: randomUUID() }));
  const first = ssh.children.find(c => !c.stopped)!;
  first.finish(); await tick();
  const update = store.update.bind(store);
  const mocked = t.mock.method(store, 'update', async (change: Parameters<Store['update']>[0]) => {
    const before = store.snapshot(), next = structuredClone(before); change(next);
    if (next.tasks[0]?.updatedAt !== before.tasks[0]?.updatedAt) throw new Error('simulated registry write failure');
    await update(change);
  });
  await assert.rejects(service.send(agents[0].id, { id: randomUUID(), text: 'Do not send without a durable record' }), /registry write failure/);
  assert.equal(ssh.admissions.length, 8);
  mocked.mock.restore();
  assert.notEqual((await service.create({ ...request, id: randomUUID() })).status, 'error');
  assert.equal(first.stopped, true);
  assert.equal(ssh.admissions.length, 9);
});

test('idle ACP sessions without either resume capability stay connected until archived', async t => {
  const { service, ssh, request } = await fixture(t, 'grok'); ssh.loadSession = false;
  const agents = [];
  for (let index = 0; index < 8; index++) {
    agents.push(await service.create({ ...request, id: randomUUID() })); ssh.live.finish(); await tick();
  }
  const first = ssh.children.find(c => !c.stopped)!;
  const ninth = await service.create({ ...request, id: randomUUID() });
  assert.equal(ninth.status, 'error');
  assert.equal(first.stopped, false);
  assert.equal((await service.detail(agents[0].id)).agent.resumable, false);
  await service.send(agents[0].id, { id: randomUUID(), text: 'Continue the non-resumable session' });
  assert.equal(ssh.admissions.length, 9);
  first.finish(); await tick();
  await service.archive(agents[0].id);
  const detail = await service.detail(agents[0].id);
  assert.equal(first.stopped, true); assert.equal(detail.agent.status, 'closed');
  assert.ok(detail.timeline!.entries.some(e => e.item.text === 'Continue the non-resumable session'));
  await assert.rejects(service.send(agents[0].id, { id: randomUUID(), text: 'Too late' }), /cannot be resumed/);
  assert.equal((await service.summary(agents[0].id)).archived, true, 'a failed message must not restore an ended agent');
  await assert.rejects(service.retry(agents[0].id), /cannot resume/);
  assert.notEqual((await service.retry(ninth.id)).status, 'error');
  assert.equal(ssh.admissions.length, 10);
});

test('deleting an agent removes its saved output', async t => {
  const { service, ssh, request, directory } = await fixture(t);
  const agent = await service.create(request); ssh.live.finish(); await tick();
  const path = join(directory, 'events', `${agent.id}.jsonl`);
  assert.ok((await stat(path)).size > 0);
  await service.delete(agent.id);
  await assert.rejects(stat(path), /ENOENT/);
  assert.ok(ssh.children.every(c => c.stopped));
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
  assert.equal((await reopened.lastReply()).length, Array.from({ length: 205 }, (_, i) => String(i)).join('').length);
  const data = await readFile(path, 'utf8'); await writeFile(path, data.slice(0, -1));
  await assert.rejects(new TaskHistory(directory, id).open(), /incomplete record/);
});

test('a missing workspace path is reported without executing in the discovery directory', async t => {
  const { ChatProjects } = await import('../src/chat/projects.js');
  const { RemoteCliAdapter, chatModelId, chatProviderId } = await import('../src/chat/native-chat.js');
  const { createUserMessage } = await import('@deepseek-ai/dsh-llm');
  const { SessionId } = await import('@deepseek-ai/dsh-session');
  const { service, ssh, hostId, request, store } = await fixture(t);
  await service.discoverHost(hostId); ssh.missingPath = '/srv/not-on-this-machine';
  const adapter = new RemoteCliAdapter(new ChatProjects(service), { agent: () => undefined, step: () => undefined, cwd: () => ssh.missingPath,
    workspace: async cwd => ({ hostIds: [hostId], cwd }) }, 2);
  const run = async () => { for await (const _chunk of adapter.stream({ provider: chatProviderId('codex'), model: chatModelId(hostId, 'codex', request.model), sessionId: SessionId('missing-workspace'), messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Run here' }] })] })) {} };
  await assert.rejects(run(), /Remote directory does not exist: \/srv\/not-on-this-machine/);
  assert.equal(ssh.admissions.length, 0); assert.equal(store.snapshot().tasks.length, 0);
});

for (const provider of ['codex', 'claude', 'dsh', 'grok', 'codebuddy', 'antigravity']) test(`${provider}: DSH native model streams through the real SSH backend and resumes the same conversation`, async t => {
  const { ChatProjects } = await import('../src/chat/projects.js');
  const { RemoteCliAdapter, chatModelId, chatProviderId } = await import('../src/chat/native-chat.js');
  const { createUserMessage } = await import('@deepseek-ai/dsh-llm');
  const { SessionId } = await import('@deepseek-ai/dsh-session');
  const { service, ssh, hostId, request, store, directory } = await fixture(t, provider);
  const projects = new ChatProjects(service); await service.discoverHost(hostId); const [project] = projects.hosts();
  const chatHost = { agent: () => undefined, step: () => undefined, cwd: () => '/srv/project', workspace: async (cwd: string) => ({ hostIds: [hostId], cwd }) };
  const adapter = new RemoteCliAdapter(projects, chatHost, 2); t.after(() => adapter.close());
  const input = (text: string) => ({ provider: chatProviderId(provider), model: chatModelId(project.id, provider, request.model), sessionId: SessionId(`native-${provider}`),
    messages: [createUserMessage({ source: { kind: 'user' as const }, content: [{ type: 'text' as const, text }] })] });
  const run = async (options: ReturnType<typeof input>) => {
    const reply: string[] = [];
    const done = (async () => { for await (const chunk of adapter.stream(options)) if (chunk.type === 'text-delta') reply.push(chunk.text); })();
    const count = ssh.admissions.length;
    // Bounded by time: a busy parallel test run can need far more than a fixed number of ticks.
    for (const deadline = Date.now() + 10_000; Date.now() < deadline && ssh.admissions.length === count;) await tick();
    assert.equal(ssh.admissions.length, count + 1, 'one native prompt was admitted');
    ssh.live.finish(); await done;
    assert.equal(reply.join(''), '远程结果 🌏');
  };
  await run(input('First task'));
  const first = store.snapshot().tasks[0].native!.sessionId;
  const follow = input('Follow-up'); await run(follow);
  assert.equal(store.snapshot().tasks.length, 1); assert.equal(store.snapshot().tasks[0].native!.sessionId, first);
  assert.equal(ssh.admissions.length, 2);
  await service.close();
  const reopened = new Store(join(directory, 'state.json')); await reopened.open();
  const restarted = new RemoteAgentsService(reopened, host => new SshBackend(host, reopened, ssh)); t.after(() => restarted.close());
  const resumed = new RemoteCliAdapter(new ChatProjects(restarted), chatHost, 2);
  const replay: string[] = [];
  for await (const chunk of resumed.stream(follow)) if (chunk.type === 'text-delta') replay.push(chunk.text);
  assert.equal(replay.join(''), '远程结果 🌏'); assert.equal(ssh.admissions.length, 2, 'completed output replays after restart without a new prompt');
});

test('JSONL frames report exact byte offsets for multi-byte text split anywhere', async () => {
  const lines = ['{"text":"你好🌏"}', '{"text":"ascii"}', '{"n":3}'].map(line => Buffer.from(`${line}\n`));
  const data = new Set<(data: Buffer) => void>();
  const child: Child = { write() {}, stop() {}, onData: listener => { data.add(listener); }, onExit() {}, offset: 100 };
  const peer = new JsonlPeer(child), frames: { start: number; end: number; text?: unknown }[] = [];
  peer.onMessage((message, frame) => frames.push({ ...frame, text: message.text ?? message.n }));
  for (const byte of Buffer.concat(lines)) for (const listener of data) listener(Buffer.from([byte]));
  let at = 100;
  assert.deepEqual(frames, lines.map((line, i) => ({ start: at, end: (at += line.length), text: ['你好🌏', 'ascii', 3][i] })));
  assert.equal(peer.position, at);
});
