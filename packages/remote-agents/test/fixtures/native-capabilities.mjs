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
 const air = await host('air');
 const hook = [];
 air.ctx.on('llm/stream', async function* (options,next) { hook.push({purpose:options.purpose ?? 'ordinary',sessionId:options.sessionId}); yield* next(); }, {global:true,prepend:true});
 const original = await air.ctx.agents.create({sessionId:sessions.SessionId(randomUUID()),meta:{cwd:air.workspacePath},agentOptions:{provider:'test-native',model:'model'}}); sourceHandles.push(original);
 original.agent.followup(user('A long tool conversation. '.repeat(1000))); await original.agent.whenIdle();
 const largeResult=original.agent.session.snapshotEvents().find(e=>e.type==='tool/result');
 assert.equal(largeResult.data.message.content[0].text,'native tool result '.repeat(20000));assert.equal(largeResult.data.meta.spillPath,'/opaque/do-not-read');
 original.agent.followup(user('Second ordinary round. '.repeat(1000))); await original.agent.whenIdle();
 await air.ctx.sessionTitle.refresh(original.agent.session);
 await air.ctx.compaction.compactNow(original.agent,new AbortController().signal);
 assert.ok(hook.some(c=>c.purpose==='compaction')); assert.ok(hook.some(c=>c.purpose==='session-title')); assert.equal(air.executions(),1);
 const png = await sharp({create:{width:64,height:64,channels:3,background:{r:100,g:10,b:30}}}).png().toBuffer();
 const ref = await air.ctx.attachments.saveImage({data:png,mediaType:'image/png',name:'probe.png'});
 const stored = await air.ctx.attachments.readImage(ref);
 const same = await air.ctx.attachments.saveImage({data:stored.data,mediaType:ref.mediaType,name:ref.name});
 const receiverCtx = new Context(); const attachmentFork = receiverCtx.plugin(attachments.default,{dshHome:join(root,'image-receiver'),normalizedImageMaxPixels:256}); mounted.push(attachmentFork); await attachmentFork.await();
 const different = await receiverCtx.attachments.saveImage({data:stored.data,mediaType:ref.mediaType,name:ref.name});
 assert.equal(same.attachmentId,ref.attachmentId); assert.notEqual(different.attachmentId,ref.attachmentId);
 const mini = await host('mini');
 const imageMessage=user([{type:'text',text:'Retain this exact picture and continue. '.repeat(500)},{type:'image',attachment:ref}]);
 original.agent.followup(imageMessage); await original.agent.whenIdle(); await air.ctx.sessionTitle.refresh(original.agent.session);
 const imageSeq=original.agent.session.snapshotEvents().findLast(e=>e.type==='user/message' && e.data.content.some(b=>b.type==='image')).seq;
 original.agent.session.append('image/offload',{targets:[{seq:imageSeq,imageIndexes:[0]}]});
 const shared = await air.sharing.share(original.agent.id,'verified-host');
 const beforeImport=mini.calls.length;
 const active=await mini.sharing.open('verified-host',shared.sharedId,true);
 const continued=mini.ctx.agents.get(active.sessionId);
 assert.ok(continued.session.deriveMessages().some(m=>m.content.some(b=>b.type==='image' && b.offloaded===true)),'native image-offload history is restored');
 assert.equal(mini.calls.length,beforeImport,'import/compose must not invoke a model'); assert.equal(mini.executions(),0,'import must not execute tools');
 const importedImage=await mini.ctx.attachments.readImage(ref); assert.deepEqual(Buffer.from(importedImage.data),Buffer.from(stored.data));
 assert.equal(importedImage.ref.attachmentId,ref.attachmentId); assert.equal(importedImage.ref.width,64,'source object survives receiver normalization policy');
 assert.equal(mini.ctx.permissionPresets.current(continued.session),'read-only');
 assert.equal(mini.ctx.sandboxPolicy.resolve({session:continued.session}).mode,'read-only');
 assert.equal(continued.session.snapshotEvents().findLast(e=>e.type==='approval/policy').data.policy,'ask');
 let commandRan=0; mini.ctx.commands.register({name:'native_probe',description:'Safe isolated slash probe',handler:()=>{commandRan++; return {kind:'success',text:'native command works'};}});
 await mini.ctx.commands.execute(continued,'/native_probe',[],new AbortController().signal); assert.equal(commandRan,1,'ordinary commands are not shadowed');
 const nativeTool=await mini.ctx.tools.execute({agent:continued,calls:[{type:'tool-call',id:llm.ToolCallId('ordinary-native-tool'),name:'audit_tool',arguments:'{}'}],signal:new AbortController().signal});
 assert.ok(!nativeTool.results[0].result.isError); assert.equal(mini.executions(),1);
 const deniedWrite=await mini.ctx.tools.execute({agent:continued,calls:[{type:'tool-call',id:llm.ToolCallId('write-probe'),name:'write',arguments:JSON.stringify({file_path:join(mini.workspacePath,'forbidden.txt'),content:'must not write'})}],signal:new AbortController().signal});
 assert.equal(deniedWrite.results[0].result.isError,true); assert.match(JSON.stringify(deniedWrite),/read-only|FS_SANDBOX_DENIED/);
 await mini.ctx.compaction.compactNow(continued,new AbortController().signal);
 const compactCall=mini.calls.findLast(c=>c.purpose==='compaction'); assert.ok(compactCall,'fresh compaction executes on receiver');
 assert.match(JSON.stringify(compactCall.messages),/runtime on mini/); assert.doesNotMatch(JSON.stringify(compactCall.messages),/runtime on air|current machine air/);
 assert.ok(compactCall.tools.some(t=>t.name==='audit_tool'),'compaction gets receiver native tools');
 continued.followup(user([{type:'text',text:'Continue with this new image.'},{type:'image',attachment:ref}])); await continued.whenIdle();
 await mini.ctx.sessionTitle.refresh(continued.session);
 assert.ok(mini.calls.some(c=>c.purpose==='session-title'),'ordinary auxiliary title call executes');
 assert.equal(mini.errors.length,0,mini.errors.join('\n'));
 assert.match(JSON.stringify(mini.calls.filter(c=>!c.purpose).at(-1).messages),/runtime on mini/);
 const titleDelay=mini.armTitleDelay();
 continued.followup(user('Exercise title completion after the stream has ended.')); await continued.whenIdle(); await titleDelay.arrived;
 await assert.rejects(mini.sharing.handoff(active.sessionId),/Background model call/);
 titleDelay.release(); await new Promise(r=>setImmediate(r));
 await mini.ctx.sessionTitle.refresh(continued.session);
 let releaseCommand,commandEntered; const commandStarted=new Promise(r=>commandEntered=r),commandBlock=new Promise(r=>releaseCommand=r);
 mini.ctx.commands.register({name:'delayed_probe',description:'A command with an awaited local operation',handler:async()=>{commandEntered();await commandBlock;return {kind:'success'};}});
 const commandPromise=mini.ctx.commands.execute(continued,'/delayed_probe',[],new AbortController().signal);await commandStarted;
 await assert.rejects(mini.sharing.handoff(active.sessionId),/Background model call/);releaseCommand();await commandPromise;
 await mini.sharing.checkpoint(active.sessionId);
 const committed = await rpc({protocol:'shared-native-v1',instance:'test-probe',action:'get',id:shared.sharedId}); assert.ok(committed.snapshot.files.some(f=>f.ref.attachmentId===ref.attachmentId));
 const beforeOffline=mini.calls.length; offline=true;
 await assert.rejects(async()=>{for await(const _ of mini.ctx.llm.stream({provider:'test-native',model:'model',messages:[],sessionId:active.sessionId,purpose:'session-title'})){}},/disconnect/);
 const beforeTitleReject=continued.session.snapshotEvents().length;
 await assert.rejects(mini.ctx.sessionTitle.refresh(continued.session),/disconnect/);
 assert.equal(continued.session.snapshotEvents().length,beforeTitleReject,'denied title does not append a request or fallback');
 assert.equal(mini.calls.length,beforeOffline,'offline auxiliary call is fenced before LLM'); offline=false;
 await mini.sharing.handoff(active.sessionId);
 const roundTrip=await air.sharing.open('verified-host',shared.sharedId,true);
 const back=air.ctx.agents.get(roundTrip.sessionId); assert.deepEqual(Buffer.from((await air.ctx.attachments.readImage(ref)).data),Buffer.from(stored.data));
 back.followup(user('Continue on air after new native compression.')); await back.whenIdle(); await air.ctx.sessionTitle.refresh(back.session);
 assert.equal(air.errors.length,0,air.errors.join('\n'));
 const localAir=await host('local-air',true), localMini=await host('local-mini',true);
 const pathA=await realpath(localAir.workspacePath), pathB=await realpath(localMini.workspacePath);
 await writeFile(join(pathA,'identity.txt'),'local AIR project file'); await writeFile(join(pathB,'identity.txt'),'local MINI project file');
 const localOriginal=await localAir.ctx.agents.create({sessionId:sessions.SessionId(randomUUID()),meta:{cwd:pathA},agentOptions:{provider:'test-native',model:'model'}}); sourceHandles.push(localOriginal);
 localOriginal.agent.followup(user('Native local project transfer')); await localOriginal.agent.whenIdle(); await localAir.ctx.sessionTitle.refresh(localOriginal.agent.session);
 assert.equal((await localAir.sharing.sourceProject(localOriginal.agent.id,'verified-host')).mappingRequired,true);
 await assert.rejects(localAir.sharing.share(localOriginal.agent.id,'verified-host'),/Project mapping required/);
 await localAir.sharing.setMapping('verified-host',pathA,pathA,pathA);
 await localMini.sharing.setMapping('verified-host',pathA,pathB,pathB);
 const localShared=await localAir.sharing.share(localOriginal.agent.id,'verified-host');
 const localOpen=await localMini.sharing.open('verified-host',localShared.sharedId,true), localAgent=localMini.ctx.agents.get(localOpen.sessionId);
 assert.equal(localAgent.session.header.cwd,pathB); assert.deepEqual(localMini.sharing.replica(localOpen.sessionId).placement,{kind:'local',project:pathA,localDirectory:pathB});
 const readAt=async (h,a,id)=>h.ctx.tools.execute({agent:a,calls:[{type:'tool-call',id:llm.ToolCallId(id),name:'read',arguments:JSON.stringify({file_path:'identity.txt'})}],signal:new AbortController().signal});
 const miniRead=await readAt(localMini,localAgent,'local-mini-read'); assert.match(JSON.stringify(miniRead),/local MINI project file/); assert.doesNotMatch(JSON.stringify(miniRead),/local AIR project file/);
 await mkdir(join(pathB,'subdir'));await localMini.ctx.workingDirectory.set(localAgent,'subdir');
 assert.equal(localMini.ctx.workingDirectory.get(localAgent.session),join(pathB,'subdir'));
 localAgent.followup(user('Continue ordinary native model in local B.')); await localAgent.whenIdle(); await localMini.ctx.sessionTitle.refresh(localAgent.session);
 await localMini.sharing.handoff(localOpen.sessionId);
 const localReturn=await localAir.sharing.open('verified-host',localShared.sharedId,true), localBack=localAir.ctx.agents.get(localReturn.sessionId);
 assert.equal(localBack.session.header.cwd,pathA);assert.equal(localAir.ctx.workingDirectory.get(localBack.session),pathA,'receiver rebuilds cwd instead of reusing source subdirectory');
 const airRead=await readAt(localAir,localBack,'local-air-read'); assert.match(JSON.stringify(airRead),/local AIR project file/); assert.doesNotMatch(JSON.stringify(airRead),/local MINI project file/);
 localBack.followup(user('Continue ordinary native model in local A.')); await localBack.whenIdle(); await localAir.ctx.sessionTitle.refresh(localBack.session);
 assert.equal(localAir.errors.length,0,localAir.errors.join('\n')); assert.equal(localMini.errors.length,0,localMini.errors.join('\n'));
 await localAir.mount((await load('dsh-goal')).default);
 const goalId=sessions.SessionId(randomUUID()), goalHandle=await localAir.ctx.agents.create({sessionId:goalId,meta:{cwd:pathA},agentOptions:{provider:'test-native',model:'model'}});
 sourceHandles.push(goalHandle);
 const goal=localAir.ctx.goals.create(goalHandle.agent,{objective:'Retain the goal state but do not automatically resume it',maxGoalRounds:3});
 assert.equal(goal.activation,'armed');
 const goalWorkspace=await localAir.ctx.workspaceRegistry.create(pathA);await goalWorkspace.attachSession(goalId);
 await localAir.ctx.sessions.flush(goalHandle.agent.session);await localAir.ctx.workspaceRegistry.archiveSession(goalId);
 const archiveKeepsArmed=localAir.ctx.goals.get(goalHandle.agent).activation==='armed';
 localAir.ctx.goals.disarm(goalHandle.agent);assert.equal(localAir.ctx.goals.get(goalHandle.agent).activation,'disarmed');
 await goalHandle.dispose();sourceHandles.splice(sourceHandles.indexOf(goalHandle),1);
 await localAir.ctx.workspaceRegistry.unarchiveSession(goalId);
 const beforeGoalRestore=localAir.calls.length, goalRestored=await localAir.controller.resolveAgent(goalId);
 assert.ok(goalRestored.agent,String(goalRestored.error));const restoredGoal=localAir.ctx.goals.get(goalRestored.agent);
 assert.equal(restoredGoal.id,goal.id);assert.equal(restoredGoal.revision,goal.revision);assert.equal(restoredGoal.phase,'active');assert.equal(restoredGoal.activation,'disarmed');
 await localAir.mount(await load('dsh-goal-round-driver'));await new Promise(r=>setImmediate(r));
 assert.equal(localAir.calls.length,beforeGoalRestore,'cold goal restore and driver mount do not generate');
 assert.equal(localAir.ctx.goals.get(goalRestored.agent).activation,'disarmed');
 const paused=localAir.ctx.goals.pause(goalRestored.agent,{id:restoredGoal.id,revision:restoredGoal.revision});
 assert.equal(paused.activation,'disarmed');assert.equal(paused.phase,'paused');await localAir.ctx.sessions.flush(goalRestored.agent.session);
 const frozenGoal=captureNativeGoal(localAir.ctx.goals,goalRestored.agent,goalId), goalModule=await load('dsh-goal');
 const goalAdapter=nativeDshGoalAdapter(localAir.ctx.goals,{liveAgent:id=>localAir.ctx.agents.get(id),readColdGoal:async id=>{const observed=await localAir.ctx.sessionQuery.observeSession(id,{projectionMode:'none'});try{const f=goalModule.foldGoal(observed.events);return f.goal && {...f.goal,roundsStarted:f.roundsStarted,createdAt:f.createdAt,updatedAt:f.updatedAt};}finally{observed[Symbol.dispose]();}}});
 const goalCopyId=sessions.SessionId(randomUUID()), goalSource=await localAir.ctx.sessionQuery.observeSession(goalId,{projectionMode:'none'});
 try{const log=await localAir.ctx.sessionPersistence.create({...goalSource.header,id:goalCopyId},{inheritedEventCount:goalSource.inheritedEventCount});try{await log.append(goalSource.events);await log.flush();}finally{await log.close();}}finally{goalSource[Symbol.dispose]();}
 await goalWorkspace.attachSession(goalCopyId);const beforePausedImport=localAir.calls.length;
 await goalAdapter.importParked(frozenGoal,goalCopyId,'goal-import-probe');assert.equal(localAir.ctx.agents.get(goalCopyId),undefined);
 const pausedCopy=await localAir.controller.resolveAgent(goalCopyId);assert.equal(localAir.ctx.goals.get(pausedCopy.agent).activation,'disarmed');assert.equal(localAir.ctx.goals.get(pausedCopy.agent).phase,'paused');
 await new Promise(r=>setImmediate(r));assert.equal(localAir.calls.length,beforePausedImport,'paused goal import/restore performs no execution');
 await goalAdapter.resume(frozenGoal,goalCopyId,'goal-explicit-resume-probe');
 for(let n=0;n<200 && localAir.ctx.goals.get(pausedCopy.agent).roundsStarted===0;n++)await new Promise(r=>setTimeout(r,10));
 assert.ok(localAir.ctx.goals.get(pausedCopy.agent).roundsStarted>0,'explicit resume admits a native goal round');
 await pausedCopy.agent.whenIdle();localAir.ctx.goals.disarm(pausedCopy.agent);assert.ok(localAir.calls.length>beforePausedImport,'explicit goal resume calls ordinary model');
 await localAir.mount((await load('dsh-subagent')).default,{maxDepth:3,maxActiveSubagents:8});
 await localAir.mount(await load('dsh-subagent-spawn-in-process'),{providerName:'spawn'});
 await localAir.mount(await load('dsh-tool-subagent-control'));
 const aliasChildId=sessions.SessionId(randomUUID()), aliasPause=localAir.armModelDelay(aliasChildId);
 const activation=await localAir.ctx.subagents.startActivation({provider:'spawn',label:'Native alias probe',childId:aliasChildId,request:{parent:localBack,prompt:[{type:'text',text:`A controlled child for native adjacency tests. Historical parent ID: ${localBack.id}`}],maxDepth:3},signal:new AbortController().signal,delivery:'caller'});
 await aliasPause.arrived;const aliasChild=localAir.ctx.agents.get(aliasChildId);assert.ok(aliasChild);
 // Use actual native historical IDs from the persisted plan; never inject a
 // second synthetic alias registry over the production scoped registrations.
 const control=(caller,name,args,id)=>localAir.ctx.tools.execute({agent:caller,calls:[{type:'tool-call',id:llm.ToolCallId(id),name,arguments:JSON.stringify(args)}],signal:new AbortController().signal});
 const down=await control(localBack,'send_message',{agent_id:aliasChildId,message:'Keep historical-child unchanged in the payload'},'alias-down');assert.ok(!down.results[0].result.isError,JSON.stringify(down));
 assert.match(JSON.stringify(aliasChild.inbox.nextStep),/Keep historical-child unchanged/);
 const up=await control(aliasChild,'send_message',{agent_id:localOriginal.agent.id,message:'Keep historical-root unchanged in the payload'},'alias-up');assert.ok(!up.results[0].result.isError,JSON.stringify(up));
 await localBack.whenIdle();assert.ok(localBack.session.snapshotEvents().some(e=>e.type==='user/message'&&JSON.stringify(e.data).includes('Keep historical-root unchanged')));
 const invalidSend=await control(aliasChild,'send_message',{agent_id:goalRestored.agent.id,message:'must not deliver to an unrelated root'},'alias-no-escalation');assert.equal(invalidSend.results[0].result.isError,true,'alias must not permit messages to unrelated agents');
 offline=true;const beforeChildOffline=localAir.calls.length;
 await assert.rejects(async()=>{for await(const _ of localAir.ctx.llm.stream({provider:'test-native',model:'model',messages:[],sessionId:aliasChildId,purpose:'session-title'})){}},/disconnect/);
 assert.equal(localAir.calls.length,beforeChildOffline,'child stream is fenced by root ownership');offline=false;
 const stopped=await control(localBack,'interrupt_agent',{agent_id:aliasChildId},'alias-interrupt');assert.ok(!stopped.results[0].result.isError,JSON.stringify(stopped));aliasPause.release();await activation.dispose();await activation.result;
 const coldRows=await localAir.ctx.subagents.listDescendants(localBack.id);assert.ok(coldRows.some(r=>r.childId===aliasChildId||r.id===aliasChildId),'cold native descendant catalog remains discoverable');
 const sharedGoal=localAir.ctx.goals.create(localBack,{objective:'A paused native goal transferred with its child tree',maxGoalRounds:2});localAir.ctx.goals.pause(localBack,{id:sharedGoal.id,revision:sharedGoal.revision});
 await localAir.ctx.sessions.flush(localBack.session);
 await localMini.mount((await load('dsh-goal')).default);
 await localMini.mount((await load('dsh-subagent')).default,{maxDepth:3,maxActiveSubagents:8});
 await localMini.mount(await load('dsh-subagent-spawn-in-process'),{providerName:'spawn'});
 await localMini.mount(await load('dsh-tool-subagent-control'));
 // The sharing plugin was installed before these optional services; refresh its
 // lifecycle so its actual host binding discovers them, without loading a profile.
 await localMini.reload();
 await localAir.sharing.handoff(localReturn.sessionId);
 const beforeTreeImport=localMini.calls.length,treeOpen=await localMini.sharing.open('verified-host',localShared.sharedId,true),treeRoot=localMini.ctx.agents.get(treeOpen.sessionId);
 const treeOwner=localMini.sharing.autonomyOwner(treeRoot.id),newChildId=treeOwner.ids[aliasChildId];assert.ok(newChildId && newChildId!==aliasChildId);
 assert.equal(localMini.ctx.agents.get(newChildId),undefined,'tree import leaves child cold');assert.equal(localMini.calls.length,beforeTreeImport,'tree import executes no LLM');
 assert.equal(localMini.ctx.goals.get(treeRoot).id,sharedGoal.id);assert.equal(localMini.ctx.goals.get(treeRoot).activation,'disarmed');
 const treeChildLog=await localMini.ctx.sessionQuery.observeSession(newChildId,{projectionMode:'none'});try{assert.equal(treeChildLog.header.cwd,pathB);assert.equal(treeChildLog.header.parentSession,treeRoot.id);assert.ok(treeChildLog.events.some(e=>e.type==='user/message'&&JSON.stringify(e.data).includes(localBack.id)),'historical parent ID in text stays exact');assert.equal(treeChildLog.events.findLast(e=>e.type==='approval/policy').data.policy,'ask');}finally{treeChildLog[Symbol.dispose]();}
 const resumedChildPause=localMini.armModelDelay(newChildId);
 await localMini.ctx.subagents.sendMessage(treeRoot,newChildId,[{type:'text',text:'Explicit fresh continuation on the receiver'}],{signal:new AbortController().signal});await resumedChildPause.arrived;
 const treeChild=localMini.ctx.agents.get(newChildId);assert.equal(localMini.ctx.permissionPresets.current(treeChild.session),'read-only');
 const reply=await localMini.ctx.tools.execute({agent:treeChild,calls:[{type:'tool-call',id:llm.ToolCallId('imported-child-to-old-root'),name:'send_message',arguments:JSON.stringify({agent_id:localBack.id,message:'Native imported child replying through historical root alias'})}],signal:new AbortController().signal});assert.ok(!reply.results[0].result.isError,JSON.stringify(reply));
 await treeRoot.whenIdle();assert.ok(treeRoot.session.snapshotEvents().some(e=>e.type==='user/message'&&JSON.stringify(e.data).includes('Native imported child replying')));
 localMini.ctx.subagents.interrupt(newChildId,{kind:'ancestor',agent:treeRoot});resumedChildPause.release();await localMini.ctx.subagents.drainChildren(treeRoot,[newChildId]);
 await localMini.mount(await load('dsh-goal-round-driver'));await localMini.sharing.resumeAutonomy(treeRoot.id,{goals:true});
 for(let n=0;n<200 && localMini.ctx.goals.get(treeRoot).roundsStarted===0;n++)await new Promise(r=>setTimeout(r,10));
 assert.ok(localMini.ctx.goals.get(treeRoot).roundsStarted>0,'production explicit resume continues the imported native goal');await treeRoot.whenIdle();localMini.ctx.goals.disarm(treeRoot);
 process.stdout.write(JSON.stringify({runtime:'0.2.2-rc.1',streamHooks:hook.map(c=>c.purpose),normalNativeTool:true,largeOutputVerbatim:true,opaqueToolMetaPreserved:true,samePolicyImageStable:true,differentPolicyReencodes:true,losslessImageImport:true,imageOffloadReplay:true,receiverPermissions:true,ordinarySlash:true,freshCompaction:true,ordinaryTitle:true,fullAuxiliaryLifecycle:true,commandLifecycle:true,importZeroExecution:true,offlineAuxiliaryFenced:true,twoInstanceRoundTrip:true,localMappingRoundTrip:true,localToolCwd:true,receiverCwdRebuilt:true,goalColdRestoreDisarmed:true,goalArchiveKeepsArmed:archiveKeepsArmed,pausedGoalImportZeroExecution:true,explicitGoalResume:true,nativeAliasBothDirections:true,aliasPreservesAuthorization:true,childRootOwnership:true,coldDescendantDiscovery:true,productionTreeColdImport:true,productionHistoricalAlias:true,productionGoalResume:true})+'\n');
} finally { for(const h of sourceHandles) await h.dispose(); for(const fork of mounted.reverse()) await fork.dispose(); await rm(root,{recursive:true,force:true}); }
