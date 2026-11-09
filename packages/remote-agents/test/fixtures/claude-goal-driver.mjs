import { CliSession } from '../../src/agents/runtime.ts';
import { TaskHistory } from '../../src/agents/history.ts';
import { Sharing } from '../../src/sharing/sharing.ts';
// Full native AgentLoop + GoalRoundDriver -> RemoteCliAdapter -> fake Claude transport.
// Only the model/remote machine is fake. Goal scheduling and permissions are installed public services.
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { ClaudeGoalBridge } from '../../src/chat/claude-goal.ts';
import { RemoteCliAdapter, chatModelId, chatProviderId } from '../../src/chat/native-chat.ts';
import { ChatProjects } from '../../src/chat/projects.ts';
import { FakeRemote } from '../fakes.ts';
import { Store } from '../../src/core/store.ts';
import { RemoteAgentsService } from '../../src/agents/service.ts';
const runtime=resolve(process.argv[2]),mode=process.argv[3]??'complete';
const load=name=>import(pathToFileURL(join(runtime,'@deepseek-ai',name,'lib/index.js')).href);
const [{Context},sessions,llm]=await Promise.all(['cordis','dsh-session','dsh-llm'].map(load));
const root=await mkdtemp('/tmp/claude-goal-driver-'),ctx=new Context(),forks=[];
const mount=async(name,config={})=>{const mod=await load(name),fork=ctx.plugin(mod.default??mod,config);forks.push(fork);await fork.await();};
const store=new Store(join(root,'state.json'));await store.open();
const remote=new FakeRemote();remote.store=store;
const service=new RemoteAgentsService(store,remote.backend),projects=new ChatProjects(service);
let adapter,handle;const failures=[],calls=[];
try {
 for(const name of ['dsh-session','dsh-session-projection','dsh-agent','dsh-llm','dsh-system-prompt','dsh-tools','dsh-tool-executor-native','dsh-goal','dsh-tool-goal'])await mount(name);
 await mount('dsh-session-persistence-jsonl',{root:join(root,'sessions'),compression:'zstd'});
 await mount('dsh-agent-loop');await mount('dsh-goal-round-driver');
 ctx.on('agent/error',e=>failures.push(String(e.error)),{global:true});
 ctx.systemPrompt.section({name:'never-forward-this',order:1,text:'LOCAL_SYSTEM_SECRET_SENTINEL'});
 remote.catalog[1]={id:'claude',label:'Claude',status:'ready',models:[{id:'model',label:'Claude'}],modes:[]};
 const hostId=(await service.addHost({label:'fake-remote',connection:'ssh://fake'})).hosts[0].id;await service.discoverHost(hostId);
 const bridge=new ClaudeGoalBridge(name=>ctx.get(name),undefined,id=>mode==='ordinary'?id==='different-opted-in-session':id==='driver-goal');
 const sharing=new Sharing(store);sharing.goals=bridge;
 adapter=new RemoteCliAdapter(projects,{claudeGoals:bridge,agent:id=>ctx.agents.get(id),step:()=>undefined,cwd:()=>root,workspace:async()=>({hostIds:[hostId],cwd:root})},1);
 ctx.llm.registerAdapter([chatProviderId('claude')],adapter);
 ctx.on('agent/status',({status})=>{if(mode==='idle-reload'&&status==='idle'&&calls.length===1)adapter.close();},{global:true});
 if(mode==='ordinary') {
  assert.ok(ctx.tools.schemas().some(tool=>tool.name==='create_goal'),'real goal tools are installed');
  assert.equal(bridge.available('driver-goal'),false,'ordinary session has not opted in');
  const background={alive:true}, seen=[];let original;
  const reply=(a,text)=>{original??=a;assert.equal(a,original);assert.equal(background.alive,true);seen.push(a.nativeSessionId);calls.push(text);const id=remote.entries.get(a.id).filter(e=>e.item.type==='user_message').at(-1).item.clientMessageId;remote.append(a.id,{type:'assistant_message',text:'Ordinary response; background marker kept.'});remote.append(a.id,{type:'turn_end',clientMessageId:id,status:'completed'});};
  remote.onCreate=(a,task)=>reply(a,task.prompt);remote.onSend=reply;
  handle=await ctx.agents.create({sessionId:sessions.SessionId('driver-goal'),meta:{cwd:root},agentOptions:{provider:chatProviderId('claude'),model:chatModelId(hostId,'claude','model')}});
  const agent=handle.agent;
  for(const [i,text] of ['Keep the background task running and say ready.','Tell me whether the background task is still present.'].entries()) {
    agent.followup(llm.createUserMessage({source:{kind:'user'},content:[{type:'text',text}]}));
    for(let n=0;n<500&&(calls.length<i+1||agent.status!=='idle');n++){if(failures.length)throw Error(failures.join('\n'));await delay(10);}
  }
  assert.equal(remote.creates,1);assert.equal(remote.sends,1);assert.equal(remote.detaches,0);assert.equal(remote.stops,0);
  assert.equal(calls.length,2);assert.equal(seen[0],seen[1]);assert.equal(background.alive,true);assert.equal(ctx.goals.get(agent),undefined);
  assert.equal(bridge.launchIdentity(store.snapshot().tasks[0].id,agent.id),undefined);
  console.log(JSON.stringify({mode,realAgentLoop:true,realGoalRoundDriver:true,goalToolsInstalled:true,humanTurns:2,processCreates:remote.creates,processDetaches:remote.detaches,backgroundPreserved:true,noGoal:true,noGrant:true}));
 } else {
 const work=(a,text)=>{
  a.status='running';
  const task=store.task(t=>t.id===remote.created.id),message=remote.entries.get(a.id).filter(e=>e.item.type==='user_message').at(-1).item;
  calls.push(text);let expectedSessionFailure=false;
  void (async()=>{
   // Service.create publishes the receipt after backend.create returns.
   for(let i=0;i<100&&!store.task(t=>t.id===task.id)?.agentId;i++)await delay(1);
   await store.update(state=>{state.tasks.find(t=>t.id===task.id).native??={protocol:'claude',sessionId:a.nativeSessionId,argv:[],resumable:true,initialSent:true};});
   const call=async(name,args={})=>{const origin={...bridge.launchIdentity(task.id,task.chat.sessionId),callId:randomUUID()};remote.append(a.id,{type:'claude_goal_origin',...origin,sourceProofVersion:1,uuid:'fake-input-'+message.clientMessageId,responseId:'fake-response-'+origin.callId,nativeSessionId:a.nativeSessionId,name,arguments:args});const r=await bridge.call(task.id,task.chat.sessionId,name,args,new AbortController().signal,origin);assert.equal(r.isError,undefined,JSON.stringify(r));return JSON.parse(r.content[0].text);};
   if(calls.length===1)await call('create_goal',{objective:'Isolated driver protocol test; no business actions',max_goal_rounds:mode==='cap'?1:3});
   else {
    const {goal}=await call('get_goal');assert.equal(goal.roundsStarted,mode==='steer'?1:calls.length-1);
    if(calls.length===2&&mode==='steer')handle.agent.steer(llm.createUserMessage({source:{kind:'user'},content:[{type:'text',text:'NEW HUMAN INPUT: pause this goal now.'}]}));
    if(calls.length===2&&mode==='external-pause')ctx.agents.withoutInitiator(()=>ctx.goals.pause(handle.agent,{id:goal.id,revision:goal.revision}));
    if(calls.length===2&&mode==='reload')adapter.close();
    if(calls.length===2&&mode==='stop')handle.agent.cancel({kind:'user'},{keepInbox:true});
    if(calls.length===2&&mode==='no-uuid-error') {
      const history=new TaskHistory(join(root,'wire-parser'),task.id);await history.open();let receive;
      const peer={alive:true,onMessage:fn=>receive=fn,onExit(){},control:async()=>({}),send(){},close(){this.alive=false;}};
      const native=new CliSession(peer,store.task(t=>t.id===task.id),history,store,{goalFailed:(id,reason)=>sharing.goalFailed(task,id,reason)});
      await native.initialize('claude',['claude','--session-id',a.nativeSessionId],true,[],bridge.launchIdentity(task.id,task.chat.sessionId));
      await native.send('Isolated failure probe',message.clientMessageId);
      receive({type:'result',subtype:'error_during_execution',is_error:true,session_id:a.nativeSessionId,errors:['unattributed session failure']},{end:1});
      await history.flush();assert.equal(native.agent.status,'error');assert.equal(bridge.launchIdentity(task.id,task.chat.sessionId),undefined);
      assert.equal(ctx.goals.get(handle.agent).activation,'disarmed');
      for(const e of (await history.messagePage(message.clientMessageId)).entries)if(e.item.type==='error'||e.item.type==='turn_end')remote.append(a.id,e.item);
      expectedSessionFailure=true;native.close();
    }

    if(calls.length===3)await call('update_goal',{goal_id:goal.id,revision:goal.revision,action:mode==='steer'?'pause':'complete'});
   }
  })().catch(e=>failures.push(String(e))).finally(()=>{if(expectedSessionFailure){a.status='error';a.activeTurn=null;return;}remote.append(a.id,{type:'assistant_message',text:'Isolated round checked.'});remote.append(a.id,{type:'turn_end',clientMessageId:message.clientMessageId,status:'completed'});a.status='idle';a.activeTurn=null;});
 };
 remote.onCreate=(a,task)=>work(a,task.prompt);remote.onSend=work;
 handle=await ctx.agents.create({sessionId:sessions.SessionId('driver-goal'),meta:{cwd:root},agentOptions:{provider:chatProviderId('claude'),model:chatModelId(hostId,'claude','model')}});
 const agent=handle.agent;
 agent.followup(llm.createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Create a small goal and verify this isolated bridge over two automatic rounds.'}]}));
 for(let i=0;i<500;i++){if(failures.length&&mode!=='no-uuid-error')throw Error(failures.join('\n'));if(ctx.goals.get(agent)?.phase===(mode==='complete'?'complete':mode==='cap'?'blocked':['reload','idle-reload','no-uuid-error'].includes(mode)?'active':'paused')&&agent.status==='idle'&&(!['reload','idle-reload','no-uuid-error'].includes(mode)||ctx.goals.get(agent)?.activation==='disarmed'))break;await delay(10);}
 if(['reload','idle-reload','no-uuid-error'].includes(mode))assert.equal(ctx.goals.get(agent).activation,'disarmed');
 if(mode==='no-uuid-error'){assert.equal(failures.length,1);assert.match(failures[0],/without a message UUID/);}else assert.deepEqual(failures,[]);assert.equal(ctx.goals.get(agent)?.phase,mode==='complete'?'complete':mode==='cap'?'blocked':['reload','idle-reload','no-uuid-error'].includes(mode)?'active':'paused');
 assert.equal(remote.creates,1);assert.equal(remote.detaches,calls.length-1,'every new delivery resumes the same session with a new process');assert.equal(remote.sends,mode==='idle-reload'?0:['cap','stop','external-pause','reload','no-uuid-error'].includes(mode)?1:2);assert.equal(calls.length,mode==='idle-reload'?1:['cap','stop','external-pause','reload','no-uuid-error'].includes(mode)?2:3);
 assert.ok(calls.slice(1,mode==='steer'?2:undefined).every(p=>p.includes('not a new human request')&&p.includes('"kind":"goal"')));
 assert.ok(calls.every(p=>!p.includes('LOCAL_SYSTEM_SECRET_SENTINEL')));
 const sources=agent.session.snapshotEvents().filter(e=>e.type==='user/message'&&e.data.source.kind==='goal');
 assert.deepEqual(sources.map(e=>e.data.source.round),mode==='complete'?[1,2]:mode==='idle-reload'?[]:[1]);
 if(mode==='steer'){assert.ok(calls[2].includes('NEW HUMAN INPUT: pause this goal now.'));assert.ok(!calls[2].includes('not a new human request'));}
 if(mode==='cap')assert.equal(ctx.goals.get(agent).blockedReason.code,'round-limit');
 await delay(30);assert.equal(calls.length,mode==='idle-reload'?1:['cap','stop','external-pause','reload','no-uuid-error'].includes(mode)?2:3,'terminal state remains quiescent');
 console.log(JSON.stringify({mode,realAgentLoop:true,realGoalRoundDriver:true,oneClaudeSession:true,automaticRounds:sources.length,terminalStops:true,sessionErrorFailed:mode==='no-uuid-error'?true:undefined,newHumanPreserved:mode==='steer'?true:undefined,sourcePreserved:true,noSystemLeak:true}));
}
}finally{adapter?.close();await handle?.dispose();await service.close();await store.close();for(const f of forks.reverse())await f.dispose();await rm(root,{recursive:true,force:true});}
