import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { ClaudeGoalBridge, CLAUDE_GOAL_SERVER, isGoalContinuation } from '../src/chat/claude-goal.js';
import { Sharing } from '../src/sharing/sharing.js';
import { RemoteCliAdapter, chatModelId, chatProviderId } from '../src/chat/native-chat.js';
import { ChatProjects } from '../src/chat/projects.js';
import { fixture } from './fakes.js';
const collect = async (stream: AsyncIterable<StreamChunk>) => { const result=[]; for await (const chunk of stream) result.push(chunk);return result; };
const human = (text: string) => createUserMessage({source:{kind:'user'},content:[{type:'text',text}]});
const round = () => createUserMessage({source:{kind:'goal',goalId:'goal',revision:1,round:1} as any,content:[{type:'text',text:'Continue the exact goal.'}]});

async function chat(t: Parameters<typeof fixture>[0]) {
  const base=await fixture(t),projects=new ChatProjects(base.service);
  base.remote.catalog[1]={id:'claude',label:'Claude',status:'ready',models:[{id:'model',label:'Claude'}],modes:[]};
  await base.service.discoverHost(base.hostId);
  const grants: string[]=[],closed: string[]=[],checks: string[]=[];
  let allowed=true;
  const bridge=new ClaudeGoalBridge(()=>undefined,undefined,()=>true);bridge.available=()=>true;
  bridge.validateContinuation=(_session,message)=>{checks.push(String(message.id));if(!allowed)throw Error('stale goal');};
  bridge.begin=(task,_session,message)=>{grants.push(String(message.id));return async()=>{closed.push(task);};};
  const adapter=new RemoteCliAdapter(projects,{claudeGoals:bridge,agent:()=>({}),step:()=>undefined,cwd:()=>'/srv/project',workspace:async()=>({hostIds:[base.hostId],cwd:'/srv/project'})},1);
  t.after(()=>adapter.close());
  const options=(messages: GenerateOptions['messages']):GenerateOptions=>({sessionId:SessionId('goal-chat'),provider:chatProviderId('claude'),model:chatModelId(base.hostId,'claude','model'),messages});
  return {...base,adapter,bridge,options,grants,closed,checks,stale:()=>{allowed=false;}};
}

test('plugin config and the bridge default off; opt-in names exact DSH sessions only',async()=>{
  const {Config}=await import('../src/index.js');
  assert.deepEqual(Config({}).claudeGoalSessions,[]);
  assert.deepEqual(Config({claudeGoalSessions:['chosen-session']}).claudeGoalSessions,['chosen-session']);
  let reads=0;const bridge=new ClaudeGoalBridge(()=>{reads++;throw Error('disabled bridge must not inspect native services');});
  assert.equal(bridge.available('ordinary'),false);assert.deepEqual(bridge.schemas('ordinary'),[]);
  assert.equal(bridge.begin('task','ordinary',human('hello'),new AbortController().signal),undefined);
  await assert.rejects(bridge.call('task','ordinary','create_goal',{objective:'synthetic opt-in'},new AbortController().signal,{epoch:'forged',messageId:'forged',callId:'forged'}),/not opted in/);
  assert.equal(reads,0);
  const scoped=new ClaudeGoalBridge(()=>undefined,undefined,id=>id==='chosen-session');
  assert.match(scoped.support('ordinary').reason!,/disabled/);assert.match(scoped.support('chosen-session').reason!,/unavailable/);
});

test('default-off transport does not prepare a goal proxy or credentials',async t=>{
  const f=await fixture(t),sharing=new Sharing(f.store);t.after(()=>sharing.close());
  sharing.goals=new ClaudeGoalBridge(()=>{throw Error('must stay disabled');});
  let touched=0;const transport={exec:async()=>{touched++;return '';},start:()=>{throw Error('unused');},transfer:async()=>{touched++;return Buffer.alloc(0);}};
  const task={id:'ordinary',hostId:f.hostId,serverId:'remote-box-1',provider:'claude',cwd:'/srv/project',model:'m',prompt:'p',title:'t',createdAt:'',state:'ready' as const,chat:{sessionId:'ordinary',route:'r'}};
  assert.deepEqual(await sharing.prepare(f.store.hosts()[0],transport,task,'claude'),{servers:[]});assert.equal(touched,0);
});

