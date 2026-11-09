import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CliSession } from '../src/agents/runtime.js';
import { TaskHistory } from '../src/agents/history.js';
import type { GoalIdentity } from '../src/chat/claude-goal.js';
import { fixture } from './fakes.js';

const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
async function parser(t:TestContext, optedIn=true) {
  const f=await fixture(t),task={...f.request({id:'origin-audit',provider:'claude'}),serverId:'remote-box-1',title:'probe',createdAt:'',state:'ready' as const};
  await f.store.update(s=>s.tasks.push(task));
  let history=new TaskHistory(f.directory,task.id);await history.open();
  let receive:(frame:any,position:any)=>void=()=>{},session:CliSession;const sent:any[]=[];
  const instances:CliSession[]=[], revocations:{messageId:string;reason:string}[]=[];let closes=0;
  const peer=()=>({alive:true,onMessage:(fn:any)=>receive=fn,onExit(){},control:async()=>({}),send:(m:any)=>sent.push(m),close(){closes++;this.alive=false;}} as any);
  t.after(()=>{for(const s of instances)s.close();});
  const boot=async(identity:GoalIdentity,resume=false)=>{
    session=new CliSession(peer(),f.store.task(t=>t.id===task.id)!,history,f.store,{goalFailed:(messageId,reason)=>revocations.push({messageId,reason})});instances.push(session);
    await session.initialize('claude',['claude','--session-id','native-session'],resume,[],optedIn?identity:undefined);
    await session.send(identity.messageId,identity.messageId);
    return sent.filter(m=>m.type==='user').at(-1).uuid as string;
  };
  const emit=(frame:any)=>receive({session_id:'native-session',parent_tool_use_id:null,...frame},{end:1});
  const assistant=(responseId:string,callId:string,extra:any={})=>emit({type:'assistant',message:{id:responseId,content:[{type:'tool_use',id:callId,name:'mcp__dsh-goal__get_goal',input:{}}]},...extra});
  const thinking=(id:string,uuid:string)=>emit({type:'assistant',message:{id,content:[{type:'thinking',thinking:'checking'}]},user_message_uuid:uuid});
  const partial=(id:string,uuid?:string)=>emit({type:'stream_event',api_message_id:id,event:{type:'message_start',message:{id}},...(uuid?{user_message_uuid:uuid}:{})});
  const result=(uuid?:string,extra:any={})=>emit({type:'result',subtype:'success',...(uuid?{user_message_uuid:uuid}:{}),...extra});
  const settle=async()=>{await (session as any).goalOrigins?.flush();await tick();await history.flush();};
  const origins=async(id:string)=>{await settle();return (await history.messagePage(id)).entries.filter(e=>e.item.type==='claude_goal_origin').map(e=>e.item);};
  return {...f,boot,emit,assistant,thinking,partial,result,settle,origins,revocations,get creates(){return instances.length;},get closes(){return closes;},send:async(id:string)=>{await session.send(id,id);return sent.filter(m=>m.type==='user').at(-1).uuid as string;},get session(){return session;},get history(){return history;},
    reopenHistory:async()=>{history=new TaskHistory(f.directory,task.id);await history.open();},
    ledger:()=>readFile(join(f.directory,'claude-goal-origins',`${task.id}.jsonl`),'utf8')};
}

test('reviewer counterexamples: old UUID, historical and unstamped unseen root calls cannot acquire current B authority',async t=>{
  const p=await parser(t),b={epoch:'epoch-b',messageId:'B'},uuid=await p.boot(b);
  p.assistant('old-a-response','old-a-call',{user_message_uuid:'unknown-old-A'});
  p.assistant('historical-response','historical-call',{historical:true,user_message_uuid:uuid});
  p.assistant('unstamped-response','unstamped-call');
  p.assistant('replay-response','replay-call',{isReplay:true,user_message_uuid:uuid});
  p.assistant('child-response','child-call',{parent_tool_use_id:'parent',user_message_uuid:uuid});
  assert.deepEqual(await p.origins('B'),[]);
  p.thinking('live-b',uuid);
  for(const id of ['old-a-call','historical-call','unstamped-call','replay-call','child-call'])p.assistant('live-b',id);
  p.assistant('live-b','fresh-b');
  assert.deepEqual((await p.origins('B')).map(o=>o.callId),['fresh-b']);
  assert.equal((await p.origins('B'))[0].uuid,uuid);
});

