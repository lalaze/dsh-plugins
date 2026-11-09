// Real installed host components with a local fake SSH authority and fake LLM.
// All persistence/attachments live below one disposable directory. No profile is loaded.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { installNativeSharing } from '../../src/chat/native-install.ts';
import { NATIVE_SCRIPT } from '../../src/chat/native-registry.ts';

const runtime = resolve(process.argv[2]);
const load = name => import(pathToFileURL(join(runtime, '@deepseek-ai', name, 'lib/index.js')).href);
const [{ Context }, sessions, agents, llm, loop, projections, tools, prompts, persistence, executor, query, sandbox, approval, attachments, meter, compaction,
  storage, json, domain, workspaces, subprocess, sandboxLocal, bashSandbox, permissions, commands, defaults, loader, presets] = await Promise.all([
  'cordis', 'dsh-session', 'dsh-agent', 'dsh-llm', 'dsh-agent-loop', 'dsh-session-projection',
  'dsh-tools', 'dsh-system-prompt', 'dsh-session-persistence-jsonl', 'dsh-tool-executor-native',
  'dsh-session-query', 'dsh-sandbox-policy', 'dsh-user-approval', 'dsh-attachment-local', 'dsh-token-meter', 'dsh-compaction-basic',
  'dsh-storage', 'dsh-storage-json', 'dsh-storage-domain', 'dsh-workspace', 'dsh-subprocess-local', 'dsh-sandbox-local', 'dsh-bash-sandbox',
  'dsh-permission-presets', 'dsh-commands', 'dsh-agent-default-model', 'cordis-plugin-loader', 'dsh-agent-preset-registry',
].map(load));
const { ApiSessionAgentController } = await import(pathToFileURL(join(runtime, '@deepseek-ai/dsh-api-session-controller/lib/types/agent.js')).href);
const root = await mkdtemp(join(tmpdir(), 'dsh-native-flow-')), mounted = [], sourceHandles = [];
const script = join(root, 'registry.mjs'); await writeFile(script, NATIVE_SCRIPT);
let offline = false, failNextCreate = false, loseNextRelease = false;
async function rpc(request) {
  if (offline) throw new Error('simulated SSH disconnect');
  if(request.action==='create' && failNextCreate) {failNextCreate=false;throw Error('simulated rejected create');}
  const result = await new Promise((accept, reject) => {
    const child = spawn(process.execPath, [script, join(root, 'authority')], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', error = ''; child.stdout.on('data', d => { output += d; }); child.stderr.on('data', d => { error += d; });
    child.on('error', reject); child.on('exit', code => { if (code) return reject(Error(error)); const value = JSON.parse(output); value.error ? reject(Error(value.error)) : accept(value.result); });
    child.stdin.end(JSON.stringify(request));
  });
  if(request.action==='release' && loseNextRelease) {loseNextRelease=false;throw Error('lost committed release response');}
  return result;
}
async function host(name) {
  const ctx = new Context(), directory = join(root, name), workspacePath = join(directory, 'workspace'); await mkdir(workspacePath, { recursive: true });
  async function mount(plugin, config) { const fork = ctx.plugin(plugin, config); mounted.push(fork); await fork.await(); }
  await mount(sessions.default); await mount(projections.default); await mount(agents.default); await mount(llm.default);
  await mount(prompts.default); await mount(tools.default); await mount(executor);
  await mount(persistence, { root: join(directory, 'sessions'), compression: 'zstd' });
  await mount(storage.default); await mount(json, { root: join(directory, 'storage') }); await mount(domain, { backend: 'json' });
  await mount(workspaces.default);
  await mount(query.SessionQueryEngine); await mount(sandbox.default, { mode: 'danger-full-access', workspaceRoot: workspacePath });
  await mount(approval.default, { policy: 'never' }); await mount(attachments.default, { dshHome: directory });
  await mount(subprocess.default); await mount(sandboxLocal.default); await mount(bashSandbox.default, { cwd: workspacePath });
  await mount(permissions.default, { defaultPreset: 'danger-full-access', presets: {
    'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
    'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
    ...(name === 'mini' ? { 'read-only': { sandbox: 'read-only', approval: 'ask' } } : {}),
  } });
  await mount(commands.default); await mount(defaults.default, { provider: 'test-native', model: 'model' });
  await mount(loader.default, { baseUrl: pathToFileURL(directory + '/').href });
  ctx.loader.internal = { import: async specifier => load(specifier.replace('@deepseek-ai/', '')) };
  await mount(presets.default, { default: `local-${name}` });
  await ctx.agentPresets.register({ id: `local-${name}`, plugins: [] });
  ctx.commands.register({ name: 'safe_probe', description: 'Ordinary shared command', handler: () => ({kind:'success',text:'native command ran'}) });
  await mount(meter.default); await mount(compaction.default, { auto: false, headroomTokens: 100, maxTokens: 100, retainTokens: 0 });
  await mount(loop.default, {});
  const calls = [], errors = []; let executions = 0;
  ctx.on('agent/error', payload => { errors.push(String(payload.error)); }, { global: true });
  ctx.tools.register({ name: 'audit_tool', description: 'Isolated counter', parameters: { type: 'object', properties: {} }, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async () => { executions++; return 'native tool result'; } });
  ctx.llm.registerAdapter(['test-native'], new class extends llm.LlmAdapter {
    async listModels() { return [{ id: 'model', provider: 'test-native', name: 'Fake native', context: { contextWindow: 100000 } }]; }
    async resolveModel() { return (await this.listModels())[0]; }
    async *stream(options) {
      calls.push(options);
      if (name === 'air' && calls.length === 1) {
        const block = { type: 'tool-call', id: llm.ToolCallId('audit-tool-call'), name: 'audit_tool', arguments: '{}' };
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }; yield { type: 'block-end', index: 0, block }; yield { type: 'finish', reason: { kind: 'tool-calls' } }; return;
      }
      const text = options.purpose === 'compaction' ? 'Native compacted checkpoint retains the tool result and task.' : `ordinary reply from ${name}`;
      yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }; yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }());
  ctx.systemPrompt.section({ name: 'machine', order: 1, text: `runtime on ${name}` });
  ctx.systemPrompt.context({ name: 'machine-context', order: 2, text: `current machine ${name}`, required: true });
  const workspace = { placement: async () => ({ hostIds: ['verified-host'], cwd: '/srv/project' }),
    workspaces: { create: async () => ({ path: workspacePath }) }, access: { resolve: async () => ({ hostIds: ['verified-host'], cwd: '/srv/project' }) } };
  const service = { store: { directory: join(directory, 'plugin'), instance: async () => ({ id: `instance-${name}`, label: name }) }, withWorkspace: async (_hostId, verify, action) => { await verify(); return action({ nativeSharing: rpc }); } };
  let sharing, sharingFork;
  const mountSharing = async () => {
    const fork = ctx.plugin({ name: `native-sharing-${name}`, async apply(scope) { sharing = await installNativeSharing(scope, service, workspace); } });
    sharingFork = fork; mounted.push(fork); await fork.await();
  };
  await mountSharing();
  await sharing.configure('verified-host', true);
  return { ctx, get sharing() { return sharing; }, calls, errors, workspacePath, executions: () => executions,
    controller: new ApiSessionAgentController(ctx), async reload() { await sharingFork.dispose(); await mountSharing(); } };
}
const user = content => llm.createUserMessage({ content: typeof content === 'string' ? [{ type: 'text', text: content }] : content, source: { kind: 'user' } });
try {
  const air = await host('air'), mini = await host('mini');
  const id = sessions.SessionId(randomUUID()), original = await air.ctx.agents.create({ sessionId: id, meta: { cwd: air.workspacePath }, agentOptions: { provider: 'test-native', model: 'model' } }); sourceHandles.push(original);
  const file = await air.ctx.attachments.saveFile({ data: Buffer.from('native exact file payload'), name: 'notes.txt' });
  original.agent.followup(user([{ type: 'text', text: 'Long context to compact. '.repeat(1000) }, { type: 'file', attachment: file }]));
  await original.agent.whenIdle(); assert.equal(air.executions(), 1); assert.equal(air.errors.length, 0, air.errors.join('\n'));
  original.agent.followup(user('One more full turn. '.repeat(500))); await original.agent.whenIdle();
  await air.ctx.compaction.compactNow(original.agent, new AbortController().signal);
  assert.ok(original.agent.session.snapshotEvents().some(e => e.type === 'compaction/summary'));
  const before = original.agent.session.snapshotEvents();
  const shared = await air.sharing.share(id, 'verified-host');
  const miniCalls = mini.calls.length, miniTools = mini.executions();
  const view = await mini.sharing.open('verified-host', shared.sharedId, false);
  assert.equal(mini.calls.length, miniCalls); assert.equal(mini.executions(), miniTools);
  const canonicalWorkspace = await realpath(mini.workspacePath);
  assert.ok(mini.ctx.workspaceRegistry.list().some(w => w.path === canonicalWorkspace && w.sessionIds.includes(view.sessionId)));
  assert.equal(mini.ctx.agents.get(view.sessionId), undefined, 'read-only import has no live Agent');
  const guiView = await mini.controller.resolveAgent(view.sessionId);
  assert.ok(guiView.agent, String(guiView.error));
  assert.equal(mini.ctx.permissionPresets.current(guiView.agent.session), 'read-only');
  assert.equal(mini.calls.length, miniCalls); assert.equal(mini.executions(), miniTools);
  const active = await mini.sharing.open('verified-host', shared.sharedId, true), agent = mini.ctx.agents.get(active.sessionId);
  assert.deepEqual(agent.session.snapshotEvents(0, before.length), before);
  assert.equal(mini.calls.length, miniCalls); assert.equal(mini.executions(), miniTools);
  assert.equal(mini.ctx.sandboxPolicy.resolve({ session: agent.session }).mode, 'read-only');
  assert.equal(mini.ctx.permissionPresets.current(agent.session), 'read-only');
  assert.equal(mini.ctx.agentPresets.composedPreset(agent.ctx), 'local-mini');
  assert.ok(mini.ctx.tools.executable('audit_tool', agent), 'ordinary native tool remains available');
  assert.equal(agent.session.snapshotEvents().findLast(e => e.type === 'approval/policy').data.policy, 'ask');
  const parts = []; for await (const part of mini.ctx.attachments.readFileStream(file)) parts.push(Buffer.from(part));
  assert.equal(Buffer.concat(parts).toString(), 'native exact file payload');
  agent.followup(user('Continue the ordinary model with the compacted history.')); await agent.whenIdle();
  assert.equal(mini.errors.length, 0, mini.errors.join('\n')); assert.equal(mini.executions(), 0, 'old tool calls never rerun');
  const continued = JSON.stringify(mini.calls.at(-1).messages);
  assert.match(continued, /runtime on mini/); assert.doesNotMatch(continued, /runtime on air/);
  assert.match(continued, /current machine mini/); assert.doesNotMatch(continued, /current machine air/);
  assert.match(continued, /Native compacted checkpoint/);
  await mini.sharing.checkpoint(active.sessionId);
  loseNextRelease=true;await assert.rejects(mini.sharing.handoff(active.sessionId),/lost committed release response/);
  await mini.sharing.recover(active.sessionId);
  assert.equal(mini.sharing.replica(active.sessionId).pending,undefined);assert.equal(mini.sharing.replica(active.sessionId).token,undefined);
  const returned = await air.sharing.open('verified-host', shared.sharedId, true), back = air.ctx.agents.get(returned.sessionId);
  assert.notEqual(returned.sessionId, id); assert.equal(air.ctx.agents.get(id), original.agent);
  back.followup(user('Continue on Air after handoff.')); await back.whenIdle();
  assert.match(JSON.stringify(air.calls.at(-1).messages), /ordinary reply from mini/);
  // Real pre-step has already claimed input. It must not disappear when SSH is lost.
  const callsBeforeFailure = air.calls.length; offline = true;
  back.followup(user('Retain this rejected prompt.')); await back.whenIdle();
  assert.equal(air.calls.length, callsBeforeFailure);
  assert.match(JSON.stringify(air.sharing.recoveryInput(returned.sessionId)), /Retain this rejected prompt/);
  offline = false;
  const beforeImage = air.calls.length;
  back.followup(user([{type:'text',text:'Oversized image input must remain recoverable'}, {type:'image',attachment:{attachmentId:'sha256:'+'a'.repeat(64),mediaType:'image/png',bytes:5*1024*1024,width:1,height:1}}]));
  await back.whenIdle(); assert.equal(air.calls.length,beforeImage);
  assert.match(JSON.stringify(air.sharing.recoveryInput(returned.sessionId)), /Oversized image input/);
  const command = await air.ctx.commands.execute(back, '/safe_probe', [], new AbortController().signal);
  assert.equal(command.result.kind, 'success');
  assert.match(command.result.text, /native command ran/);
  const callsBeforeAux = air.calls.length;
  for await (const _chunk of air.ctx.llm.stream({ sessionId: returned.sessionId, provider: 'test-native', model: 'model', messages: [], purpose: 'compaction' })) {}
  assert.equal(air.calls.length, callsBeforeAux+1);
  // A duplicate GUI restore cannot bypass the synchronous creation barrier.
  await assert.rejects(air.ctx.agents.resume({ resumeSessionId: id }), /closed|owned|already/i);
  // Unload deliberately closes the local route; it must never contaminate remote history.
  await air.sharing.checkpoint(returned.sessionId);
  const checkpoint = await rpc({protocol:'shared-native-v1',instance:'instance-air',action:'get',id:shared.sharedId});
  back.session.append('session/title', {title:'UNPUBLISHED LOCAL TAIL',source:{kind:'user'},messageSeqs:[]});
  await air.reload();
  await assert.rejects(air.sharing.checkpoint(returned.sessionId), /unreviewed local tail/);
  await assert.rejects(air.sharing.handoff(returned.sessionId), /unreviewed local tail/);
  await assert.rejects(air.sharing.open('verified-host',shared.sharedId,true), /handoff/);
  const closed = await air.ctx.sessionPersistence.open(returned.sessionId,'read');
  const localTail = (await closed.read()).events; await closed.close();
  assert.ok(localTail.some(e=>e.type==='model/selection' && e.data.provider==='shared-native-closed'));
  assert.ok(localTail.some(e=>e.type==='session/title' && e.data.title==='UNPUBLISHED LOCAL TAIL'));
  await air.sharing.recover(returned.sessionId);
  const afterRecovery = await rpc({protocol:'shared-native-v1',instance:'instance-air',action:'get',id:shared.sharedId});
  assert.deepEqual(afterRecovery.snapshot, checkpoint.snapshot);
  assert.ok(!afterRecovery.snapshot.events.some(e=>e.type==='model/selection' && e.data.provider==='shared-native-closed'));
  const resumed = await air.sharing.open('verified-host',shared.sharedId,true);
  const resumedAgent=air.ctx.agents.get(resumed.sessionId); resumedAgent.followup(user('Ordinary model still works after unload and explicit recovery')); await resumedAgent.whenIdle();
  assert.match(JSON.stringify(air.calls.at(-1).messages), /Ordinary model still works/);
  // A self-contained ordinary branch keeps its exact inherited cut and runs as
  // a new root on the receiver, without recreating its old runtime parent.
  const forkId=sessions.SessionId(randomUUID()), seed=sessions.buildForkSeed(before,before.at(-1).seq);
  const fork=await air.ctx.agents.create({sessionId:forkId,seed,inheritedEventCount:before.length,meta:{cwd:air.workspacePath,isSeeded:true,parentSession:id},agentOptions:{provider:'test-native',model:'model'}});sourceHandles.push(fork);
  const forkShared=await air.sharing.share(forkId,'verified-host'), forkCopy=await mini.sharing.open('verified-host',forkShared.sharedId,true);
  const forkAgent=mini.ctx.agents.get(forkCopy.sessionId);
  assert.equal(forkAgent.session.inheritedEventCount,before.length);assert.equal(forkAgent.session.header.parentSession,id);
  assert.deepEqual(forkAgent.session.snapshotEvents(0,before.length),before);
  forkAgent.followup(user('Continue the imported ordinary branch'));await forkAgent.whenIdle();assert.match(JSON.stringify(mini.calls.at(-1).messages),/ordinary branch/);
  // Cancellation restores the model through public native APIs, while keeping
  // historical closure events intact. Both reshare paths must remain usable.
  const cancelId=sessions.SessionId(randomUUID()), cancelSource=await air.ctx.agents.create({sessionId:cancelId,meta:{cwd:air.workspacePath},agentOptions:{provider:'test-native',model:'model'}});sourceHandles.push(cancelSource);
  cancelSource.agent.followup(user('Native cancellation and reshare regression'));await cancelSource.agent.whenIdle();
  failNextCreate=true;await assert.rejects(air.sharing.share(cancelId,'verified-host'),/simulated rejected create/);
  await air.sharing.cancelEnrollment(cancelId);assert.equal(cancelSource.agent.model.current().provider,'test-native');
  const again=await air.sharing.share(cancelId,'verified-host'), againCopy=await mini.sharing.open('verified-host',again.sharedId,true);
  const againAgent=mini.ctx.agents.get(againCopy.sessionId);againAgent.followup(user('Continue after cancelling and resharing'));await againAgent.whenIdle();
  assert.match(JSON.stringify(mini.calls.at(-1).messages),/cancelling and resharing/);
  const closedHistory=cancelSource.agent.session.snapshotEvents(), privateId=sessions.SessionId(randomUUID());
  const privateFork=await air.ctx.agents.create({sessionId:privateId,seed:sessions.buildForkSeed(closedHistory,closedHistory.at(-1).seq),inheritedEventCount:closedHistory.length,meta:{cwd:air.workspacePath,isSeeded:true,parentSession:cancelId},agentOptions:{provider:'test-native',model:'model'}});sourceHandles.push(privateFork);
  privateFork.agent.model.select({provider:'test-native',model:'model'});
  const privateShared=await air.sharing.share(privateId,'verified-host'), privateCopy=await mini.sharing.open('verified-host',privateShared.sharedId,true);
  const privateAgent=mini.ctx.agents.get(privateCopy.sessionId);privateAgent.followup(user('Continue explicitly selected fork from a closed native copy'));await privateAgent.whenIdle();
  assert.match(JSON.stringify(mini.calls.at(-1).messages),/explicitly selected fork/);
  process.stdout.write(JSON.stringify({ twoInstancesContinue: true, compactedToolHistory: true, fileIntegrity: true,
    readOnlyReceiver: true, importNoExecution: true, rebuiltRuntime: true, roundTripLinkedCopies: true, rejectedInputRetained: true, auxiliaryAllowed: true,
    realWorkspaceController: true, realPermissionPresets: true, restartTailRefused: true, closedNeverPublished: true, ordinaryToolsAvailable: true, branchMetadata: true,
    committedReleaseRecovered: true, cancellationReshare: true, closedForkReshare: true }) + '\n');
} finally {
  for (const handle of sourceHandles) await handle.dispose();
  for (const fork of mounted.reverse()) await fork.dispose();
  await rm(root, { recursive: true, force: true });
}