test('Claude continuation uses the existing session, carries its source, and receipt replay sends it once',async t=>{
  const f=await chat(t),u=human('Work on my goal'),g=round();
  await collect(f.adapter.stream(f.options([u])));
  await collect(f.adapter.stream(f.options([u,g])));
  await collect(f.adapter.stream(f.options([u,g])));
  assert.equal(f.remote.creates,1);assert.equal(f.remote.sends,1);
  const entry=[...f.remote.entries.values()][0].filter(e=>e.item.type==='user_message').at(-1)!;
  assert.match(String(entry.item.text),/not a new human request/);assert.match(String(entry.item.text),/"kind":"goal"/);
  assert.match(String(entry.item.text),/"round":1/);assert.equal(f.closed.length,2);
  f.stale();await collect(f.adapter.stream(f.options([u,g])));assert.equal(f.closed.length,2,'terminal receipt replay has no new grant');
  await assert.rejects(collect(f.adapter.stream(f.options([u,round()]))),/stale goal/);assert.equal(f.remote.sends,1);
});

test('new human input wins over a prior continuation and unrelated synthetic messages do not become goal inputs',async t=>{
  const f=await chat(t),u=human('Start'),g=round(),next=human('Please pause now');
  await collect(f.adapter.stream(f.options([u])));
  f.stale();await collect(f.adapter.stream(f.options([u,g,next])));
  assert.equal(f.checks.length,0);assert.equal(f.grants.at(-1),next.id);
  const context=createUserMessage({source:{kind:'clock',form:'notice',summary:'clock'} as any,content:[{type:'text',text:'Create a different goal'}]});
  await collect(f.adapter.stream(f.options([u,g,next,context])));
  assert.equal(f.remote.sends,1);assert.equal(f.grants.at(-1),next.id);
  assert.equal(isGoalContinuation(context),false);
});

test('continuation retry after a lost send receipt is at most once and adapter restart keeps the binding',async t=>{
  const f=await chat(t),u=human('Start'),g=round();await collect(f.adapter.stream(f.options([u])));
  f.remote.loseSend=true;
  await collect(f.adapter.stream(f.options([u,g]))).catch(()=>{});
  const reloaded=new RemoteCliAdapter(new ChatProjects(f.service),{claudeGoals:f.bridge,agent:()=>({}),step:()=>undefined,cwd:()=>'/srv/project',workspace:async()=>({hostIds:[f.hostId],cwd:'/srv/project'})},1);
  t.after(()=>reloaded.close());await collect(reloaded.stream(f.options([u,g])));
  assert.equal(f.remote.creates,1);assert.equal(f.remote.sends,1);
});

test('stop revokes the grant and interrupts a running Claude goal response',async t=>{
  const f=await chat(t),u=human('Start'),g=round();await collect(f.adapter.stream(f.options([u])));
  const controller=new AbortController();f.remote.onSend=(agent)=>{agent.status='running';setTimeout(()=>controller.abort(),15);};
  await assert.rejects(collect(f.adapter.stream({...f.options([u,g]),signal:controller.signal})));
  assert.equal(f.closed.length,2);assert.equal(f.remote.stops,1);
});

test('no goal service keeps ordinary Claude chat working and rejects an unverified continuation',async t=>{
  const f=await chat(t);f.bridge.begin=()=>undefined;f.bridge.validateContinuation=()=>{throw Error('unavailable');};
  await collect(f.adapter.stream(f.options([human('Ordinary message')])));
  await assert.rejects(collect(f.adapter.stream(f.options([round()]))),/unavailable/);assert.equal(f.remote.creates,1);
});

