// Real installed host components with a local fake SSH authority and fake LLM.
// All persistence/attachments live below one disposable directory. No profile is loaded.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { exportNativeAttachments, importNativeAttachments } from '../../src/chat/native-attachments.ts';
import { fileRefs } from '../../src/chat/native-protocol.ts';
import { installNativeSharing } from '../../src/chat/native-install.ts';
import { nativeDshGoalAdapter, captureNativeGoal } from '../../src/chat/native-autonomy.ts';
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
async function host(name, localMode = false) {
  const ctx = new Context(), directory = join(root, name), workspacePath = join(directory, 'workspace'); await mkdir(workspacePath, { recursive: true });
  async function mount(plugin, config) { const fork = ctx.plugin(plugin, config); mounted.push(fork); await fork.await(); }
  await mount(sessions.default); await mount(projections.default); await mount(agents.default); await mount(llm.default);
  await mount(prompts.default); await mount(tools.default); await mount(executor);
  await mount(persistence, { root: join(directory, 'sessions'), compression: 'zstd' });
  await mount(storage.default); await mount(json, { root: join(directory, 'storage') }); await mount(domain, { backend: 'json' });
  await mount(workspaces.default);
  await mount(query.SessionQueryEngine); await mount(sandbox.default, { mode: 'danger-full-access', workspaceRoot: workspacePath });
  await mount(approval.default, { policy: 'never' }); await mount(attachments.default, { dshHome: directory, ...(name.endsWith('mini') ? {normalizedImageMaxPixels:256} : {}) });
  await mount(subprocess.default); await mount(sandboxLocal.default); await mount(bashSandbox.default, { cwd: workspacePath });
  await mount(permissions.default, { defaultPreset: 'danger-full-access', presets: {
    'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
    'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
    ...(name.endsWith('mini') ? { 'read-only': { sandbox: 'read-only', approval: 'ask' } } : {}),
  } });
  await mount(commands.default); await mount(defaults.default, { provider: 'test-native', model: 'model' });
  await mount(loader.default, { baseUrl: pathToFileURL(directory + '/').href });
  // Host module-loader bridge: actual installed exports; never resolve/write a helper in the real deployment.
  ctx.loader.internal = { import: async specifier => load(specifier.replace('@deepseek-ai/', '')) };
  await mount(presets.default, { default: `local-${name}` });
  await ctx.agentPresets.register({ id: `local-${name}`, plugins: [] });
  ctx.commands.register({ name: 'goal', description: 'Must never run on a shared copy', handler: () => { throw new Error('unsafe command body executed'); } });
  await mount(meter.default); await mount(compaction.default, { auto: false, headroomTokens: 100, maxTokens: 100, retainTokens: 0 });
  await mount((await load('dsh-fs-sandbox')).default, {cwd:workspacePath});
  await mount((await load('dsh-working-directory')).default);
  await mount(await load('dsh-tool-fs'), {read:true,readImage:true,write:true,edit:true});
  await mount(await load('dsh-compaction-image-offload'));
  await mount(loop.default, {});
  const calls = [], errors = [], modelPauses = new Map(); let executions = 0;
  ctx.on('agent/error', payload => { errors.push(String(payload.error)); }, { global: true });
  ctx.tools.register({ name: 'audit_tool', description: 'Isolated counter', parameters: { type: 'object', properties: {} }, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }], presentationMeta:()=>({type:'file',resource:{type:'resource'},spillPath:'/opaque/do-not-read',schema:{type:'file',attachmentId:'opaque'}}) }, execute: async () => { executions++; return name==='air' ? 'native tool result '.repeat(20000) : 'native tool result'; } });
  ctx.llm.registerAdapter(['test-native'], new class extends llm.LlmAdapter {
    async listModels() { return [{ id: 'model', provider: 'test-native', name: 'Fake native', context: { contextWindow: 100000 }, inputModalities:['text','image'] }]; }
    async resolveModel() { return (await this.listModels())[0]; }
    async *stream(options) {
      calls.push(options);
      const pause=modelPauses.get(options.sessionId);
      if(pause && !options.purpose){pause.arrive();await Promise.race([pause.block,new Promise((_,reject)=>{if(options.signal?.aborted)return reject(options.signal.reason);options.signal?.addEventListener('abort',()=>reject(options.signal.reason),{once:true});})]);}
      if (name === 'air' && !options.purpose && !calls.some(c => c !== options && !c.purpose)) {
        const block = { type: 'tool-call', id: llm.ToolCallId('audit-tool-call'), name: 'audit_tool', arguments: '{}' };
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }; yield { type: 'block-end', index: 0, block }; yield { type: 'finish', reason: { kind: 'tool-calls' } }; return;
      }
      const text = options.purpose === 'session-title' ? 'Native capability probe title' : options.purpose === 'compaction' ? 'Native compacted checkpoint retains the tool result and task.' : `ordinary reply from ${name}`;
      yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }; yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }());
  ctx.systemPrompt.section({ name: 'machine', order: 1, text: `runtime on ${name}` });
  ctx.systemPrompt.context({ name: 'machine-context', order: 2, text: `current machine ${name}`, required: true });
  const workspace = { placement: async () => localMode ? ({hostIds:[]}) : ({ hostIds: ['verified-host'], cwd: '/srv/project' }),
    workspaces: { create: async () => { if(localMode) throw Error('Local mapping must never fall back to a remote workspace'); return { path: workspacePath }; } }, access: { resolve: async () => localMode ? ({hostIds:[]}) : ({ hostIds: ['verified-host'], cwd: '/srv/project' }) } };
  const service = { store: { directory: join(directory, 'plugin'), instance: async () => ({ id: `instance-${name}`, label: name }) }, withWorkspace: async (_hostId, verify, action) => { await verify(); return action({ nativeSharing: rpc }); } };
  let sharing, sharingFork;
  const mountSharing = async () => {
    const fork = ctx.plugin({ name: `native-sharing-${name}`, async apply(scope) { sharing = await installNativeSharing(scope, service, workspace); } });
    sharingFork = fork; mounted.push(fork); await fork.await();
  };
  const title = await load('dsh-session-title'), titleLlm = await load('dsh-session-title-all-prompts-llm');
  await mount(title.default, { fallbackMaxWords: 8, fallbackMaxBytes: 100, maxTitleBytes: 150 });
  let titlePause;
  const registerTitle=ctx.sessionTitle.register.bind(ctx.sessionTitle);
  ctx.sessionTitle.register=provider=>registerTitle({...provider,generate:async request=>{const result=await provider.generate(request); const pause=titlePause; if(pause){pause.arrive();await pause.block;}return result;}});
  await mount(titleLlm, { targetWords: 6, targetCjkCharacters: 12, maxInputBytes: 200000, maxOutputTokens: 100, timeoutMs: 5000 });
  await mountSharing();
  await sharing.configure('verified-host', true);
  return { ctx, mount, get sharing() { return sharing; }, calls, errors, workspacePath, executions: () => executions,
    controller: new ApiSessionAgentController(ctx), armModelDelay(id){let arrive,release;const arrived=new Promise(r=>arrive=r),block=new Promise(r=>release=r);modelPauses.set(id,{arrive,block});return {arrived,release(){modelPauses.delete(id);release();}};}, armTitleDelay(){let arrive,release;const arrived=new Promise(r=>arrive=r),block=new Promise(r=>release=r);titlePause={arrive,block};return {arrived,release(){titlePause=undefined;release();}};}, async reload() { await sharingFork.dispose(); await mountSharing(); } };
}
const user = content => llm.createUserMessage({ content: typeof content === 'string' ? [{ type: 'text', text: content }] : content, source: { kind: 'user' } });
const { createRequire } = await import('node:module');
const sharp = createRequire(join(runtime, '@deepseek-ai/dsh-attachment-local/package.json'))('sharp');
try {
 const air=await host('air'), hooks=[];
 air.ctx.on('llm/stream',async function*(options,next){hooks.push({purpose:options.purpose??'ordinary',sessionId:options.sessionId});yield*next();},{global:true,prepend:true});
 const h=await air.ctx.agents.create({sessionId:sessions.SessionId(randomUUID()),meta:{cwd:air.workspacePath},agentOptions:{provider:'test-native',model:'model'}});sourceHandles.push(h);
 h.agent.followup(user('Large result and ordinary hooks. '.repeat(500)));await h.agent.whenIdle();
 h.agent.followup(user('A second full native round. '.repeat(500)));await h.agent.whenIdle();await air.ctx.sessionTitle.refresh(h.agent.session);
 await air.ctx.compaction.compactNow(h.agent,new AbortController().signal);
 assert.ok(hooks.some(h=>h.purpose==='compaction'));assert.ok(hooks.some(h=>h.purpose==='session-title'));assert.ok(hooks.every(call=>call.sessionId===h.agent.id));
 const log=h.agent.session.snapshotEvents(),result=log.find(e=>e.type==='tool/result');
 assert.equal(result.data.message.content[0].text,'native tool result '.repeat(20000));assert.equal(result.data.meta.spillPath,'/opaque/do-not-read');assert.deepEqual(fileRefs(log),[]);
 const png=await sharp({create:{width:64,height:64,channels:3,background:{r:100,g:10,b:30}}}).png().toBuffer();
 const ref=await air.ctx.attachments.saveImage({data:png,mediaType:'image/png',name:'probe.png'}),stored=await air.ctx.attachments.readImage(ref);
 const same=await air.ctx.attachments.saveImage({data:stored.data,mediaType:ref.mediaType,name:ref.name});assert.equal(same.attachmentId,ref.attachmentId);
 const receiverCtx=new Context(),fork=receiverCtx.plugin(attachments.default,{dshHome:join(root,'lossless-receiver'),normalizedImageMaxPixels:256});mounted.push(fork);await fork.await();
 const normalized=await receiverCtx.attachments.saveImage({data:stored.data,mediaType:ref.mediaType,name:ref.name});assert.notEqual(normalized.attachmentId,ref.attachmentId);assert.equal(normalized.width,16);
 const files=await exportNativeAttachments(air.ctx.attachments,[{role:'user',content:[{type:'image',attachment:ref}]}]);
 await importNativeAttachments(receiverCtx.attachments,files,()=>load('dsh-attachment-local'));
 const imported=await receiverCtx.attachments.readImage(ref);assert.deepEqual(Buffer.from(imported.data),Buffer.from(stored.data));assert.equal(imported.ref.width,64);assert.equal(imported.ref.attachmentId,ref.attachmentId);
 process.stdout.write(JSON.stringify({runtime:'0.2.2-rc.1',ordinaryTool:true,largeResultBytes:result.data.message.content[0].text.length,largeResultVerbatim:true,opaqueMetaPreserved:true,compactionStreamHook:true,titlePreparedStreamHook:true,samePolicyStable:true,differentPolicyReencodes:true,losslessNativeImageImport:true,cacheReferenceObserved:false})+'\n');
} finally {for(const handle of sourceHandles)await handle.dispose();for(const fork of mounted.reverse())await fork.dispose();await rm(root,{recursive:true,force:true});}
