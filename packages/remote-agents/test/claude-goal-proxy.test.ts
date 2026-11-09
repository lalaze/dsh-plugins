import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { join } from 'node:path';
import { BRIDGE_SCRIPT } from '../src/sharing/bridge-script.js';
import { CliSession } from '../src/agents/runtime.js';
import { TaskHistory } from '../src/agents/history.js';
import { fixture } from './fakes.js';
import { verifyClaudeGoalOrigin } from '../src/chat/claude-goal.js';

// Executes the actual embedded proxy with in-memory fs/stdin/net. No socket is opened.
function proxy(initial: Record<string, unknown>) {
  const input=new EventEmitter(),stdin=new EventEmitter(),sockets:any[]=[],timers:(()=>void)[]=[],output:any[]=[],wire:any[]=[],files=new Map<string,string>([['/task',JSON.stringify(initial)],['/pointer','/socket']]);
  const createConnection=()=>{const socket=new EventEmitter() as any;Object.assign(socket,{destroyed:false,setEncoding(){},write(line:string){wire.push(JSON.parse(line));},destroy(){this.destroyed=true;}});sockets.push(socket);return socket;};
  const process={argv:['node','bridge','proxy','/task','.claude-goal'],stdin,stdout:{write:(line:string)=>output.push(JSON.parse(line))},stderr:{write(){}},exit:(code:number)=>{throw Error(`exit ${code}`);},pid:123};
  const source=BRIDGE_SCRIPT.replace(/^import .*;$/gm,'');
  vm.runInNewContext(source,{process,join,createInterface:()=>input,createConnection,fs:{readFileSync:(path:string)=>files.get(path),writeFileSync:(path:string,value:string)=>files.set(path,value),renameSync:(a:string,b:string)=>files.set(b,files.get(a)!)},setTimeout:(fn:()=>void)=>{timers.push(fn);return {unref(){}};},clearTimeout(){},Buffer});
  return {input,get socket(){return sockets.at(-1);},output,wire,reconnect:()=>timers.at(-1)!(),replace:(value:unknown)=>files.set('/task',JSON.stringify(value)),connect:()=>{const socket=sockets.at(-1);socket.emit('connect');socket.emit('data',JSON.stringify({hello:'ok'})+'\n');}};
}
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
test('persistent proxy freezes A origin before delayed connection; mutating the credential file to B never upgrades it',async()=>{
  const a={task:'task',session:'session',token:'token-a',epoch:'epoch-a',messageId:'message-a',pointer:'/pointer',cache:'/cache'};
  const p=proxy(a);
  p.input.emit('line',JSON.stringify({jsonrpc:'2.0',id:7,method:'tools/call',params:{name:'create_goal',arguments:{objective:'A synthetic'},_meta:{'claudecode/toolUseId':'native-call-a'}}}));
  p.replace({...a,token:'token-b',epoch:'epoch-b',messageId:'message-b'});p.connect();await tick();
  assert.equal(p.wire[0].epoch,'epoch-a');assert.equal(p.wire[0].token,'token-a');
  const call=p.wire.find(m=>m.op==='call');assert.equal(call.epoch,'epoch-a');assert.equal(call.messageId,'message-a');assert.equal(call.callId,'native-call-a');
});
test('proxy reconnect retains A credential and call identity; it never fetches a newer epoch',async()=>{
  const a={task:'task',session:'session',token:'token-a',epoch:'epoch-a',messageId:'message-a',pointer:'/pointer',cache:'/cache'},p=proxy(a);
  p.connect();await tick();p.replace({...a,token:'token-b',epoch:'epoch-b',messageId:'message-b'});
  p.socket.emit('close');p.reconnect();p.connect();await tick();
  p.input.emit('line',JSON.stringify({jsonrpc:'2.0',id:9,method:'tools/call',params:{name:'get_goal',arguments:{},_meta:{'claudecode/toolUseId':'same-native-id'}}}));await tick();
  assert.equal(p.wire.filter(m=>m.op==='hello').length,2);assert.ok(p.wire.filter(m=>m.op==='hello').every(m=>m.token==='token-a'&&m.epoch==='epoch-a'));
  const call=p.wire.find(m=>m.op==='call');assert.equal(call.epoch,'epoch-a');assert.equal(call.callId,'same-native-id');
});
test('proxy refuses missing native tool-use metadata rather than minting an ID from current state',async()=>{
  const p=proxy({task:'t',token:'a',epoch:'a',messageId:'a',pointer:'/pointer',cache:'/cache'});p.connect();
  p.input.emit('line',JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'get_goal',arguments:{}}}));await tick();
  assert.equal(p.wire.some(m=>m.op==='call'),false);assert.equal(p.output[0].result.isError,true);
});

test('real CliSession requires a native UUID stamp before recording an origin',async t=>{
  const f=await fixture(t),task={...f.request({id:'goal-origin-task',provider:'claude'}),serverId:'remote-box-1',title:'probe',createdAt:'',state:'ready' as const};
  await f.store.update(s=>s.tasks.push(task));
  const history=new TaskHistory(f.directory,task.id);await history.open();
  let receive:(message:any,frame:any)=>void=()=>{};const sent:any[]=[];
  const peer:any={alive:true,onMessage:(fn:any)=>receive=fn,onExit(){},control:async()=>({}),send:(m:any)=>sent.push(m),close(){this.alive=false;}};
  const session=new CliSession(peer,task,history,f.store);t.after(()=>session.close());
  const identity={epoch:'epoch-a',messageId:'message-a'};
  await session.initialize('claude',['claude','--session-id','native-session'],false,[],identity);await session.send('A',identity.messageId);
  const uuid=sent.find(m=>m.type==='user').uuid;
  const frame={type:'assistant',session_id:'native-session',parent_tool_use_id:null,message:{id:'response-a',content:[{type:'tool_use',id:'root-a',name:'mcp__dsh-goal__get_goal',input:{}}]},user_message_uuid:uuid};
  receive(frame,{end:1});await (session as any).goalOrigins.flush();await tick();await history.flush();
  const origins=(await history.messagePage(identity.messageId)).entries.filter(e=>e.item.type==='claude_goal_origin');
  assert.equal(origins.length,1);assert.equal(origins[0].item.uuid,uuid);
  assert.equal(await verifyClaudeGoalOrigin(cursor=>history.messagePage(identity.messageId,cursor),async()=>true,{...identity,callId:'root-a'},'get_goal',{},new AbortController().signal),true);
  receive({type:'result',subtype:'success',session_id:'native-session',user_message_uuid:uuid},{end:2});await history.flush();
  assert.equal(session.agent.status,'idle');
});