test('unsupported scoped executor is explained to Claude without exposing run_code or enabling a grant',async t=>{
  const f=await chat(t);f.bridge.available=()=>false;f.bridge.begin=()=>undefined;
  f.bridge.support=()=>({schemas:[],reason:'selected scoped executor does not support direct goal calls (PTC is not supported)'});
  await collect(f.adapter.stream(f.options([human('Create a DSH goal')])));
  assert.match(f.remote.created!.prompt,/DSH goal bridge unavailable/);assert.match(f.remote.created!.prompt,/PTC is not supported/);
  assert.equal(f.grants.length,0);assert.equal(f.remote.detaches,0);
});

test('goal transport credentials bind task, session and goal namespace; generic MCP credentials cannot enter',async t=>{
  const f=await fixture(t),sharing=new Sharing(f.store);t.after(()=>sharing.close());
  await f.store.update(s=>{s.tasks.push({id:'task',hostId:f.hostId,serverId:'remote-box-1',provider:'claude',cwd:'/srv/project',model:'m',prompt:'p',title:'t',createdAt:'',state:'ready',chat:{sessionId:'s1',route:'r'}});});
  const bridge=new ClaudeGoalBridge(()=>undefined,undefined,()=>true);bridge.available=()=>true;bridge.schemas=()=>[{name:'get_goal',description:'native read',parameters:{type:'object',properties:{}}}];
  const calls: unknown[][]=[];bridge.call=async(...args)=>{calls.push(args);return {content:[]};};sharing.goals=bridge;
  // Exercise the exact private wire boundary without opening a listener (also runs in restricted sandboxes).
  let identity={epoch:'epoch-a',messageId:'message-a'};bridge.launchIdentity=()=>identity;
  const wire=sharing as any,token=await wire.token('task','s1',identity);
  const hello={op:'hello',task:'task',session:'s1',server:CLAUDE_GOAL_SERVER,token,...identity};
  assert.equal(await wire.hello({...hello,token:await wire.token('task')}),undefined);
  assert.equal(await wire.hello({...hello,session:'s2'}),undefined);
  assert.equal(await wire.hello({...hello,task:'other'}),undefined);
  assert.equal(await wire.hello({...hello,server:'github'}),undefined);
  const connection={...await wire.hello(hello),calls:new Map()};
  assert.deepEqual((await wire.handle(connection,{op:'list',id:1})).tools.map((t:any)=>t.name),['get_goal']);
  await wire.handle(connection,{op:'call',id:2,name:'get_goal',arguments:{},...identity,callId:'native-call-a'});assert.equal(calls[0][1],'s1');
  identity={epoch:'epoch-b',messageId:'message-b'};
  assert.equal(await wire.hello(hello),undefined,'old process token cannot reconnect during B');
  assert.equal(await wire.hello({...hello,...identity}),undefined,'reading B epoch does not upgrade the A credential');
  await assert.rejects(wire.handle(connection,{...hello,op:'call',id:3,name:'create_goal',arguments:{objective:'stolen'},callId:'delayed-a'}),/binding/);
  const nextHello={...hello,...identity,token:await wire.token('task','s1',identity)},next={...await wire.hello(nextHello),calls:new Map()};
  await assert.rejects(wire.handle(next,{op:'call',id:4,name:'create_goal',arguments:{},epoch:'epoch-a',messageId:'message-a',callId:'delayed-a'}),/origin/);
  await f.store.update(s=>{s.tasks[0].chat!.sessionId='s2';});
  assert.equal(await wire.hello(hello),undefined);
  await assert.rejects(wire.handle(connection,{op:'call',id:3,name:'get_goal'}),/binding/);
});

