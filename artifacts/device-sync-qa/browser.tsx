import React from '../../packages/device-sync/node_modules/react/index.js'
import { createRoot } from '../../packages/device-sync/node_modules/react-dom/client.js'
import { SyncSettings } from '../../packages/device-sync/src/client/settings'
import { setNavigation } from '../../packages/device-sync/src/client/navigation'
const status:any = {device:{deviceId:'local',name:'Laptop'},listener:{address:'100.1.1.1:47630'},peers:[{deviceId:'remote',name:'Mac mini',endpoint:'100.1.1.2',connection:'online',pairedAt:Date.now(),grantsFromPeer:{history:true,command:true},grantsToPeer:{history:true,command:false},pending:0}],pairings:[],workspaces:[{deviceId:'local',items:[{workspaceId:'local-ws',title:'Local project',path:'/local',order:0,sessionIds:[]}]},{deviceId:'remote',items:[{workspaceId:'remote-ws',title:'Remote project',path:'/remote/project',order:0,sessionIds:['s1','s2']}]}],sessions:[{deviceId:'remote',sessionId:'s1',workspaceId:'remote-ws',title:'First task',updatedAt:Date.now(),lastSeq:1,storedSeq:1,archived:false,state:'waiting',pending:[{kind:'approval',id:'approval1',toolName:'test command',reason:'Run tests',askedAt:Date.now(),answerable:true}]},{deviceId:'remote',sessionId:'s2',workspaceId:'remote-ws',title:'Second task',updatedAt:Date.now(),lastSeq:1,storedSeq:1,archived:false,state:'idle',pending:[]},...[3,4,5,6,7,8].map(n=>({deviceId:'remote',sessionId:'s'+n,workspaceId:'remote-ws',title:'Old task '+n,updatedAt:Date.now()-n*86400000,lastSeq:1,storedSeq:1,archived:false,state:'idle',pending:[]}))],groups:{tags:[{id:'work',name:'Work tag',color:'blue',order:0}],assignments:{},links:[],conflicts:[],tagsPlugin:true},outbox:[],backups:[]}
const calls:any[]=[]
const opened:string[]=[]
setNavigation(()=>({openSession:(id:string)=>{opened.push(id)}}))
let continueFailures=1
let rejectPrompt=false
const streams: {session:string; signal:AbortSignal; close():void; active():boolean}[]=[]
let reconnects=0

