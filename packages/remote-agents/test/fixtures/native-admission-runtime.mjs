// Real native inbox, GoalService, public persistence and manager. Stub LLM only.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {realpath} from 'node:fs/promises';
import {host,load,sessions,llm,sourceHandles,user,cleanup} from './native-runtime-rig.mjs';
import {nativeRuntimeAutonomy} from '../../src/chat/native-runtime-autonomy.ts';
import {nativeDigest} from '../../src/chat/native-protocol.ts';
import {NativeAdmissionReceipts} from '../../src/chat/native-admission-receipts.ts';
const mode=process.argv[3]??'cold-retry',signal=()=>new AbortController().signal;
const tick=()=>new Promise(r=>setImmediate(r));
const settle=async(h,a)=>{await tick();await a.whenIdle();await h.ctx.sessionTitle.refresh(a.session);await tick();};
const observe=async(h,id)=>{const o=await h.ctx.sessionQuery.observeSession(id,{projectionMode:'none'});try{return structuredClone(o.events);}finally{o[Symbol.dispose]();}};
try {
 const air=await host('admission-air',true),mini=await host('admission-mini',true),A=await realpath(air.workspacePath),B=await realpath(mini.workspacePath);
 await air.sharing.setMapping('verified-host',A,A,A);await mini.sharing.setMapping('verified-host',A,B,B);
 for(const h of [air,mini]){
   await h.mount((await load('dsh-goal')).default);
   await h.mount((await load('dsh-subagent')).default,{maxDepth:3,maxActiveSubagents:8});
   await h.mount(await load('dsh-subagent-spawn-in-process'),{providerName:'spawn'});
   await h.mount(await load('dsh-tool-subagent-control'));
 }
 const rootHandle=await air.ctx.agents.create({sessionId:sessions.SessionId(randomUUID()),meta:{cwd:A},agentOptions:{provider:'test-native',model:'model'}});sourceHandles.push(rootHandle);const original=rootHandle.agent;
 await(await air.ctx.workspaceRegistry.create(A)).attachSession(original.id);
 original.followup(user('Native exact admission receipts'));await settle(air,original);
 const parked=user('Identified parked input: do not mutate this user text');let childId,goal;
 if(mode==='goal-lost'){
   const created=air.ctx.goals.create(original,{objective:'Native goal lost acknowledgement receipt',maxGoalRounds:2});goal=air.ctx.goals.pause(original,{id:created.id,revision:created.revision});
   await air.ctx.sessions.flush(original.session);
 }else{
   childId=sessions.SessionId(randomUUID());
   const run=await air.ctx.subagents.startActivation({provider:'spawn',childId,label:'receipt child',request:{parent:original,prompt:[{type:'text',text:'Completed initial child turn before parking input'}],maxDepth:3},signal:signal(),delivery:'caller'});
   const child=air.ctx.agents.get(childId);if(child)await child.whenIdle();await run.dispose();await run.result;assert.equal(air.ctx.agents.get(childId),undefined);
   // This cold identity owns no active writer. Append through the actual public
   // persistence handle, not JSONL edits and not a resumed/awakened Agent.
   const handle=await air.ctx.sessionPersistence.open(childId,'write');
   try{const {events}=await handle.read(),detached=sessions.Session.create(childId,events,handle.header,handle.inheritedEventCount,air.ctx.sessions.messageProjections);
     detached.append('agent/inbox/spliced',{target:'next-turn',start:0,inserted:[parked]});await handle.append(detached.snapshotEvents(events.length));await handle.flush();
   }finally{await handle.close();}
 }
 const shared=await air.sharing.share(original.id,'verified-host'),beforeImport=mini.calls.length;
 const opened=await mini.sharing.open('verified-host',shared.sharedId,true),root=mini.ctx.agents.get(opened.sessionId);
 assert.equal(mini.calls.length,beforeImport,'import never executes work');
 const owner=mini.sharing.autonomyOwner(root.id),nativeHost=mini.sharing.host.autonomy;
 const reloadQuery=()=>nativeRuntimeAutonomy(name=>mini.ctx.get(name),name=>load(name.replace('@deepseek-ai/','')),mini.sharing.host,mini.sharing).queryWork;
 let checkedKey,localAcceptanceCount=0;
 if(mode==='goal-lost'){
   await mini.mount(await load('dsh-goal-round-driver'));
   const before= root.session.snapshotEvents().length, nativeResume=mini.ctx.goals.resume;let resumes=0;
   mini.ctx.goals.resume=function(...args){resumes++;nativeResume.apply(this,args);throw Error('lost native goal reply after CAS event');};
   await assert.rejects(mini.sharing.resumeAutonomy(root.id,{goals:true}),/lost native goal reply/);
   mini.ctx.goals.resume=nativeResume;
   const packet=mini.sharing.autonomy.plan(root.id).bundle.goals.find(g=>g.state.id===goal.id);
   checkedKey=`goal/${packet.sessionId}/${packet.adapter}`;
   const receipt=mini.sharing.autonomy.status(root.id).receipts[checkedKey];assert.equal(receipt.state,'uncertain');
   const req=receipt.request,events=await observe(mini,root.id);
   const resumeEvents=events.slice(before).filter(e=>e.type==='goal/change'&&e.data.operation==='resume'&&e.data.goal.id===goal.id&&e.data.goal.revision===goal.revision+1);assert.equal(resumeEvents.length,1);
   nativeHost.queryWork=reloadQuery();
   const exact=await nativeHost.queryWork(req);assert.equal(exact.state,'accepted');assert.equal(exact.requestDigest,req.requestDigest);
   assert.equal((await mini.sharing.inspectWork(root.id,checkedKey)).state,'done');
   await mini.sharing.resumeAutonomy(root.id,{goals:true});assert.equal(resumes,1,'lost acknowledgement never resumes the goal twice');
   for(let n=0;n<200&&mini.ctx.goals.get(root).activation==='armed';n++)await new Promise(r=>setTimeout(r,10));
   await settle(mini,root);assert.ok(mini.ctx.goals.get(root).roundsStarted>0);localAcceptanceCount=resumeEvents.length;
 }else{
   const id=owner.agentAliases[childId],key='queue/'+parked.id;checkedKey=key;
   assert.equal(mini.ctx.agents.get(id),undefined);
   const payload={target:'next-turn',message:parked},request={kind:'queue',sessionId:id,payload,startedAt:new Date().toISOString(),runId:'test-query',requestDigest:nativeDigest({kind:'queue',sessionId:id,payload})};
   assert.ok((await observe(mini,id)).some(e=>e.type==='agent/inbox/spliced'&&e.data.inserted.some(m=>m.id===parked.id)),'imported history contains the source insertion');
   assert.equal((await nativeHost.queryWork(request)).state,'unknown','imported source insertion is not receiver admission proof');
   if(mode==='cold-retry'){
     await assert.rejects(mini.sharing.resumeAutonomy(root.id,{queues:true}),e=>e.accepted===false&&e.code==='native_child_cold');
     const refused=mini.sharing.autonomy.status(root.id).receipts[key];assert.equal(refused.state,'not-accepted');assert.equal(refused.code,'native_child_cold');
   }
   const pause=mini.armModelDelay(id);
   await mini.ctx.subagents.sendMessage(root,id,[{type:'text',text:'User explicitly cold-restored this child'}],{signal:signal()});await pause.arrived;
   const agent=mini.ctx.agents.get(id),cut=agent.session.snapshotEvents().length;
   if(mode==='cold-retry')await mini.sharing.retryWork(root.id,key);
   else{
     const deliver=nativeHost.deliver;let calls=0;
     const saveProof=NativeAdmissionReceipts.prototype.proof;
     if(mode==='queue-proof-lost')NativeAdmissionReceipts.prototype.proof=function(){throw Error('lost queue reply before local proof write');};
     nativeHost.deliver=async(...args)=>{calls++;await deliver(...args);throw Error('lost queue reply after exact native enqueue');};
     await assert.rejects(mini.sharing.resumeAutonomy(root.id,{queues:true}),/lost queue reply/);nativeHost.deliver=deliver;assert.equal(calls,1);
     NativeAdmissionReceipts.prototype.proof=saveProof;
     assert.equal(mini.sharing.autonomy.status(root.id).receipts[key].state,'uncertain');
     const req=mini.sharing.autonomy.status(root.id).receipts[key].request;
     nativeHost.queryWork=reloadQuery();
     const proof=await nativeHost.queryWork(req);assert.equal(proof.state,'accepted');assert.equal(proof.requestDigest,req.requestDigest);
     const altered=structuredClone(req);altered.payload.message.source={kind:'user',unexpected:'same text but different envelope'};
     altered.requestDigest=nativeDigest({kind:altered.kind,sessionId:altered.sessionId,payload:altered.payload});assert.notEqual((await nativeHost.queryWork(altered)).state,'accepted','message text similarity is not receipt evidence');
     assert.equal((await mini.sharing.inspectWork(root.id,key)).state,'done');
   }
   await mini.sharing.resumeAutonomy(root.id,{queues:true});
   const inserted=agent.session.snapshotEvents().slice(cut).filter(e=>e.type==='agent/inbox/spliced').flatMap(e=>e.data.inserted).filter(m=>m.id===parked.id);
   assert.equal(inserted.length,1,'explicit retry or reconciliation results in one receiver enqueue');assert.deepEqual(inserted[0],parked);localAcceptanceCount=inserted.length;
   pause.release();await agent.whenIdle();await mini.ctx.subagents.waitForChildren(root);await settle(mini,root);
   const log=await observe(mini,id);assert.equal(log.filter(e=>e.type==='user/message'&&e.data.id===parked.id).length,1,'the original message reaches the model once');
 }
 assert.equal(mini.sharing.autonomy.status(root.id).receipts[checkedKey].state,'done');
 await mini.sharing.handoff(root.id);const back=await air.sharing.open('verified-host',shared.sharedId,true);await air.sharing.checkpoint(back.sessionId);
 process.stdout.write(JSON.stringify({mode,realRuntime:true,importZeroExecution:true,exactNativeIdentity:true,localAcceptanceCount,noAutomaticReplay:true,receiptRestartQuery:mode!=='cold-retry',roundTripHandoff:true,stubLLM:true})+'\n');
}finally{await cleanup();}