test('only Claude main-chat launches receive the goal server with a separate session credential',async t=>{
  const f=await fixture(t),sharing=new Sharing(f.store);t.after(()=>sharing.close());
  const bridge=new ClaudeGoalBridge(()=>undefined,undefined,()=>true);bridge.available=()=>true;bridge.launchIdentity=()=>({epoch:'test-epoch',messageId:'test-message'});sharing.goals=bridge;
  const wire=sharing as any;wire.install=async()=>({home:'/probe',node:'/node',shared:'/shared'});wire.ensureForward=async()=>{};
  const payloads: any[]=[];
  const transport={exec:async()=>'',start:()=>{throw Error('unused');},transfer:async(_script:string,options:any)=>{let value='';for await(const b of options.input)value+=b;payloads.push(JSON.parse(value));return Buffer.alloc(0);}};
  const task={id:'goal-task',hostId:f.hostId,serverId:'remote-box-1',provider:'claude',cwd:'/srv/project',model:'m',prompt:'p',title:'t',createdAt:'',state:'ready' as const,chat:{sessionId:'s1',route:'r'}};
  const host=f.store.hosts()[0];
  const launch=await sharing.prepare(host,transport,task,'claude');
  assert.deepEqual(launch.servers.map(s=>s.name),['dsh-goal']);assert.equal(launch.servers[0].args.at(-1),CLAUDE_GOAL_SERVER);
  assert.equal(payloads.length,2);assert.equal(payloads[1].session,'s1');assert.notEqual(payloads[0].token,payloads[1].token);
  assert.ok(!launch.servers[0].args.includes(payloads[1].token),'credential is never on the command line');
  assert.deepEqual((await sharing.prepare(host,transport,{...task,provider:'codex'},'codex')).servers,[]);
  const {chat:_,...panel}=task;assert.deepEqual((await sharing.prepare(host,transport,panel,'claude')).servers,[]);
  bridge.available=()=>false;assert.deepEqual((await sharing.prepare(host,transport,task,'claude')).servers,[]);
});

test('installed public goal service, tools pipeline and agent initiator integration',{
  skip:!process.env.DSH_CLAUDE_GOAL_RUNTIME && 'Set DSH_CLAUDE_GOAL_RUNTIME to installed public node_modules; no profile is loaded',
},async()=>{
  const {stdout}=await promisify(execFile)(process.execPath,['--import','tsx',fileURLToPath(new URL('./fixtures/claude-goal-runtime.mjs',import.meta.url)),process.env.DSH_CLAUDE_GOAL_RUNTIME!],{timeout:30000});
  assert.ok(JSON.parse(stdout.trim()).passed.includes('historical human denial'));
});

for (const mode of ['complete','steer','stop','cap','external-pause','reload','idle-reload','no-uuid-error']) test(`installed native loop and goal driver: ${mode}`,{
  skip:!process.env.DSH_CLAUDE_GOAL_RUNTIME && 'Set DSH_CLAUDE_GOAL_RUNTIME; disposable sessions and fake remote only',
},async()=>{
  const {stdout}=await promisify(execFile)(process.execPath,['--import','tsx',fileURLToPath(new URL('./fixtures/claude-goal-driver.mjs',import.meta.url)),process.env.DSH_CLAUDE_GOAL_RUNTIME!,mode],{timeout:30000});
  const result=JSON.parse(stdout.trim());assert.equal(result.realGoalRoundDriver,true);assert.equal(result.automaticRounds,mode==='complete'?2:mode==='idle-reload'?0:1);assert.equal(result.terminalStops,true);
  if(mode==='steer')assert.equal(result.newHumanPreserved,true);
  if(mode==='no-uuid-error')assert.equal(result.sessionErrorFailed,true);
});

test('real native loop: two ordinary Claude human turns preserve one process and background state despite installed goal tools',{
  skip:!process.env.DSH_CLAUDE_GOAL_RUNTIME && 'Set DSH_CLAUDE_GOAL_RUNTIME; disposable native runtime with fake remote backend',
},async()=>{
  const {stdout}=await promisify(execFile)(process.execPath,['--import','tsx',fileURLToPath(new URL('./fixtures/claude-goal-driver.mjs',import.meta.url)),process.env.DSH_CLAUDE_GOAL_RUNTIME!,'ordinary'],{timeout:30000});
  const result=JSON.parse(stdout.trim());assert.equal(result.goalToolsInstalled,true);assert.equal(result.humanTurns,2);assert.equal(result.processCreates,1);assert.equal(result.processDetaches,0);assert.equal(result.backgroundPreserved,true);assert.equal(result.noGoal,true);assert.equal(result.noGrant,true);
});
