// Claude initialization/MCP discovery only. No LLM request, no auth, no business action, no real profile.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const runtime=resolve(process.argv[2]),root=await mkdtemp('/tmp/claude-goal-protocol-'),audit=join(root,'audit.jsonl');
await mkdir(join(root,'config'));
const script=fileURLToPath(new URL('./claude-goal-mcp-probe.mjs',import.meta.url));
const tsx=import.meta.resolve('tsx');
const config={mcpServers:{'dsh-goal':{type:'stdio',command:process.execPath,args:['--import',tsx,script,runtime,audit]}}};
const environment={PATH:process.env.PATH,HOME:root,TMPDIR:root,CLAUDE_CONFIG_DIR:join(root,'config'),CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'};
const {stdout:version}=await promisify(execFile)('claude',['--version'],{cwd:root,env:environment,timeout:15000});
const child=spawn('claude',['--bare','-p','--verbose','--input-format','stream-json','--output-format','stream-json','--no-session-persistence','--strict-mcp-config','--mcp-config',JSON.stringify(config),'--tools','','--setting-sources',''],{cwd:root,env:environment,stdio:['pipe','pipe','pipe']});
let stderr='',exited=false,nextId=0;const pending=new Map();child.stderr.on('data',b=>stderr+=b);child.on('exit',()=>exited=true);
createInterface({input:child.stdout}).on('line',line=>{try{const m=JSON.parse(line);if(m.type==='control_response'){pending.get(m.response.request_id)?.(m.response);pending.delete(m.response.request_id);}}catch{}});
const control=async request=>{const id=String(++nextId);return Promise.race([new Promise(r=>{pending.set(id,r);child.stdin.write(JSON.stringify({type:'control_request',request_id:id,request})+'\n');}),delay(15000).then(()=>({timeout:true}))]);};
try{
 const init=await control({subtype:'initialize'});let status;
 for(let i=0;i<20&&!exited;i++){status=await control({subtype:'mcp_status'});const servers=status.response?.mcpServers;if(servers?.some(s=>s.status==='connected'))break;await delay(200);}
 const observed=await readFile(audit,'utf8').catch(()=> '');
 const servers=status?.response?.mcpServers??[];
 const result={claude:version.trim(),initialize:init.subtype??init,servers,observed:observed.trim().split('\n').filter(Boolean).map(JSON.parse),scope:'Protocol initialization and real goal schema discovery only; no model call or business action. Direct stdio harness, reverse socket transport not verified.',stderr:stderr.slice(0,2000)};
 console.log(JSON.stringify(result));
 if(init.subtype!=='success'||!servers.some(s=>s.name==='dsh-goal'&&s.status==='connected')||!observed.includes('tools/list'))process.exitCode=1;
}finally{child.stdin.end();child.kill('SIGTERM');await delay(100);if(!exited)child.kill('SIGKILL');await rm(root,{recursive:true,force:true});}