test('first assistant thinking stamp binds later blocks and multiple tool cycles to the native send',async t=>{
  const p=await parser(t),uuid=await p.boot({epoch:'e',messageId:'B'});
  p.thinking('response-1',uuid);p.assistant('response-1','call-1');
  p.partial('response-2');p.assistant('response-2','call-2');
  p.partial('response-3');p.assistant('response-3','call-3');
  const origins=await p.origins('B');assert.deepEqual(origins.map(o=>o.callId),['call-1','call-2','call-3']);
  assert.ok(origins.every(o=>o.uuid===uuid&&o.messageId==='B'&&o.epoch==='e'));
  p.result(uuid);await p.settle();assert.equal(p.session.agent.status,'idle');
});

test('only partial carries UUID: a full assistant without a stamp uses the immutable API-response binding',async t=>{
  const p=await parser(t),uuid=await p.boot({epoch:'e',messageId:'B'});
  p.partial('response-1',uuid);p.assistant('response-1','call-1');
  p.partial('response-2');p.assistant('response-2','call-2');
  assert.deepEqual((await p.origins('B')).map(o=>o.callId),['call-1','call-2']);
});

test('old A result, historical result and unstamped modern result do not complete B',async t=>{
  const p=await parser(t),a=await p.boot({epoch:'a',messageId:'A'});
  p.thinking('a-response',a);p.result(a);await p.settle();
  const b=await p.boot({epoch:'b',messageId:'B'},true);
  p.result(a);p.result(b,{historical:true});p.result();await p.settle();
  assert.equal(p.session.agent.status,'running');assert.equal((await p.history.messagePage('B')).terminalStatus,undefined);
  p.thinking('b-response',b);p.result(b);await p.settle();assert.equal(p.session.agent.status,'idle');
  const before=await p.history.length();p.result(b);await p.settle();assert.equal(await p.history.length(),before);
});

test('reload and history truncation cannot rebind old response IDs or old/previously unbound call IDs',async t=>{
  const p=await parser(t),a=await p.boot({epoch:'a',messageId:'A'});
  p.assistant('unstamped-old','unbound-old');p.thinking('a-response',a);p.assistant('a-response','old-call');p.result(a);await p.settle();
  assert.match(await p.ledger(),/old-call/);
  await p.history.truncate(0);await p.reopenHistory();
  const b=await p.boot({epoch:'b',messageId:'B'},true);
  p.assistant('resume-unstamped','resume-call'); // resume can replay in-flight assistant before any new stamp
  p.assistant('a-response','spoof-old-response',{user_message_uuid:b});
  p.thinking('b-response',b);p.assistant('b-response','old-call');p.assistant('b-response','unbound-old');p.assistant('b-response','resume-call');p.assistant('b-response','fresh-b');
  assert.deepEqual((await p.origins('B')).map(o=>o.callId),['fresh-b']);
  assert.match(await p.ledger(),/"kind":"close"/);
});

test('legacy frames lacking native UUID metadata disable goal proof but still finish ordinary output',async t=>{
  const p=await parser(t);await p.boot({epoch:'a',messageId:'A'});
  p.emit({type:'system',subtype:'init',claude_code_version:'2.1.100'});
  p.assistant('legacy-response','legacy-call');assert.deepEqual(await p.origins('A'),[]);
  p.result();await p.settle();assert.equal(p.session.agent.status,'idle');assert.equal(p.session.agent.lastError,undefined);
});

test('an unsolicited background turn retains ordinary lifecycle but never receives a goal origin',async t=>{
  const p=await parser(t),uuid=await p.boot({epoch:'a',messageId:'A'});
  p.thinking('a',uuid);p.result(uuid);await p.settle();
  p.assistant('background','background-call');await p.settle();
  assert.equal(p.session.agent.activeTurn?.unprompted,true);
  assert.equal((await p.history.lines(1)).some(line=>line.includes('claude_goal_origin')&&line.includes('background-call')),false);
  p.result();await p.settle();assert.equal(p.session.agent.status,'idle');
});

test('before any B stamp, even an unknown unstamped result cannot close an opted-in B turn',async t=>{
  const p=await parser(t),uuid=await p.boot({epoch:'b',messageId:'B'});
  p.result('unknown-A');p.result();await p.settle();assert.equal(p.session.agent.status,'running');
  assert.equal((await p.history.messagePage('B')).terminalStatus,undefined);
  p.thinking('b',uuid);p.result(uuid);await p.settle();assert.equal(p.session.agent.status,'idle');
});

test('parented traffic cannot claim root authority or erase the genuine parent turn binding',async t=>{
  const p=await parser(t),uuid=await p.boot({epoch:'b',messageId:'B'});
  p.thinking('root-first',uuid);
  p.assistant('child-api','child-goal-call',{parent_tool_use_id:'parent-call',user_message_uuid:uuid});
  p.partial('root-next');p.assistant('root-next','root-goal-call');
  assert.deepEqual((await p.origins('B')).map(o=>o.callId),['root-goal-call']);
});

