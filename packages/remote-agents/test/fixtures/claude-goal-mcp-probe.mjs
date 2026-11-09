// Explicit protocol-only probe server: real native goal schemas/pipeline on disposable in-memory state.
// This stdio harness replaces the unavailable socket transport for the Claude initialization probe only.
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { ClaudeGoalBridge } from '../../src/chat/claude-goal.ts';
const runtime=resolve(process.argv[2]),audit=process.argv[3];
const load=name=>import(pathToFileURL(join(runtime,'@deepseek-ai',name,'lib/index.js')).href);
const [{Context},sessions,llm]=await Promise.all(['cordis','dsh-session','dsh-llm'].map(load));
const ctx=new Context(),forks=[];
for(const name of ['dsh-session','dsh-session-projection','dsh-agent','dsh-system-prompt','dsh-tools','dsh-tool-executor-native','dsh-goal','dsh-tool-goal']){
 const mod=await load(name),fork=ctx.plugin(mod.default??mod,{});forks.push(fork);await fork.await();
}
const session=sessions.Session.create(sessions.SessionId('isolated-claude-protocol-probe'));
const agent={id:session.id,session,ctx,status:'running'};ctx.agents.enter(agent);
session.append('turn/start',{turn:1});
const human=llm.createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Read-only isolated protocol verification. No business work.'}]});session.append('user/message',human,{surfaceOp:'append'});
const bridge=new ClaudeGoalBridge(name=>ctx.get(name),undefined,id=>id===session.id);bridge.begin('probe-task',session.id,human,new AbortController().signal);
const send=message=>process.stdout.write(JSON.stringify(message)+'\n');
const lines=createInterface({input:process.stdin});
lines.on('line',async line=>{
 const m=JSON.parse(line);appendFileSync(audit,JSON.stringify({method:m.method,name:m.params?.name})+'\n');
 let result;
 try{
  if(m.method==='initialize')result={protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'dsh-goal-probe',version:'1'}};
  else if(m.method==='tools/list')result={tools:bridge.schemas(session.id).map(t=>({name:t.name,description:t.description,inputSchema:t.parameters}))};
  else if(m.method==='tools/call')result=await bridge.call('probe-task',session.id,m.params.name,m.params.arguments,new AbortController().signal,{...bridge.launchIdentity('probe-task',session.id),callId:m.params._meta?.['claudecode/toolUseId']});
  else if(m.method==='ping')result={};
  else if(m.id!==undefined)throw Error('Unsupported method');
  if(m.id!==undefined)send({jsonrpc:'2.0',id:m.id,result});
 }catch(e){if(m.id!==undefined)send({jsonrpc:'2.0',id:m.id,error:{code:-32603,message:String(e)}});}
});
lines.on('close',()=>process.exit(0));