window.fetch=async (url:any,opts:any={}) => {
 if(String(url).includes('/live')) {
  const session=new URL(String(url),'http://localhost').searchParams.get('session')!
  reconnects++
  return new Response(new ReadableStream({start(c){
   let closed=false
   const close=()=>{if(!closed){closed=true;c.close()}}
   streams.push({session,signal:opts.signal,close,active:()=>!closed&&!opts.signal.aborted})
   opts.signal.addEventListener('abort',close,{once:true})
   c.enqueue(new TextEncoder().encode(JSON.stringify({type:'draft',attemptId:'draft1',text:'LIVE '+session,reasoning:''})+'\n'))
  }}))
 }

 if(!opts.body) return Response.json(structuredClone(status))
 const a=JSON.parse(opts.body); calls.push(a)
 if(a.action==='events') return Response.json({events:[{seq:1,type:'user/message',time:Date.now(),data:{content:[{type:'text',text:a.sessionId==='s1'?'HISTORY ONE':'HISTORY TWO'}]}}]})
 if(a.action==='assign') status.groups.assignments[a.workspaceRef]=a.assigned?[a.tagId]:[]
 if(a.action==='link') status.groups.links=a.linked?[[a.localRef,a.remoteRef]]:[]
 if(a.action==='continueHere') {
  if(continueFailures-->0) return Response.json({error:'The request failed on this machine'},{status:502})
  return Response.json({ok:true,sessionId:'local-new'})
 }
 if(a.action==='hideSession') status.sessions.find((s:any)=>s.sessionId===a.sessionId).hidden=a.hidden
 if(a.action==='command') {
  if(rejectPrompt && a.command.kind==='prompt') return Response.json({error:'The message is too long'},{status:400})
  if(a.command.kind==='approval') status.sessions[0].pending=[]
  return Response.json({result:{ok:true,sessionId:a.command.sessionId}})
 }
 return Response.json({ok:true})
}
const results:string[]=[]
const wait=(ms=80)=>new Promise(r=>setTimeout(r,ms))
function assert(ok:any,message:string){if(!ok)throw new Error(message);results.push(message)}
function button(text:string){const el=[...document.querySelectorAll('button')].find(e=>e.textContent===text);if(!el)throw new Error('Missing button '+text);return el}
function check(text:string){const el=[...document.querySelectorAll('label')].find(e=>e.textContent?.includes(text))?.querySelector('input');if(!el)throw new Error('Missing checkbox '+text);el.click()}
function fold(text:string){const el=[...document.querySelectorAll('button.dsy-fold')].find(e=>e.textContent?.includes(text));if(!el)throw new Error('Missing fold '+text);return el as HTMLButtonElement}
function has(text:string){return [...document.querySelectorAll('button')].some(e=>e.textContent===text)}
function search(text:string){const el=document.querySelector('input[type=search]') as HTMLInputElement;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(el,text);el.dispatchEvent(new Event('input',{bubbles:true}))}
function inputText(text:string){const el=document.querySelector('textarea')!;Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(el,text);el.dispatchEvent(new Event('input',{bubbles:true}));}
createRoot(document.getElementById('root')!).render(<SyncSettings />)
async function test(){try{
 await wait();await wait()
 assert(document.body.textContent?.includes('Remote workspaces'),'remote workspace section rendered')
 assert(!document.querySelector('.dsy-chip')&&fold('1 workspaces').getAttribute('aria-expanded')==='false','remote workspaces start folded')
 fold('1 workspaces').click();await wait();assert(document.body.textContent?.includes('/remote/project'),'unfolded card lists remote workspace and path')
 assert(!document.body.textContent?.includes('Linked workspaces')&&!document.body.textContent?.includes('Local project'),'no local workspace link list')
 const chip=()=>[...document.querySelectorAll('button.dsy-chip')].find(e=>e.textContent==='Work tag') as HTMLButtonElement
 assert(chip().getAttribute('aria-pressed')==='false','group chip starts unselected')
 chip().click();await wait();assert(calls.some(a=>a.action==='assign'&&a.workspaceRef==='remote:remote-ws'&&a.tagId==='work'&&a.assigned),'group chip assigns with remote ref')
 assert(chip().getAttribute('aria-pressed')==='true','assigned chip shows selected')
 chip().click();await wait();assert(calls.some(a=>a.action==='assign'&&a.tagId==='work'&&a.assigned===false)&&chip().getAttribute('aria-pressed')==='false','selected chip removes the group')
 status.peers[0].grantsToPeer.history=false;await wait(2200)
 assert(chip().disabled&&document.querySelector('.dsy-warn')?.textContent?.includes('does not share with Mac mini'),'chips lock with a reason when this machine does not share')
 status.peers[0].grantsToPeer.history=true;status.peers[0].connection='offline';await wait(2200)
 assert(!chip().disabled&&document.body.textContent?.includes('Mac mini is offline; group changes reach it when it is back online.'),'offline machine keeps chips with a delay note')
 status.peers[0].connection='online';await wait(2200)
 assert(!has('First task')&&fold('8 sessions').getAttribute('aria-expanded')==='false','device card starts folded')
 assert(fold('8 sessions').textContent?.includes('Mac mini'),'folded card shows its session count')
 search('old TASK 7');await wait();assert(has('Old task 7')&&!has('First task')&&!has('Old task 3'),'search unfolds the card and filters by title')
 search('remote proj');await wait();assert(has('First task')&&has('Old task 8'),'search matches workspace title and lists every match')
 search('nothing here');await wait();assert(document.body.textContent?.includes('No synced sessions match these filters.'),'search with no match says so')
 search('');await wait();assert(!has('First task'),'clearing search folds the card again')
 fold('8 sessions').click();await wait();assert(has('First task')&&has('Old task 5')&&!has('Old task 6'),'unfolded group previews five newest sessions')
 button('Show 3 more').click();await wait();assert(has('Old task 8'),'show more lists the rest')
 button('Show fewer').click();await wait();assert(!has('Old task 6'),'show fewer returns to the preview')
 fold('Remote project').click();await wait();assert(!has('First task'),'workspace group folds')
 fold('Remote project').click();await wait()
 button('First task').click();await wait();assert(document.body.textContent?.includes('HISTORY ONE'),'first history displayed')
 button('Allow once').click();await wait();assert(calls.some(a=>a.command?.approvalId==='approval1'&&a.command.outcome==='allowed-once'),'explicit approval sent')
 inputText('Hello remote');await wait();button('Send').click();button('Send').click();await wait();assert(calls.filter(a=>a.command?.kind==='prompt').length===1,'double click sends one prompt')
 button('Second task').click();await wait();assert(document.body.textContent?.includes('HISTORY TWO')&&!document.body.textContent?.includes('HISTORY ONE'),'session switching isolates history')
 rejectPrompt=true;inputText('Rejected text');await wait();button('Send').click();await wait();assert(document.body.textContent?.includes('The message is too long'),'server rejection shown')
 assert(!(document.querySelector('textarea') as HTMLTextAreaElement).disabled,'definite rejection allows correcting message')
 assert(streams[0].signal.aborted,'switching aborts old live stream')
 const current=streams.at(-1)!
 assert(current.session==='s2'&&!current.signal.aborted,'selected session owns live stream')
 const before=reconnects;current.close();await wait(100)
 assert(!document.body.textContent?.includes('LIVE s2'),'EOF clears stale draft')
 await wait(3100)
 assert(reconnects===before+1,'EOF reconnects once after delay')
 assert(document.body.textContent?.includes('LIVE s2'),'reconnected stream updates draft')
 assert(streams.filter(s=>s.active()).length===1,'no parallel active retry streams')
 const latest=streams.at(-1)!;latest.close();await wait(100)
 const closing=reconnects;button('Close').click();await wait(3200)
 assert(latest.signal.aborted,'closing aborts stream lifecycle')
 assert(reconnects===closing,'closing cancels pending retry')
 button('First task').click();await wait();const offline=streams.at(-1)!
 status.peers[0].connection='offline';await wait(2200)
 assert(offline.signal.aborted,'going offline aborts live stream')
 const count=reconnects;await wait(3100);assert(reconnects===count,'offline sessions do not reconnect')
 status.peers[0].connection='online';await wait(2200)
 assert(reconnects===count+1,'returning online resumes live stream')
 const grant=streams.at(-1)!;status.peers[0].grantsFromPeer.history=false;await wait(2200)
 assert(grant.signal.aborted,'revoked history grant aborts live stream')
 const revoked=reconnects;await wait(3100);assert(reconnects===revoked,'revoked grant prevents reconnect')
 assert(!document.body.textContent?.includes('Continue on this machine'),'no continuation for a session outside an SSH workspace')
 const api={host:'dev.example.com',username:'me',port:22,remotePath:'/srv/api'}
 status.peers[0].grantsFromPeer.history=true
 status.workspaces[1].items.push({workspaceId:'ssh-ws',title:'SSH project',path:'/remote/ssh',order:1,sessionIds:['s9'],remote:api})
 status.sessions.push({deviceId:'remote',sessionId:'s9',workspaceId:'ssh-ws',title:'SSH task',updatedAt:Date.now(),lastSeq:3,storedSeq:1,archived:false,state:'idle',pending:[]})
 await wait(2200)
 button('SSH task').click();await wait()
 assert(document.body.textContent?.includes('This machine has no workspace for ssh://me@dev.example.com/srv/api yet. Add this SSH machine under Settings → Remote agents')&&!has('Continue here'),'without a matching workspace the viewer says how to add one')
 status.workspaces[0].items.push({workspaceId:'local-ssh',title:'api on Mac mini',path:'/home/.dsh/remote-workspaces/dev/api',order:1,sessionIds:[],remote:{...api,host:'Dev.Example.com',remotePath:'/srv/api/'}})
 await wait(2200)
 assert(document.body.textContent?.includes('Starts a new conversation in api on Mac mini on this machine, with this conversation’s history. The original conversation is not changed.'),'a matching workspace is named before starting')
 assert(document.querySelector('.dsy-continue .dsy-warn')?.textContent?.includes('has not been copied here yet'),'a mirror behind its machine says so')
 const note=document.querySelector('.dsy-continue textarea') as HTMLTextAreaElement
 Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(note,'Add a test');note.dispatchEvent(new Event('input',{bubbles:true}));await wait()
 button('Continue here').click();button('Continue here').click();await wait()
 const firstTry=calls.filter(a=>a.action==='continueHere')
 assert(firstTry.length===1&&firstTry[0].workspaceId==='local-ssh'&&firstTry[0].sessionId==='s9'&&firstTry[0].deviceId==='remote'&&firstTry[0].note==='Add a test','double click sends one continuation with the note')
 assert(has('Try again')&&(document.querySelector('.dsy-continue textarea') as HTMLTextAreaElement).disabled&&opened.length===0,'an uncertain failure locks the note and offers the same request again')
 button('Try again').click();await wait()
 const tries=calls.filter(a=>a.action==='continueHere')
 assert(tries.length===2&&tries[1].requestId===tries[0].requestId,'trying again reuses the request ID')
 assert(opened.length===1&&opened[0]==='local-new','the new local conversation is opened')
 document.getElementById('result')!.textContent=JSON.stringify({ok:true,results})
 }catch(e){document.getElementById('result')!.textContent=JSON.stringify({ok:false,results,error:String(e)})}}
void test()