test('a separate Node process retains seen/closed IDs after display-history truncation',async t=>{
  const p=await parser(t),uuid=await p.boot({epoch:'a',messageId:'A'});
  p.assistant('unstamped-old','unbound-old');p.thinking('a-response',uuid);p.assistant('a-response','old-call');p.result(uuid);await p.settle();
  await p.history.truncate(0);
  const {stdout}=await promisify(execFile)(process.execPath,['--import','tsx',fileURLToPath(new URL('./fixtures/claude-goal-ledger-reload.mjs',import.meta.url)),join(p.directory,'claude-goal-origins','origin-audit.jsonl')],{timeout:10000});
  const result=JSON.parse(stdout.trim());for(const value of Object.values(result))assert.equal(value,true);
});

test('ordinary modern Claude handles no-UUID errors, keeps the same process, and settles background failures',async t=>{
  const p=await parser(t,false),a=await p.boot({epoch:'unused',messageId:'A'});
  assert.equal((p.session as any).goalOrigins,undefined);
  p.emit({type:'system',subtype:'init',claude_code_version:'2.1.319'});p.thinking('a',a);
  p.result(undefined,{subtype:'error_during_execution',is_error:true,errors:['session fault']});await p.settle();
  assert.equal(p.session.agent.status,'error');assert.match(p.session.agent.lastError!,/session fault/);assert.equal((await p.history.messagePage('A')).terminalStatus,'failed');
  const b=await p.send('B');p.thinking('b',b);p.result(b);await p.settle();assert.equal(p.session.agent.status,'idle');
  p.assistant('background','background-call');assert.equal(p.session.agent.activeTurn?.unprompted,true);
  p.result(undefined,{subtype:'error_during_execution',is_error:true,errors:['background fault']});await p.settle();
  assert.equal(p.session.agent.status,'error');assert.match(p.session.agent.lastError!,/background fault/);
  assert.equal(p.creates,1);assert.equal(p.closes,0);assert.equal(p.session.alive,true);assert.deepEqual(p.revocations,[]);
});

test('opted-in no-UUID session error revokes the current grant and fails explicitly instead of hanging or succeeding',async t=>{
  const p=await parser(t),uuid=await p.boot({epoch:'b',messageId:'B'});
  p.emit({type:'system',subtype:'init',claude_code_version:'2.1.319'});p.thinking('b',uuid);
  p.result(undefined,{subtype:'error_during_execution',is_error:true,errors:['zeroed session error']});await p.settle();
  assert.equal(p.session.agent.status,'error');assert.equal(p.session.agent.activeTurn,null);
  assert.equal((await p.history.messagePage('B')).terminalStatus,'failed');
  assert.equal(p.revocations.length,1);assert.equal(p.revocations[0].messageId,'B');assert.match(p.revocations[0].reason,/without a message UUID/);
  assert.match(p.session.agent.lastError!,/zeroed session error/);assert.match(await p.ledger(),/"kind":"close"/);
});

test('an explicit old A error UUID cannot fail or revoke B',async t=>{
  const p=await parser(t),a=await p.boot({epoch:'a',messageId:'A'});p.thinking('a',a);p.result(a);await p.settle();
  const b=await p.boot({epoch:'b',messageId:'B'},true);p.thinking('b',b);
  p.result(a,{subtype:'error_during_execution',is_error:true,errors:['old A fault']});await p.settle();
  assert.equal(p.session.agent.status,'running');assert.deepEqual(p.revocations,[]);assert.equal((await p.history.messagePage('B')).terminalStatus,undefined);
  p.result(b);await p.settle();assert.equal(p.session.agent.status,'idle');
});

test('Claude result failures retain protocol string arrays and compatible error/result details with or without UUID',async t=>{
  const cases:[Record<string,unknown>,string][]=[
    [{errors:['first fault','second fault'],result:'fallback'},'first fault\nsecond fault'],
    [{errors:[],error:{message:'structured fault'}},'structured fault'],
    [{error:'string fault'},'string fault'],
    [{subtype:'success',is_error:true,result:'failed result text'},'failed result text'],
    [{errors:[{type:'text',text:'content fault'}]},'content fault'],
    [{errors:[],result:''},'Claude turn failed'],
  ];
  for(const stamped of [false,true])for(const [fields,expected] of cases){
    const p=await parser(t,false),uuid=await p.boot({epoch:'unused',messageId:'A'});
    p.result(stamped?uuid:undefined,{subtype:'error_during_execution',is_error:true,...fields});await p.settle();
    assert.equal(p.session.agent.lastError,expected);
    assert.equal((await p.history.messagePage('A')).terminalStatus,'failed');
  }
});
