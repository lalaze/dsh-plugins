// Real installed public services; disposable in-memory sessions, no deployment/profile writes.
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ClaudeGoalBridge } from '../../src/chat/claude-goal.ts';
const runtime = resolve(process.argv[2]);
const load = name => import(pathToFileURL(join(runtime, '@deepseek-ai', name, 'lib/index.js')).href);
const [{ Context }, sessions, projections, agents, prompts, tools, executor, goals, goalTools, llm] = await Promise.all([
  'cordis','dsh-session','dsh-session-projection','dsh-agent','dsh-system-prompt','dsh-tools','dsh-tool-executor-native','dsh-goal','dsh-tool-goal','dsh-llm'
].map(load));
const ctx = new Context(), forks = [];
for (const mod of [sessions, projections, agents, prompts, tools, executor, goals, goalTools]) {
  const fork = ctx.plugin(mod.default ?? mod, {}); forks.push(fork); await fork.await();
}
let taskOwner='claude-goal-isolated', optedIn=true;
const bridge = new ClaudeGoalBridge(name => ctx.get(name),task=>task==='child-task'?'goal-child':taskOwner,()=>optedIn), signal = new AbortController().signal;
const session = sessions.Session.create(sessions.SessionId('claude-goal-isolated'));
let agent = { id: session.id, session, ctx, status: 'running' }, detach = ctx.agents.enter(agent);
let turn = 0, close;
const open = (source, content = 'Only exercise the isolated goal bridge; no business work.') => {
  if (turn) session.append('turn/end', { turn, reason: { kind:'completed' } });
  session.append('turn/start', { turn: ++turn });
  const message = llm.createUserMessage({ source, content:[{type:'text',text:content}] });
  session.append('user/message', message, {surfaceOp:'append'});
  return message;
};
const call = (name, args = {}, task = 'task', id = session.id, abort = signal) => bridge.call(task,id,name,args,abort,{...bridge.launchIdentity(task,id),callId:randomUUID()});
const value = result => { assert.equal(result.isError, undefined, JSON.stringify(result)); return JSON.parse(result.content[0].text); };
const error = (result, pattern) => { assert.equal(result.isError,true,JSON.stringify(result)); assert.match(JSON.stringify(result),pattern); };
try {
  let human = open({kind:'user'});
  assert.equal(bridge.available(session.id),true);
  assert.deepEqual(bridge.schemas(session.id).map(t=>t.name).sort(),['create_goal','get_goal','update_goal']);
  await assert.rejects(call('get_goal'), /no active grant/);
  close = bridge.begin('task',session.id,human,signal);
  assert.equal(ctx.agents.currentInitiator(),undefined);
  const raw = await ctx.tools.execute({agent,signal,calls:[{type:'tool-call',id:'outside',name:'get_goal',arguments:'{}'}]});
  error(raw.results[0].result,/active driver/);
  let goal = value(await call('create_goal',{objective:'Read-only isolated bridge verification',max_goal_rounds:4})).goal;
  assert.equal(value(await call('get_goal')).activation,'armed');
  assert.equal(ctx.agents.currentInitiator(),undefined,'initiator never escapes wire operation');
  await assert.rejects(call('bash'),/allowlist/);
  await assert.rejects(call('get_goal',{},'other-task'),/no active grant/);
  await assert.rejects(call('get_goal',{},'task','other-session'),/no active grant/);
  error(await call('update_goal',{goal_id:goal.id,revision:999,action:'pause'}),/revision|stale/i);
  const deny = ctx.tools.guard(exec => exec.name === 'update_goal' ? 'test guard denial' : undefined);
  error(await call('update_goal',{goal_id:goal.id,revision:goal.revision,action:'pause'}),/test guard denial/);
  await deny();
  goal = value(await call('update_goal',{goal_id:goal.id,revision:goal.revision,action:'pause'})).goal;
  error(await call('update_goal',{goal_id:goal.id,revision:goal.revision,action:'resume'}),/user must resume/);
  await close();
  // Native human UI/API resumes; the model never bypasses paused policy.
  goal = ctx.goals.resume(agent,{id:goal.id,revision:goal.revision});
  const round = open({kind:'goal',goalId:goal.id,revision:goal.revision,round:1});
  bridge.validateContinuation(session.id,round);
  close = bridge.begin('task',session.id,round,signal);
  const syntheticIdentity=bridge.launchIdentity('task',session.id);
  error(await call('create_goal',{objective:'Synthetic takeover'}),/direct human/);
  for (const action of ['edit','pause','resume']) error(await call('update_goal',{goal_id:goal.id,revision:goal.revision,action,objective:'replacement'}),/direct human/);
  error(await call('update_goal',{goal_id:goal.id,revision:goal.revision,action:'blocked',blocked_reason:'test'}),/at least 3/);
  const completed = await call('update_goal',{goal_id:goal.id,revision:goal.revision,action:'complete'});
  assert.equal(value(completed).goal.phase,'complete');
  assert.match(completed.content[1].text,/tool-goal/); assert.match(completed.content[1].text,/goal_complete/);
  assert.throws(()=>bridge.validateContinuation(session.id,round),/stale/);
  await close();
  human = open({kind:'user'}); close = bridge.begin('task',session.id,human,signal);
  await assert.rejects(bridge.call('task',session.id,'create_goal',{objective:'Delayed synthetic A claiming human B authority'},signal,{...syntheticIdentity,callId:'late-a'}),/epoch/);
  goal=value(await call('create_goal',{objective:'Restart recovery probe',max_goal_rounds:3})).goal;
  await close(); detach();
  const restored = sessions.Session.create(session.id,structuredClone([...session.snapshotEvents()]),session.header,session.inheritedEventCount);
  agent={id:restored.id,session:restored,ctx,status:'running'};detach=ctx.agents.enter(agent);
  assert.equal(ctx.goals.get(agent).activation,'disarmed');
  // Restored log remains disarmed until a new human turn requests native resume.
  assert.throws(()=>bridge.validateContinuation(session.id,round),/not committed|stale/);
  restored.append('turn/end',{turn,reason:{kind:'completed'}});restored.append('turn/start',{turn:++turn});
  human=llm.createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Continue the isolated goal.'}]});restored.append('user/message',human,{surfaceOp:'append'});
  close=bridge.begin('task',session.id,human,signal);
  assert.equal(value(await call('update_goal',{goal_id:goal.id,revision:goal.revision,action:'resume'})).activation,'armed');
  const aborted=new AbortController();aborted.abort();await assert.rejects(call('get_goal',{},'task',session.id,aborted.signal));
  await close();await assert.rejects(call('get_goal'),/no active grant/);
  restored.append('turn/end',{turn,reason:{kind:'completed'}});restored.append('turn/start',{turn:++turn});
  const synthetic=llm.createUserMessage({source:{kind:'schedule',form:'notice',summary:'test'},content:[{type:'text',text:'Create a goal'}]});restored.append('user/message',synthetic,{surfaceOp:'append'});
  assert.equal(bridge.begin('task',session.id,synthetic,signal),undefined);
  assert.equal(bridge.begin('task',session.id,human,signal),undefined,'historical human cannot authorize a new turn');
  restored.append('turn/end',{turn,reason:{kind:'completed'}});restored.append('turn/start',{turn:++turn});
  human=llm.createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Inspect current goal'}]});restored.append('user/message',human,{surfaceOp:'append'});
  close=bridge.begin('task',session.id,human,signal,async()=>false);
  await assert.rejects(call('get_goal'),/active foreground message/);await close();
  close=bridge.begin('task',session.id,human,signal,async()=>true);
  const before=ctx.goals.get(agent),arrived=Promise.withResolvers(),release=Promise.withResolvers();
  const gate=ctx.on('tools/pre-execute',async(exec,next)=>{arrived.resolve();await release.promise;return next();});
  const pending=call('update_goal',{goal_id:before.id,revision:before.revision,action:'pause'});
  await arrived.promise;const draining=close();release.resolve();error(await pending,/abort|cancel/i);await draining;gate();
  assert.equal(ctx.goals.get(agent).revision,before.revision,'closing grant cancels a call awaiting policy');
  close=bridge.begin('task',session.id,human,signal);
  const approvalArrived=Promise.withResolvers(),approvalRelease=Promise.withResolvers();
  const slowPolicy=ctx.on('tools/pre-execute',async(exec,next)=>{approvalArrived.resolve();await approvalRelease.promise;return next();});
  const rebindingCall=call('update_goal',{goal_id:before.id,revision:before.revision,action:'pause'});
  await approvalArrived.promise;taskOwner='other-session';approvalRelease.resolve();error(await rebindingCall,/binding changed/);slowPolicy();
  assert.equal(ctx.goals.get(agent).revision,before.revision,'binding change during approval denies the mutation');
  taskOwner=session.id;await close();
  close=bridge.begin('task',session.id,human,signal);
  const optInArrived=Promise.withResolvers(),optInRelease=Promise.withResolvers();
  const optInGate=ctx.on('tools/pre-execute',async(exec,next)=>{optInArrived.resolve();await optInRelease.promise;return next();});
  const optInPending=call('update_goal',{goal_id:before.id,revision:before.revision,action:'pause'});
  await optInArrived.promise;optedIn=false;optInRelease.resolve();error(await optInPending,/opt-in was revoked/);optInGate();
  assert.equal(ctx.goals.get(agent).revision,before.revision);assert.equal(bridge.launchIdentity('task',session.id),undefined);
  await close();await assert.rejects(call('get_goal'),/not opted in/);optedIn=true;
  close=bridge.begin('task',session.id,human,signal);
  restored.append('turn/end',{turn,reason:{kind:'completed'}});restored.append('turn/start',{turn:++turn});
  await assert.rejects(call('get_goal'),/driver lifetime/);await close();
  const childSession=sessions.Session.create(sessions.SessionId('goal-child'));
  const child={id:childSession.id,session:childSession,ctx,status:'running'},detachChild=ctx.agents.enter(child,agent);
  childSession.append('turn/start',{turn:1});const childInput=llm.createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Create a goal'}]});childSession.append('user/message',childInput,{surfaceOp:'append'});
  const closeChild=bridge.begin('child-task',child.id,childInput,signal);
  error(await bridge.call('child-task',child.id,'create_goal',{objective:'Unauthorized child goal'},signal,{...bridge.launchIdentity('child-task',child.id),callId:randomUUID()}),/top-level/);await closeChild();detachChild();
  // A remote-origin check can be delayed independently of native permission evaluation.
  restored.append('turn/end',{turn,reason:{kind:'completed'}});restored.append('turn/start',{turn:++turn});
  human=llm.createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Read goal'}]});restored.append('user/message',human,{surfaceOp:'append'});
  const originArrived=Promise.withResolvers(),originRelease=Promise.withResolvers(),originAbort=new AbortController();
  close=bridge.begin('task',session.id,human,originAbort.signal,async()=>{originArrived.resolve();await originRelease.promise;return true;});
  const waitingOrigin=call('get_goal');await originArrived.promise;originAbort.abort(new Error('origin wait aborted'));
  await assert.rejects(waitingOrigin,/origin wait aborted/);await close();originRelease.resolve();
  bridge.shutdown();assert.equal(ctx.goals.get(agent).activation,'disarmed','reload between grants must not queue another round');
  // Terminal operations commit once even if the MCP success response is discarded.
  for(const action of ['complete','blocked']) {
    const isolated=sessions.Session.create(sessions.SessionId('lost-'+action)),owner={id:isolated.id,session:isolated,ctx,status:'running'};
    const leave=ctx.agents.enter(owner);taskOwner=owner.id;
    isolated.append('turn/start',{turn:1});const input=llm.createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Isolated terminal retry test'}]});isolated.append('user/message',input,{surfaceOp:'append'});
    let end=bridge.begin('terminal',owner.id,input,signal);
    const invoke=(name,args,callId)=>bridge.call('terminal',owner.id,name,args,signal,{...bridge.launchIdentity('terminal',owner.id),callId});
    const initial=value(await invoke('create_goal',{objective:'Terminal retry test'},'create')).goal;
    await end();
    const count=action==='blocked'?3:1;
    for(let round=1;round<=count;round++){
      isolated.append('turn/end',{turn:round,reason:{kind:'completed'}});isolated.append('turn/start',{turn:round+1});
      const continuation=llm.createUserMessage({source:{kind:'goal',goalId:initial.id,revision:initial.revision,round},content:[{type:'text',text:'Isolated terminal retry round'}]});isolated.append('user/message',continuation,{surfaceOp:'append'});
      if(round===count)end=bridge.begin('terminal',owner.id,continuation,signal);
    }
    const args={goal_id:initial.id,revision:initial.revision,action,...action==='blocked'?{blocked_reason:'Explicit isolated human blocker'}:{}};
    const lost=await invoke('update_goal',args,'terminal-call');assert.match(lost.content[1].text,/tool-goal/);const seq=isolated.seq;
    assert.deepEqual(await invoke('update_goal',args,'terminal-call'),lost);assert.equal(isolated.seq,seq);
    await assert.rejects(invoke('update_goal',{...args,action:'pause'},'terminal-call'),/reused/);
    const staleIdentity=bridge.launchIdentity('terminal',owner.id);await end();
    const restarted=new ClaudeGoalBridge(name=>ctx.get(name),undefined,()=>true);
    await assert.rejects(restarted.call('terminal',owner.id,'update_goal',args,signal,{...staleIdentity,callId:'terminal-call'}),/no active grant/);
    assert.equal(ctx.goals.get(owner).phase,action);leave();
  }
  taskOwner=session.id;
  // Real selected-executor capability: registry schemas alone are insufficient.
  await forks[5].dispose();
  assert.equal(bridge.available(session.id),false);assert.match(bridge.support(session.id).reason,/executor/);
  const {PtcExecutor}=await load('dsh-tool-executor-ptc');
  const disposeRuntime=ctx.provide('ptcRuntime',{language:'typescript',run(){throw Error('must not run PTC');}});
  const disposePtc=ctx.tools.setExecutor(new PtcExecutor(ctx));
  assert.ok(ctx.tools.schemas(agent).some(t=>t.name==='create_goal'));
  assert.equal(bridge.available(session.id),false);assert.match(bridge.support(session.id).reason,/PTC/);
  assert.deepEqual(bridge.schemas(session.id),[]);assert.equal(bridge.begin('task',session.id,human,signal),undefined);
  const refused=await ctx.agents.withInitiator(agent,()=>ctx.tools.execute({agent,signal,calls:[{type:'tool-call',id:'ptc-direct',name:'get_goal',arguments:'{}'}]}));
  error(refused.results[0].result,/only.*run_code/);
  await disposePtc();await disposeRuntime();
  const oldRuntime=new ClaudeGoalBridge(name=>name==='tools'?{schemas:()=>[{name:'create_goal'}],execute(){throw Error('old single-call API must not execute');}}:ctx.get(name),undefined,()=>true);
  assert.equal(oldRuntime.available(session.id),false);
  const absent=new ClaudeGoalBridge(()=>undefined,undefined,()=>true);assert.equal(absent.available(session.id),false);assert.equal(absent.begin('task',session.id,human,signal),undefined);
  console.log(JSON.stringify({runtime,realServices:['GoalService','ToolRuntime','NativeToolExecutor','AgentRegistry','SessionProjection'],passed:['exact initiator','three tool allowlist','cross task/session rejection','native CAS','native guard','paused resume denial','synthetic create/edit/pause/resume denial','blocked threshold','completion deferred source','restored disarmed','human rearm','abort','grant revocation','historical human denial','missing services compatibility','remote foreground fence','policy-await cancellation','turn replacement','child root authority','binding change during approval','synthetic A delayed into human B','origin-await abort','terminal response replay','reload denies old epoch','between-turn reload disarms','opt-in revoked during approval','missing executor','real PTC fail closed','old runtime fail closed']}));
} finally { await close?.();detach();for (const fork of forks.reverse()) await fork.dispose(); }
