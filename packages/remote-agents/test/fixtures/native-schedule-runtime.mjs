// Real ScheduleService/storage/persistence; stub LLM, no user profile or actual schedules.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { host, load, sessions, sourceHandles, user, cleanup } from './native-runtime-rig.mjs';
const mode=process.argv[3]??'lifecycle';
try {
 const air=await host('schedule-air',true),mini=await host('schedule-mini',true);
 const A=await realpath(air.workspacePath),B=await realpath(mini.workspacePath);
 await air.sharing.setMapping('verified-host',A,A,A);await mini.sharing.setMapping('verified-host',A,B,B);
 for(const h of [air,mini]) {
   h.ctx.on('schedule/resolve-agent',async(id)=>{const a=h.ctx.agents.get(id);if(!a)throw Error('Test will not implicitly activate a scheduled target');return a;},{global:true,prepend:true});
   await h.mount((await load('dsh-schedule')).default,{});
 }
 const handle=await air.ctx.agents.create({sessionId:sessions.SessionId(randomUUID()),meta:{cwd:A},agentOptions:{provider:'test-native',model:'model'}});sourceHandles.push(handle);const original=handle.agent;
 await (await air.ctx.workspaceRegistry.create(A)).attachSession(original.id);
 original.followup(user('ScheduleService isolated acceptance'));await original.whenIdle();await air.ctx.sessionTitle.refresh(original.session);
 const future=new Date(Date.now()+3_600_000).toISOString();
 const active=await air.ctx.schedule.create({title:'Future active task',prompt:'No execution during migration',timing:{kind:'at',at:future},target:{kind:'session',sessionId:original.id}},original.id);
 const paused=await air.ctx.schedule.create({title:'Originally paused task',prompt:'Never auto-enable this task',timing:{kind:'every',every_seconds:3600},target:{kind:'session',sessionId:original.id}},original.id);
 const pausedState=await air.ctx.schedule.edit({id:paused.id,action:'update',patch:{active:false},expectedUpdatedAt:paused.updatedAt},original.id);assert.equal(pausedState.status,'paused');
 const conflict=await air.ctx.schedule.edit({id:paused.id,action:'update',patch:{active:true},expectedUpdatedAt:paused.updatedAt},original.id);assert.equal(conflict.code,'schedule_conflict');
 let expiring;
 if(mode==='expired') {
   expiring=await air.ctx.schedule.create({title:'Expired one shot',prompt:'Do not turn this into an immediate task',timing:{kind:'at',at:new Date(Date.now()+1000).toISOString()},target:{kind:'session',sessionId:original.id}},original.id);
   await air.ctx.schedule.edit({id:expiring.id,action:'update',patch:{active:false},expectedUpdatedAt:expiring.updatedAt},original.id);
 }
 await new Promise(r=>setImmediate(r));original.followup(user('Drain schedule notices before the checkpoint'));await original.whenIdle();await air.ctx.sessionTitle.refresh(original.session);
 const shared=await air.sharing.share(original.id,'verified-host');
 assert.equal((await air.ctx.schedule.view({id:active.id})).status,'paused','freeze pauses active source task');
 assert.equal((await air.ctx.schedule.view({id:paused.id})).status,'paused');
 const beforeCalls=mini.calls.length,opened=await mini.sharing.open('verified-host',shared.sharedId,true),receiver=mini.ctx.agents.get(opened.sessionId);
 assert.equal(mini.calls.length,beforeCalls);assert.equal((await mini.ctx.schedule.catalog()).length,0,'import creates no native schedule');
 const plans=mini.sharing.autonomy.plan(receiver.id),packetActive=plans.bundle.schedules.find(s=>s.id===active.id),packetPaused=plans.bundle.schedules.find(s=>s.id===paused.id);
 assert.equal(packetActive.resumeIntent??packetActive.status,'active');assert.equal(packetPaused.resumeIntent??packetPaused.status,'paused');
 if(mode==='lost-reply') {
   const nativeCreate=mini.ctx.schedule.create;let createCalls=0;
   mini.ctx.schedule.create=async function(...args){createCalls++;const task=await nativeCreate.apply(this,args);throw Error('lost native schedule create reply after commit');};
   await assert.rejects(mini.sharing.resumeAutonomy(receiver.id,{schedules:[active.id]}),/lost native schedule create reply/);
   assert.equal((await mini.ctx.schedule.catalog()).length,1);await assert.rejects(mini.sharing.resumeAutonomy(receiver.id,{schedules:[active.id]}),/unconfirmed/);assert.equal(createCalls,1,'receipt never issues a second create');
   mini.ctx.schedule.create=nativeCreate;
   const key='schedule/'+active.id,query=await mini.sharing.inspectWork(receiver.id,key);
   assert.equal(query.state,'candidate',JSON.stringify(query));assert.equal(query.candidates.length,1);
   await mini.sharing.reconcileWork(receiver.id,key,{candidateId:query.candidates[0]});
   await mini.sharing.resumeAutonomy(receiver.id,{schedules:[active.id]});assert.equal((await mini.ctx.schedule.catalog()).length,1);
 } else if(mode==='expired') {
   await new Promise(r=>setTimeout(r,Math.max(0,Date.parse(expiring.scheduledAt)-Date.now()+30)));
   await mini.sharing.resumeAutonomy(receiver.id,{activatePaused:[expiring.id]});
   assert.equal((await mini.ctx.schedule.catalog()).length,0,'expired one-shot never created with a new/immediate time');
   assert.equal(mini.sharing.autonomy.status(receiver.id).receipts['schedule/'+expiring.id].state,'expired');
   assert.equal(mini.calls.length,beforeCalls,'expired one-shot does not invoke a model');
 } else {
   await mini.sharing.resumeAutonomy(receiver.id,{schedules:[active.id,paused.id]});
   const tasks=await mini.ctx.schedule.catalog();assert.equal(tasks.length,1);assert.equal(tasks[0].status,'active');assert.equal(tasks[0].scheduledAt,active.scheduledAt);assert.equal(tasks[0].target.sessionId,receiver.id);
 }
 await new Promise(r=>setImmediate(r));receiver.followup(user('Drain receiver notices before handoff'));await receiver.whenIdle();await mini.ctx.sessionTitle.refresh(receiver.session);
 await mini.sharing.handoff(receiver.id);
 const returned=await air.sharing.open('verified-host',shared.sharedId,true);await air.sharing.checkpoint(returned.sessionId);
 const returnAgent=air.ctx.agents.get(returned.sessionId);assert.equal(returnAgent.session.header.cwd,A);
 assert.equal((await air.ctx.schedule.view({id:paused.id})).status,'paused','original paused source remains paused after round trip');
 process.stdout.write(JSON.stringify({mode,realScheduleService:true,realIsolatedStorage:true,sourcePauseCAS:true,importZeroCreate:true,originalPausedStaysPaused:true,expiredNotImmediate:mode==='expired',lostReplyNoDuplicate:mode==='lost-reply',roundTripCheckpoint:true,stubLLM:true})+'\n');
} finally {await cleanup();}
