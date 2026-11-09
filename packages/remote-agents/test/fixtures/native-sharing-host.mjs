// Runs only against an explicitly selected installed DSH package directory.
// No CLI launcher, profile, credentials, network adapter, or real session root is loaded.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const runtime = resolve(process.argv[2]);
const load = name => import(pathToFileURL(join(runtime, '@deepseek-ai', name, 'lib/index.js')).href);
const [{ Context }, sessions, agents, llm, loop, projections, tools, prompts, persistence, executor] = await Promise.all([
  'cordis', 'dsh-session', 'dsh-agent', 'dsh-llm', 'dsh-agent-loop', 'dsh-session-projection',
  'dsh-tools', 'dsh-system-prompt', 'dsh-session-persistence-jsonl', 'dsh-tool-executor-native',
].map(load));
const root = await mkdtemp(join(tmpdir(), 'dsh-native-host-'));
const mounted = [];
async function host(name) {
  const ctx = new Context();
  async function mount(plugin, config) { const fork = ctx.plugin(plugin, config); mounted.push(fork); await fork.await(); }
  await mount(sessions.default);
  await mount(projections.default);
  await mount(agents.default);
  await mount(llm.default);
  await mount(prompts.default);
  await mount(tools.default);
  await mount(executor);
  await mount(persistence, { root: join(root, name, 'sessions'), compression: 'none' });
  await mount(loop.default, {});
  const calls = [];
  ctx.llm.registerAdapter(['test-native'], new class extends llm.LlmAdapter {
    async listModels() { return [{ id: 'model', provider: 'test-native', name: 'Fake native', context: { contextWindow: 100000 } }]; }
    async resolveModel() { return { id: 'model', provider: 'test-native', name: 'Fake native', context: { contextWindow: 100000 } }; }
    async *stream(options) {
      calls.push(options);
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: 'reply' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'reply' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }());
  ctx.systemPrompt.section({ name: 'receiver', order: 1, text: `runtime on ${name}` });
  return { ctx, calls };
}
try {
  const a = await host('air'), b = await host('mini');
  const id = sessions.SessionId('native-host-audit');
  const owned = await a.ctx.agents.create({ sessionId: id, meta: { cwd: root }, agentOptions: { provider: 'test-native', model: 'model' } });
  const agent = a.ctx.agents.get(id);
  a.ctx.on('agent/error', payload => { console.error('audit agent error', payload.error); }, { global: true });
  assert.equal(agent, owned.agent);
  assert.equal(typeof owned.dispose, 'function');
  assert.equal(agent.dispose, undefined, 'registry lookup deliberately does not grant the GUI owner disposer');
  let pre = 0, requests = 0, streams = 0;
  const removePre = a.ctx.on('agent/pre-step', async (_payload, next) => { pre++; return next(); }, { global: true });
  a.ctx.on('agent/request', async (_payload, next) => { requests++; return next(); }, { global: true });
  a.ctx.on('llm/stream', async function* (_options, next) { streams++; yield* next(); }, { global: true });
  agent.followup(llm.createUserMessage({ content: [{ type: 'text', text: 'native prompt' }], source: { kind: 'user' } }));
  await agent.whenIdle();
  assert.equal(pre, 1); assert.equal(requests, 1); assert.equal(streams, 1); assert.equal(a.calls.length, 1);
  await a.ctx.sessions.flush(agent.session);
  await assert.rejects(a.ctx.sessionPersistence.open(id, 'write'), /owned|owner|ownership/i,
    'even idle GUI-owned sessions retain the native write handle');
  await assert.rejects(a.ctx.agents.create({ sessionId: id, seed: agent.session.snapshotEvents() }),
    /already|exists|registered|live/i, 'create(seed) cannot replace an existing session');

  const log = agent.session.snapshotEvents();
  const beforeCalls = b.calls.length;
  let importsPublished = 0;
  b.ctx.on('session/event', () => { importsPublished++; }, { global: true });
  // A cold native restore is lossless and silent, but this owner capability is available
  // here only because this TEST (not the GUI controller) created the receiver.
  const imported = await b.ctx.sessionPersistence.create(agent.session.header);
  await imported.append(log); await imported.flush(); await imported.close();
  const receiver = await b.ctx.agents.resume({ resumeSessionId: id, agentOptions: { provider: 'test-native', model: 'model' } });
  assert.equal(b.calls.length, beforeCalls);
  assert.equal(importsPublished, 0);
  assert.deepEqual(receiver.agent.session.snapshotEvents(0, log.length), log);
  assert.deepEqual(receiver.agent.session.snapshotEvents(log.length).map(event => event.type), ['session/end-seed']);
  receiver.agent.followup(llm.createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }));
  await receiver.agent.whenIdle();
  assert.equal(b.calls.length, 1);
  const system = b.calls[0].messages.filter(message => message.role === 'system');
  assert.match(JSON.stringify(system), /runtime on mini/);
  assert.doesNotMatch(JSON.stringify(system), /runtime on air/);
  assert.ok(b.calls[0].messages.some(message => JSON.stringify(message).includes('native prompt')));

  // session/event is post-commit and non-vetoing. An observer cannot implement
  // async admission or silently replay a remote suffix into the live object.
  const before = receiver.agent.session.seq;
  let observedCommitted = false;
  const off = b.ctx.on('session/event', (session, event) => { observedCommitted = session.seq > event.seq; }, { global: true });
  receiver.agent.session.append('user/message', llm.createUserMessage({ content: [{ type: 'text', text: 'remote suffix' }], source: { kind: 'user' } }), { surfaceOp: 'append' });
  assert.equal(receiver.agent.session.seq, before + 1);
  assert.equal(observedCommitted, true);
  assert.ok(importsPublished > 0);
  off(); removePre();
  await receiver.dispose(); await owned.dispose();
  process.stdout.write(JSON.stringify({ ordinaryHooks: true, coldSeedContinues: true, receiverSystemRebuilt: true,
    idleWriterExclusive: true, lookupHasNoDisposer: true, liveSeedReplacementRejected: true, appendPublishes: true }) + '\n');
} finally {
  for (const fork of mounted.reverse()) await fork.dispose();
  await rm(root, { recursive: true, force: true });
}
