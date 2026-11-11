import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SshBackend, CLI_PROVIDERS, CLAUDE_ROOT_ENV, confinesCommands, unattendedClaude } from '../src/agents/backend.js';
import { JsonlPeer, quote, type Child, type SshTransport, type StartOptions, type WireMessage } from '@dsh-plugins/remote-core/ssh.js';
import { Store } from '../src/core/store.js';
import type { FinishedTurn } from '@dsh-plugins/remote-core/domain.js';
import { TaskHistory } from '../src/agents/history.js';
import { RemoteAgentsService } from '../src/agents/service.js';
import { decodeAntigravityModels } from '../src/agents/antigravity.js';

class FakeCli implements Child {
  sent: WireMessage[] = [];
  terminals: { itemId: string; processId: string }[] = [];
  stopped = false;
  data: ((data: Buffer) => void)[] = [];
  exits: ((error: Error) => void)[] = [];
  prompt?: WireMessage;
  configOptions?: any[];
  options?: StartOptions;
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
    if (m.method === 'thread/backgroundTerminals/list') { if (this.transport.noBackgroundTerminals) this.emit({ jsonrpc: '2.0', id: m.id, error: { code: -32600, message: 'unknown method' } }); else this.reply(m, { data: this.terminals, nextCursor: null }); }
    if (m.method === 'thread/backgroundTerminals/terminate') { this.terminals = this.terminals.filter(t => t.processId !== m.params.processId); this.reply(m, { terminated: true }); }
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
  model = 'codex-remote'; loadSession = true; acpModels = true; acpModes = true; dropPrompt = false; claudeInterruptError = false; noBackgroundTerminals = false; hostInfo = 'Linux\n2.1.319 (Claude Code)\n';
  configOptions?: any[];
  speeds: Record<string, unknown> = {};
  claudeContext?: unknown; claudeUsage?: unknown;
  accountChecks: string[] = [];
  store?: Store;
  missingPath?: string;
  execs: { script: string; login: boolean | undefined }[] = [];
  constructor(readonly installed = ['codex']) {}
  async exec(script: string, _timeout?: number, options: { login?: boolean } = {}) {
    this.scripts.push(script); this.execs.push({ script, login: options.login });
    if (this.missingPath && script.startsWith(`cd ${quote(this.missingPath)} &&`)) throw new Error(`Remote directory does not exist: ${this.missingPath}`);
    if (script === 'printf \'%s\' "$HOME"') return '/home/builder';
    if (script.startsWith('uname -s;')) return this.hostInfo;
    if (script.includes('uname -n')) return 'machine\0builder\0machine-id-1\0';
    if (script === 'node --version') return 'v22.23.2\n';
    if (script.endsWith("' models")) return 'Fetching available models...\nagy-remote\tAntigravity remote\n';
    return '/srv/canonical\0' + CLI_PROVIDERS.map(p => `${p.id}\0${this.installed.includes(p.id) ? `/usr/bin/${p.command}` : ''}\0`).join('');
  }
  start(_cwd: string, argv: string[], options?: StartOptions) {
    const command = argv[0] === 'node' ? argv[argv.indexOf('--') + 1] : argv[0];
    const child = new FakeCli(command.split('/').at(-1)!, argv, this); child.options = options; this.children.push(child); return child;
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

test('the machine identity and home probes skip the remote login shell; CLI discovery keeps it', async t => {
  const { service, ssh, hostId } = await fixture(t);
  await service.discoverHost(hostId);
  const identity = ssh.execs.find(e => e.script.includes('uname -n'));
  const home = ssh.execs.find(e => e.script === 'printf \'%s\' "$HOME"');
  const discovery = ssh.execs.find(e => e.script.includes("command -v 'codex'"));
  assert.equal(identity?.login, false, 'identity recheck does not load the login shell');
  assert.equal(home?.login, false, 'home directory does not load the login shell');
  assert.equal(discovery?.login, undefined, 'CLI discovery keeps the login shell for PATH');
});

test('starting a session probes only the target CLI, not every enabled CLI', async t => {
  const { service, ssh, request } = await fixture(t);
  ssh.installed.push('claude', 'dsh');
  const agent = await service.create(request); await tick();
  // Only the codex CLI is launched to validate and start; claude and dsh are never spawned or even probed.
  assert.ok(agent.started, 'the session started');
  assert.ok(ssh.children.every(c => c.provider === 'codex'), 'no other CLI was launched');
  assert.ok(ssh.scripts.every(s => !s.includes("command -v 'claude'") && !s.includes("command -v 'dsh'")), 'other CLIs are not probed for their path');
});

test('an idle history is freed from memory and reloaded on demand, while a live one is kept', async t => {
  const { service, ssh, request, backend } = await fixture(t);
  const agent = await service.create(request); await tick(); ssh.live.finish(); await tick();
  const b = backend() as unknown as { histories: Map<string, unknown>; historyUsed: Map<string, number>; sweepHistories(): void };
  await service.detail(agent.id); // load the history into memory
  // A session with a live CLI keeps its history even past the idle window.
  b.historyUsed.set(agent.id, 0); b.sweepHistories();
  assert.ok(b.histories.has(agent.id), 'a live session keeps its history');
  // Once archived, nothing live holds it, so an idle history is freed.
  await service.archive(agent.id);
  const before = (await service.detail(agent.id)).timeline!.entries.length;
  b.historyUsed.set(agent.id, 0); b.sweepHistories();
  assert.ok(!b.histories.has(agent.id), 'an idle, unread history is freed from memory');
  // Reading it again reloads the same content from disk.
  const reopened = (await service.detail(agent.id)).timeline!;
  assert.equal(reopened.entries.length, before, 'the reopened history has the same entries');
  assert.ok(b.histories.has(agent.id), 'reading reloads it');
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

test('a turn Claude moved to another model says so where it happened, and each model keeps what it used', async t => {
  const { service, ssh, request, store } = await fixture(t, 'claude');
  const reports: FinishedTurn[] = [];
  store.usageListeners.add((_task, _usage, turn) => reports.push(turn));
  const agent = await service.create(request); await tick();
  const live = ssh.live;
  // As a real CLI sends it.
  const fallback = { type: 'system', subtype: 'model_refusal_fallback', trigger: 'refusal', direction: 'retry', scope: 'session', original_model: 'claude-fable-5-1', fallback_model: 'claude-opus-4-8', request_id: 'req_1', api_refusal_category: 'cyber', retracted_message_uuids: ['u1'], content: "Fable 5.1's safeguards flagged this message.", uuid: 'u2', session_id: 's1' };
  const switches = async () => (await service.detail(agent.id)).timeline!.entries.filter(e => e.item.type === 'model_switch').map(e => e.item);
  live.emit({ type: 'assistant', parent_tool_use_id: null, message: { model: 'claude-fable-5-1', content: [{ type: 'text', text: 'Looking' }] } });
  // A subagent's fallback leaves the session on its model, and an older CLI's other directions are not a new switch.
  live.emit({ ...fallback, scope: 'local' }); live.emit({ ...fallback, direction: 'sticky' }); await tick();
  assert.deepEqual(await switches(), []);
  live.emit(fallback);
  live.emit({ type: 'assistant', parent_tool_use_id: null, message: { model: 'claude-opus-4-8', content: [{ type: 'text', text: 'Retried' }] } });
  live.emit({ type: 'result', subtype: 'success', usage: { input_tokens: 7, output_tokens: 90 }, model_usage_since_last_result: {
    'claude-fable-5-1': { inputTokens: 5, outputTokens: 20, cacheReadInputTokens: 100, cacheCreationInputTokens: 0, costUSD: 0.1 },
    'claude-opus-4-8': { inputTokens: 2, outputTokens: 70, cacheReadInputTokens: 300, cacheCreationInputTokens: 40, costUSD: 0.2 },
  } }); await tick();
  assert.deepEqual(await switches(), [{ type: 'model_switch', from: 'claude-fable-5-1', to: 'claude-opus-4-8', category: 'cyber' }]);
  const order = (await service.detail(agent.id)).timeline!.entries.map(e => e.item.text ?? e.item.type);
  assert.ok(order.indexOf('Looking') < order.indexOf('model_switch') && order.indexOf('model_switch') < order.indexOf('Retried'), 'the switch shows between the replies');
  assert.equal(reports.length, 1, 'one turn, one report');
  assert.deepEqual(reports[0].models, [
    { model: 'claude-fable-5-1', usage: { inputTokens: 5, outputTokens: 20, cacheReadTokens: 100 } },
    { model: 'claude-opus-4-8', usage: { inputTokens: 2, outputTokens: 70, cacheReadTokens: 300, cacheWriteTokens: 40 } },
  ]);
  // The same refusal on a turn Claude started itself opens that turn, so the switch is not left after the previous one.
  live.emit({ ...fallback, api_refusal_category: null }); await tick();
  const entries = (await service.detail(agent.id)).timeline!.entries, last = entries.at(-1)!, before = entries.at(-2)!;
  assert.deepEqual(last.item, { type: 'model_switch', from: 'claude-fable-5-1', to: 'claude-opus-4-8' });
  assert.equal(before.item.type, 'user_message'); assert.equal(before.item.unprompted, true); assert.ok(last.turnId, 'the switch belongs to the turn it opened');
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
  const cached = ssh.claudeUsage as any, read = async () => (await service.usage('chat-claude-limits', { route: `${hostId}/claude/claude-remote`, target: { hostId, provider: 'claude' }, account: true, refresh: true }))?.account?.plan;
  ssh.claudeUsage = { ...cached, rate_limits: { ...cached.rate_limits, model_scoped: [{ display_name: 'Fable', utilization: 0, resets_at: null }] } };
  assert.equal(await read(), 'Max');
  ssh.claudeUsage = cached;
  assert.equal(await read(), 'Max', 'an answer from the CLI\'s cached usage keeps the plan shown last');
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

test('stopping a Codex turn ends the commands it started and leaves those of earlier turns', async t => {
  const { service, ssh, request } = await fixture(t);
  const agent = await service.create(request), cli = ssh.live;
  assert.deepEqual(cli.sent.find(m => m.method === 'initialize')!.params.capabilities, { experimentalApi: true }, 'the terminal calls are refused without it');
  const command = (id: string) => ({ type: 'commandExecution', id, command: 'pnpm check', status: 'inProgress' });
  cli.terminals = [{ itemId: 'earlier', processId: '1' }, { itemId: 'finished', processId: '2' }, { itemId: 'running', processId: '3' }];
  cli.emit({ method: 'item/started', params: { item: command('finished') } });
  cli.emit({ method: 'item/completed', params: { item: { ...command('finished'), status: 'completed' } } });
  cli.emit({ method: 'item/started', params: { item: command('running') } });
  await tick();
  await service.stop(agent.id);
  assert.deepEqual(cli.sent.filter(m => m.method === 'thread/backgroundTerminals/terminate').map(m => m.params), [{ threadId: 'thread-remote', processId: '2' }, { threadId: 'thread-remote', processId: '3' }]);
  assert.deepEqual(cli.terminals, [{ itemId: 'earlier', processId: '1' }]);
  const methods = cli.sent.map(m => m.method);
  assert.ok(methods.indexOf('turn/interrupt') < methods.indexOf('thread/backgroundTerminals/terminate'), 'the model must not see its command end while it can still act');
  assert.equal((await service.summary(agent.id)).status, 'idle');
});

test('a Codex without the terminal calls is still stopped', async t => {
  const { service, ssh, request } = await fixture(t);
  ssh.noBackgroundTerminals = true;
  const agent = await service.create(request), cli = ssh.live;
  cli.emit({ method: 'item/started', params: { item: { type: 'commandExecution', id: 'running', command: 'pnpm check', status: 'inProgress' } } });
  await tick();
  await service.stop(agent.id);
  assert.ok(cli.sent.some(m => m.method === 'thread/backgroundTerminals/list'));
  assert.equal((await service.summary(agent.id)).status, 'idle');
  assert.ok(types((await service.detail(agent.id)).timeline!.entries).includes('interrupted'));
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

test('an unattended Codex task never asks: it works in the selected sandbox, or in the remote config one', async t => {
  const { ssh, service, request } = await fixture(t);
  await service.create({ ...request, modeId: 'workspace-write' }, { unattended: true }); await tick();
  const params = ssh.live.sent.find(m => m.method === 'thread/start')!.params;
  assert.equal(params.sandbox, 'workspace-write'); assert.equal(params.approvalPolicy, 'never'); assert.equal(params.approvalsReviewer, 'user');
  assert.equal(service.store.task(t => t.id === request.id)!.unattended, true);
  await service.create({ ...request, id: 'inherit-unattended', modeId: 'inherit' }, { unattended: true }); await tick();
  const inherited = ssh.live.sent.filter(m => m.method === 'thread/start').at(-1)!.params;
  assert.equal(inherited.approvalPolicy, 'never'); assert.equal(inherited.sandbox, undefined);
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

test('releasing an idle session ends its CLI and the next message resumes it; a busy one is left alone', async t => {
  const { service, ssh, request } = await fixture(t, 'claude');
  const agent = await service.create(request), cli = ssh.live;
  await service.release(agent.id);
  assert.equal(cli.stopped, false, 'it is still working on its first prompt');
  cli.finish(); await tick();
  await service.release(agent.id);
  assert.equal(cli.stopped, true);
  await service.send(agent.id, { id: randomUUID(), text: 'One more thing' });
  assert.equal(ssh.live.argv[ssh.live.argv.indexOf('--resume') + 1], cli.argv[cli.argv.indexOf('--session-id') + 1]);
});

test('an unattended Claude task with workspace write runs commands in Claude Code\'s sandbox; others do not', async t => {
  const { service, ssh, request } = await fixture(t, 'claude');
  const settings = () => ssh.live.argv.includes('--settings') ? JSON.parse(ssh.live.argv[ssh.live.argv.indexOf('--settings') + 1]) : undefined;
  await service.create({ ...request, modeId: 'acceptEdits' }, { unattended: true });
  assert.equal(ssh.live.argv[ssh.live.argv.indexOf('--permission-mode') + 1], 'acceptEdits');
  assert.deepEqual(settings(), { sandbox: { enabled: true, autoAllowBashIfSandboxed: true } });
  await service.create({ ...request, id: 'attended', modeId: 'acceptEdits' });
  assert.equal(settings(), undefined, 'someone answers an ordinary conversation');
  await service.create({ ...request, id: 'read-only-member', modeId: 'default' }, { unattended: true });
  assert.equal(settings(), undefined, 'the sandbox would let a read-only member write');
});

test('commands are left to the sandbox only on a host and version where it has been measured', () => {
  assert.equal(confinesCommands('Darwin', '2.1.319 (Claude Code)'), true);
  assert.equal(confinesCommands('Darwin\n', '2.2.0 (Claude Code)'), true);
  assert.equal(confinesCommands('Darwin', '3.0.1'), true);
  assert.equal(confinesCommands('Darwin', '2.1.318 (Claude Code)'), false, 'older settings may be ignored without a word');
  assert.equal(confinesCommands('Darwin', '2.0.999'), false);
  assert.equal(confinesCommands('Linux', '2.1.319 (Claude Code)'), false, 'without bwrap and socat its commands run unsandboxed');
  assert.equal(confinesCommands('Darwin', ''), false);
  assert.equal(confinesCommands('', 'command not found'), false);
});

test('confined settings make Claude Code refuse to run unsandboxed, and only workspace write gets them', () => {
  const settings = (argv: string[]) => JSON.parse(argv[argv.indexOf('--settings') + 1]).sandbox;
  const write = settings(unattendedClaude({ unattended: true, modeId: 'acceptEdits' }, true));
  assert.equal(write.failIfUnavailable, true);
  assert.equal(write.allowUnsandboxedCommands, false);
  assert.equal(write.autoAllowBashIfSandboxed, true);
  assert.deepEqual(write.filesystem, { allowWrite: ['/tmp', '/private/tmp'] }, 'real test suites need temporary files, and macOS has both names for them');
  const plain = settings(unattendedClaude({ unattended: true, modeId: 'acceptEdits' }));
  assert.equal(plain.failIfUnavailable, undefined, 'no promise of a sandbox without one');
  assert.equal(plain.filesystem, undefined);
  assert.deepEqual(unattendedClaude({ unattended: true, modeId: 'default' }, true), ['--allowedTools', 'WebSearch,WebFetch'], 'read-only stays as it was');
  assert.deepEqual(unattendedClaude({ unattended: true, modeId: 'bypassPermissions' }, true), []);
  assert.deepEqual(unattendedClaude({ modeId: 'acceptEdits' }, true), []);
});

test('a task is marked sandboxed only when its CLI was started with the confined settings', async t => {
  const { service, ssh, request, store } = await fixture(t, 'claude');
  ssh.hostInfo = 'Darwin\n2.1.319 (Claude Code)\n';
  const sandbox = () => ssh.live.argv.includes('--settings') ? JSON.parse(ssh.live.argv[ssh.live.argv.indexOf('--settings') + 1]).sandbox : undefined;
  const marked = (id: string) => store.task(task => task.id === id)?.sandboxed;
  const reviewer = await service.create({ ...request, id: 'reviewer', modeId: 'default' }, { unattended: true });
  assert.equal(sandbox(), undefined, 'read-only stays as it was');
  assert.equal(marked(reviewer.id), undefined);
  const implementer = await service.create({ ...request, id: 'implementer', modeId: 'acceptEdits' }, { unattended: true });
  assert.equal(sandbox().failIfUnavailable, true);
  assert.equal(marked(implementer.id), true);
  const attended = await service.create({ ...request, id: 'attended', modeId: 'acceptEdits' });
  assert.equal(sandbox(), undefined, 'someone answers an ordinary conversation');
  assert.equal(marked(attended.id), undefined);
  const inherit = await service.create({ ...request, id: 'inherit-mode', modeId: 'inherit' }, { unattended: true });
  assert.equal(sandbox(), undefined);
  assert.equal(marked(inherit.id), undefined, 'no settings, so an allowed command would run outside any sandbox');
  assert.equal(ssh.execs.filter(e => e.script.startsWith('uname -s;')).length, 1, 'the host is asked once');
});

test('on a host where the sandbox is not relied on, nothing changes', async t => {
  const { service, ssh, request, store } = await fixture(t, 'claude');
  const agent = await service.create({ ...request, id: 'implementer', modeId: 'acceptEdits' }, { unattended: true });
  assert.deepEqual(JSON.parse(ssh.live.argv[ssh.live.argv.indexOf('--settings') + 1]), { sandbox: { enabled: true, autoAllowBashIfSandboxed: true } });
  assert.equal(store.task(task => task.id === agent.id)?.sandboxed, undefined);
});

test('only an unattended read-only Claude task gets web search and web fetch without asking', async t => {
  const { service, ssh, request } = await fixture(t, 'claude');
  const allowed = () => ssh.live.argv.includes('--allowedTools') ? ssh.live.argv[ssh.live.argv.indexOf('--allowedTools') + 1] : undefined;
  await service.create({ ...request, modeId: 'default' }, { unattended: true });
  assert.equal(allowed(), 'WebSearch,WebFetch');
  await service.create({ ...request, id: 'attended', modeId: 'default' });
  assert.equal(allowed(), undefined, 'someone answers an ordinary conversation');
  await service.create({ ...request, id: 'implementer', modeId: 'acceptEdits' }, { unattended: true });
  assert.equal(allowed(), undefined);
});

test('Claude Auto is available for new sessions and is explicitly passed to the non-interactive CLI', async t => {
  const { service, ssh, request, hostId } = await fixture(t, 'claude');
  const provider = (await service.providers(hostId, request.cwd)).find(p => p.id === 'claude')!;
  assert.ok(provider.modes.some(m => m.id === 'auto'));
  await service.create({ ...request, modeId: 'auto' });
  assert.equal(ssh.live.argv[ssh.live.argv.indexOf('--permission-mode') + 1], 'auto');
  assert.equal(ssh.live.argv.includes('--dangerously-skip-permissions'), false);
});

test('only Claude launches that may skip permissions say a root account means it', async t => {
  const { service, ssh, request, hostId, store } = await fixture(t, 'claude');
  await service.providers(hostId, request.cwd);
  assert.equal(ssh.children[0].options?.prefix, CLAUDE_ROOT_ENV, 'discovery reads the settings that can ask for it');
  for (const modeId of [undefined, 'inherit', 'bypassPermissions']) {
    const agent = await service.create({ ...request, id: randomUUID(), modeId });
    assert.equal(ssh.live.options?.prefix, CLAUDE_ROOT_ENV, `mode ${modeId}`);
    assert.equal(ssh.live.argv[0], '/usr/bin/claude', 'the CLI stays the command that is launched');
    assert.equal(native(store, agent.id).argv[0], '/usr/bin/claude');
  }
  for (const modeId of ['default', 'plan', 'acceptEdits', 'auto']) {
    await service.create({ ...request, id: randomUUID(), modeId });
    assert.equal(ssh.live.options?.prefix, undefined, `mode ${modeId}`);
  }
});

test('other CLIs are launched without it', async t => {
  const { service, ssh, request, hostId } = await fixture(t, 'codex');
  await service.providers(hostId, request.cwd);
  await service.create({ ...request, modeId: 'full-access' });
  for (const child of ssh.children) assert.equal(child.options?.prefix, undefined);
});

test('CLIs started without a relay end with their SSH session: model checks and direct sessions alike', async t => {
  for (const provider of ['codebuddy', 'claude', 'codex']) {
    const { service, ssh, request, hostId } = await fixture(t, provider);
    await service.providers(hostId, request.cwd);
    assert.ok(ssh.children.length > 0);
    for (const child of ssh.children) assert.equal(child.options?.endWithSession, true, `${provider} model check`);
    await service.create(request);
    assert.equal(ssh.live.options?.endWithSession, true, `${provider} session without a relay`);
  }
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

test('images in Claude tool results are saved on the DSH host and named on their tool calls, never stored in the history', async t => {
  const { service, ssh, request, store } = await fixture(t, 'claude');
  const agent = await service.create(request); await tick();
  const png = Buffer.from('png bytes'), jpeg = Buffer.from('jpeg bytes');
  const image = (data: Buffer, media_type: string) => ({ type: 'image', source: { type: 'base64', media_type, data: data.toString('base64') } });
  const file = (data: Buffer, extension: string) => `${createHash('sha256').update(data).digest('hex')}${extension}`;
  ssh.live.emit({ type: 'assistant', parent_tool_use_id: null, message: { content: [
    { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: '/tmp/qa/shots/a1-receipt.png' } },
    { type: 'tool_use', id: 'shot-1', name: 'mcp__browser__screenshot', input: {} },
    { type: 'tool_use', id: 'read-2', name: 'Read', input: { file_path: '/tmp/qa/gone.png' } },
  ] } });
  ssh.live.emit({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'read-1', content: [image(png, 'image/png')] },
    // Text stays the result; a media type the chat cannot show is left out.
    { type: 'tool_result', tool_use_id: 'shot-1', content: [{ type: 'text', text: 'Captured' }, image(jpeg, 'image/jpeg'), image(jpeg, 'image/tiff')] },
    { type: 'tool_result', tool_use_id: 'read-2', is_error: true, content: [image(png, 'image/png')] },
  ] } });
  const entries = (await service.detail(agent.id)).timeline!.entries;
  const results = entries.filter(e => e.item.type === 'tool_call' && e.item.status !== 'running').map(e => [e.item.callId, e.item.images]);
  assert.deepEqual(results, [
    // The path read lets a DSH without the copy fetch the image.
    ['read-1', [{ file: file(png, '.png'), path: '/tmp/qa/shots/a1-receipt.png', name: 'a1-receipt.png' }]],
    ['shot-1', [{ file: file(jpeg, '.jpg'), name: '' }]],
    ['read-2', undefined],
  ]);
  assert.match(String(entries.find(e => e.item.callId === 'shot-1' && e.item.status === 'completed')!.item.detail), /^Captured/);
  // Saved before the entries that name them, so a chat reading the entry finds the file.
  const directory = join(store.directory, 'chat-images');
  assert.deepEqual((await readdir(directory)).sort(), [file(png, '.png'), file(jpeg, '.jpg')].sort());
  assert.deepEqual(await readFile(join(directory, file(png, '.png'))), png);
  const saved = await readFile(join(store.directory, 'events', `${agent.id}.jsonl`), 'utf8');
  assert.equal(saved.includes(png.toString('base64')) || saved.includes(jpeg.toString('base64')), false, 'image bytes stay out of the shared history');
});

test('Codex images are recorded: view_image by path, MCP and generated images by copy, with bytes kept out of the history', async t => {
  const { service, ssh, request, store } = await fixture(t);
  const agent = await service.create(request); await tick();
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('generated')]), jpeg = Buffer.from('screenshot bytes');
  const file = (data: Buffer, extension: string) => `${createHash('sha256').update(data).digest('hex')}${extension}`;
  const item = (method: string, value: Record<string, unknown>) => ssh.live.emit({ method, params: { item: value, threadId: 'thread-remote', turnId: 'turn-1' } });
  item('item/started', { type: 'imageView', id: 'view-1', path: '/tmp/qa/shot.png' });
  item('item/completed', { type: 'imageView', id: 'view-1', path: '/tmp/qa/shot.png' });
  item('item/completed', { type: 'imageView', id: 'view-2', path: 'relative.png' });
  item('item/completed', { type: 'mcpToolCall', id: 'mcp-1', server: 'browser', tool: 'screenshot', status: 'completed', arguments: {},
    result: { content: [{ type: 'text', text: 'Captured' }, { type: 'image', data: jpeg.toString('base64'), mimeType: 'image/jpeg' }], structuredContent: null, _meta: null } });
  item('item/started', { type: 'imageGeneration', id: 'gen-1', status: 'in_progress', revisedPrompt: null, result: '', failure: null });
  item('item/completed', { type: 'imageGeneration', id: 'gen-1', status: 'completed', revisedPrompt: 'An apple', result: png.toString('base64'), failure: null, savedPath: '/home/builder/.codex/generated_images/t/gen-1.png' });
  item('item/completed', { type: 'imageGeneration', id: 'gen-2', status: 'failed', result: '', failure: { message: 'blocked' } });
  const entries = (await service.detail(agent.id)).timeline!.entries.filter(e => e.item.type === 'tool_call');
  assert.deepEqual(entries.map(e => [e.item.callId, e.item.name, e.item.status, e.item.images]), [
    ['view-1', 'view_image', 'running', undefined],
    ['view-1', 'view_image', 'completed', [{ path: '/tmp/qa/shot.png', name: 'shot.png' }]],
    ['view-2', 'view_image', 'completed', undefined],
    ['mcp-1', 'screenshot', 'completed', [{ file: file(jpeg, '.jpg'), name: 'screenshot' }]],
    ['gen-1', 'image_generation', 'running', undefined],
    ['gen-1', 'image_generation', 'completed', [{ file: file(png, '.png'), path: '/home/builder/.codex/generated_images/t/gen-1.png', name: 'gen-1.png' }]],
    ['gen-2', 'image_generation', 'failed', undefined],
  ]);
  const mcp = entries.find(e => e.item.callId === 'mcp-1')!.item.detail as { result: { content: unknown[] } };
  assert.deepEqual(mcp.result.content, [{ type: 'text', text: 'Captured' }, { type: 'image', mimeType: 'image/jpeg' }]);
  assert.deepEqual((await readdir(join(store.directory, 'chat-images'))).sort(), [file(png, '.png'), file(jpeg, '.jpg')].sort());
  const saved = await readFile(join(store.directory, 'events', `${agent.id}.jsonl`), 'utf8');
  assert.equal(saved.includes(png.toString('base64')) || saved.includes(jpeg.toString('base64')), false, 'image bytes stay out of the shared history');
});

test('a turn Claude starts by itself after a background task is saved as its own turn, shown as running and announced as it starts and ends', async t => {
  const { service, ssh, request, backend } = await fixture(t, 'claude');
  const announced: string[] = [];
  const agent = await service.create(request); await tick();
  backend().onSharedHistory(id => announced.push(id));
  ssh.live.finish(); await tick();
  const live = ssh.live;
  // A notice during a turn is that turn's own business, and a result without output is not a turn.
  await service.send(agent.id, { id: randomUUID(), text: 'Continue' }); await tick();
  live.emit({ type: 'system', subtype: 'task_notification', task_id: 'b1', status: 'completed', summary: 'Find references to the loader' });
  live.finish(); await tick();
  live.emit({ type: 'result', subtype: 'success' }); await tick();
  assert.equal((await service.summary(agent.id)).status, 'idle');
  assert.deepEqual(announced, []);
  // Idle, Claude is told what it ran in the background finished, and goes on without a message from DSH.
  live.emit({ type: 'system', subtype: 'task_notification', task_id: 'b2', status: 'completed', summary: 'Background command "Run Codex" completed (exit code 0)' });
  live.emit({ type: 'system', subtype: 'task_notification', task_id: 'b3', status: 'stopped', summary: 'Background shell command did not finish' });
  await tick();
  assert.equal((await service.summary(agent.id)).status, 'idle', 'a notice alone is not a turn');
  live.emit({ type: 'assistant', parent_tool_use_id: 'task-b4', message: { content: [{ type: 'text', text: 'Still searching' }] } }); await tick();
  assert.equal((await service.summary(agent.id)).status, 'idle', 'a subagent left running in the background is not Claude going on');
  live.emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Checking the result.' } } });
  live.emit({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Checking the result.' }, { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls' } }] } });
  await tick();
  const running = await service.summary(agent.id);
  assert.equal(running.status, 'running'); assert.equal(running.unprompted, true);
  assert.deepEqual(announced, [agent.id], 'conversations are told as it starts, to show it as it goes');
  await assert.rejects(service.send(agent.id, { id: randomUUID(), text: 'Done?' }, { interrupt: false }), /still working/);
  live.emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] } });
  live.emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: ' Done.' } } });
  live.emit({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: ' Done.' }] } });
  live.emit({ type: 'result', subtype: 'success', origin: { kind: 'task-notification' } }); await tick();
  assert.equal((await service.summary(agent.id)).status, 'idle');
  assert.deepEqual(announced, [agent.id, agent.id], 'and once it ends');
  const entries = (await service.detail(agent.id)).timeline!.entries;
  const start = entries.findLastIndex(e => e.item.type === 'user_message'), own = entries[start].item;
  assert.equal(own.unprompted, true); assert.match(String(own.clientMessageId), /^cli-/);
  assert.equal(own.text, 'Background command "Run Codex" completed (exit code 0)\nBackground shell command did not finish (stopped)');
  assert.equal(entries[start - 2].item.type, 'turn_end', 'it follows the previous turn');
  assert.equal(entries[start - 1].item.text, 'Still searching', 'the subagent output stays where it arrived, outside any turn');
  assert.deepEqual(types(entries.slice(start + 1)), ['assistant_message', 'tool_call', 'tool_call', 'assistant_message', 'turn_end']);
  assert.equal(entries.at(-1)!.item.clientMessageId, own.clientMessageId);
  assert.equal((await service.messageTimeline(agent.id, String(own.clientMessageId))).terminalStatus, 'completed');
  // The next message continues the session as usual.
  await service.send(agent.id, { id: randomUUID(), text: 'Thanks' }); await tick();
  ssh.live.finish(); await tick();
  assert.equal((await service.summary(agent.id)).status, 'idle');
  assert.deepEqual(announced, [agent.id, agent.id], 'a turn for a message is not announced');
});
