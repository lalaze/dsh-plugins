import { createHash } from 'node:crypto';
import { remoteScript, REMOTE_HOME } from '../core/remote-host.js';
import { RemoteError } from '../core/domain.js';
import { NATIVE_LIMIT } from './native-protocol.js';
/** Separate protocol, storage and non-expiring ownership from the CLI force-claim registry. */
export const NATIVE_SCRIPT = String.raw `
import fs from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
const root = process.argv[2], LIMIT = 12 * 1024 * 1024;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const metadata = r => ({id:r.id,version:r.version,digest:r.digest,owner:r.owner,archived:r.archived,deleted:r.deleted,title:r.snapshot.title,project:r.snapshot.project,...(r.snapshot.autonomy ? {autonomyDigest:hash(r.snapshot.autonomy)} : {})});
function validateSnapshot(s) {
 if(!s || s.protocol !== 'shared-native-v1' || !Array.isArray(s.events) || !Array.isArray(s.files)) throw Error('Invalid native snapshot');
 if(s.autonomy !== undefined) {
  const a=s.autonomy;
  if(!a || a.schema!==1 || a.rootId!==s.header?.id || !Array.isArray(a.children) || a.children.length>64 || !Array.isArray(a.queues) || !Array.isArray(a.schedules) || a.schedules.length>256) throw Error('Invalid native autonomy packet or canonical root');
 }
 if(Buffer.byteLength(JSON.stringify(s))>LIMIT) throw Error('Native snapshot exceeds total payload limit');
}
function reply(result) { const output=JSON.stringify({result}); if(Buffer.byteLength(output)>LIMIT+1024) throw Error('Native response exceeds total payload limit'); process.stdout.write(output); }
function directory(path) { try { fs.mkdirSync(path, { mode: 0o700 }); } catch(e) { if(e.code !== 'EEXIST') throw e; } if (!fs.lstatSync(path).isDirectory() || fs.lstatSync(path).isSymbolicLink()) throw Error('Unsafe native registry directory'); }
function read(path) { const info = fs.lstatSync(path); if (!info.isFile() || info.isSymbolicLink() || info.size > LIMIT) throw Error('Unsafe or oversized native record'); return JSON.parse(fs.readFileSync(path, 'utf8')); }
function save(path, value) { const data = JSON.stringify(value); if (Buffer.byteLength(data) > LIMIT) throw Error('Native snapshot exceeds limit'); const tmp = path + '.' + randomUUID() + '.tmp'; const fd = fs.openSync(tmp, 'wx', 0o600); try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } fs.renameSync(tmp, path); const dir = fs.openSync(root, 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); } }
try {
 let input = ''; process.stdin.setEncoding('utf8'); for await (const chunk of process.stdin) { input += chunk; if (Buffer.byteLength(input) > LIMIT) throw Error('Native request exceeds total payload limit'); }
 const p = JSON.parse(input);
 if (p.protocol !== 'shared-native-v1' || !/^[a-zA-Z0-9_-]{8,100}$/.test(p.instance)) throw Error('Unsupported native client');
 directory(root);
 if (p.action === 'list') {
  const items = fs.readdirSync(root).filter(name => /^[a-f0-9-]{36}\.json$/.test(name));
  if (items.length > 1000) throw Error('Native registry exceeds 1000 records');
  const result = items.map(name => metadata(read(join(root, name))));
  reply(result);
 } else {
  if (!/^[a-f0-9-]{36}$/.test(p.id)) throw Error('Invalid native sharing ID');
  const file = join(root, p.id + '.json'), lock = join(root, p.id + '.lock');
  if(p.action === 'diagnose-lock') {
   let result={id:p.id,locked:false};
   try { const info=fs.lstatSync(lock); if(!info.isFile() || info.isSymbolicLink() || info.size>64) throw Error('Unsafe native lock');
    const pid=Number(fs.readFileSync(lock,'utf8')); let processAlive='unknown';
    if(Number.isSafeInteger(pid) && pid>0) { try { process.kill(pid,0); processAlive='yes'; } catch(e) { if(e.code==='ESRCH') processAlive='no'; } }
    result={id:p.id,locked:true,pid,processAlive,modifiedAt:info.mtime.toISOString(),automaticRemoval:false};
   } catch(e) { if(e.code!=='ENOENT') throw e; }
   process.stdout.write(JSON.stringify({result})); process.exit(0);
  }
  let fd; for (let i=0; i<100; i++) { try { fd = fs.openSync(lock,'wx',0o600); break; } catch(e) { if(e.code !== 'EEXIST') throw e; await new Promise(r=>setTimeout(r,20)); } }
  if(fd === undefined) throw Error('Native registry is locked; no automatic lock stealing');
  try {
   fs.writeFileSync(fd, String(process.pid)); fs.fsyncSync(fd);
   let r; try { r = read(file); } catch(e) { if(e.code !== 'ENOENT') throw e; }
   let result, receipt;
   if(p.action === 'get') { result=r ?? {id:p.id,missing:true}; }
   else if(p.action === 'cancel-create') {
    if(typeof p.op !== 'string' || !/^[a-f0-9-]{36}$/.test(p.op)) throw Error('Invalid cancellation ID');
    if(r?.cancelledBy === p.instance) result=r;
    else {
     if(r && (r.creator !== p.instance || r.version !== 1 || r.owner !== null || !r.receipts.includes(p.createOp))) throw Error('Enrollment was created/claimed elsewhere; cancellation is unsafe');
     r={id:p.id,version:(r?.version??0)+1,owner:null,token:null,archived:false,deleted:true,creator:p.instance,cancelledBy:p.instance,receipts:[p.op],snapshot:{protocol:'shared-native-v1',title:'Cancelled enrollment',project:'',events:[],files:[]}};
     r.digest=hash(r.snapshot); save(file,r); result=r;
    }
   }
   else if(r?.receipts?.includes(p.op)) {
    receipt=r.receiptData?.[p.op];
    if(receipt && (receipt.instance!==p.instance || receipt.requestDigest!==hash(p))) throw Error('Native operation replay payload conflict');
    result=r;
   }
   else {
    if(typeof p.op !== 'string' || !/^[a-f0-9-]{36}$/.test(p.op)) throw Error('Invalid operation ID');
    if(p.action === 'create') {
     if(r || p.version !== 0 || p.snapshot?.protocol !== 'shared-native-v1') throw Error('Native create conflict');
     validateSnapshot(p.snapshot);
     r={ id:p.id,version:1,owner:null,token:null,archived:false,deleted:false,creator:p.instance,snapshot:p.snapshot,receipts:[] };
    } else {
     if(!r || r.deleted || r.version !== p.version || r.digest !== p.digest) throw Error('Native version conflict; local data retained');
     if(p.action === 'claim') {
      if(typeof p.token !== 'string' || !/^[a-f0-9-]{36}$/.test(p.token)) throw Error('Invalid native owner token');
      if(r.owner !== null || r.archived) throw Error('Native session is held or archived; request handoff on its owner');
      r.owner=p.instance; r.token=p.token;
     } else if(p.action === 'restore') {
      if(r.owner !== null || !r.archived) throw Error('Only an idle archived native session can be restored');
      r.archived=false;
     } else {
      if(r.owner !== p.instance || r.token !== p.token) throw Error('Native ownership conflict');
      if(p.action === 'check') { result=r; }
      else if(p.action === 'append') {
       if(!Array.isArray(p.events) || p.offset !== r.snapshot.events.length) throw Error('Native history prefix conflict');
       r.snapshot.events.push(...p.events); r.snapshot.title=p.title;
       const files=new Map(r.snapshot.files.map(f=>[JSON.stringify(f.ref),f]));
       for(const f of p.files ?? []) files.set(JSON.stringify(f.ref),f);
       r.snapshot.files=[...files.values()];
       if(Object.hasOwn(p,'autonomy')) r.snapshot.autonomy=p.autonomy;
       validateSnapshot(r.snapshot);
      } else if(p.action === 'release' || p.action === 'withdraw' || p.action === 'archive' || p.action === 'delete') {
       r.owner=null; r.token=null;
       if(p.action === 'archive') r.archived=true;
       if(p.action === 'delete' || p.action === 'withdraw') { r.deleted=true; r.snapshot.events=[]; r.snapshot.files=[]; delete r.snapshot.autonomy; r.snapshot.title='Deleted shared native conversation'; }
      } else throw Error('Unknown native mutation');
     }
     if(!result) r.version++;
    }
    if(!result) {
     r.digest=hash(r.snapshot); r.receipts=[...(r.receipts??[]),p.op].slice(-64);
     receipt={op:p.op,instance:p.instance,requestDigest:hash(p),version:r.version,digest:r.digest,...(r.snapshot.autonomy?{autonomyDigest:hash(r.snapshot.autonomy)}:{})};
     r.receiptData=Object.fromEntries(r.receipts.map(op=>[op,op===p.op?receipt:r.receiptData?.[op]]).filter(([,value])=>value));
     save(file,r); result=r;
    }
   }
   reply(p.action==='get'?result:{...metadata(result),...(receipt?{receipt}:{}),...(p.action==='cancel-create'?{cancelled:result.cancelledBy===p.instance}:{})});
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
 }
} catch(error) { process.stdout.write(JSON.stringify({error:error.message})); }
`;
const version = createHash('sha256').update(NATIVE_SCRIPT).digest('hex').slice(0, 16);
const script = remoteScript('native', version, NATIVE_SCRIPT, { directories: [`${REMOTE_HOME}/shared-native-v1`] });
const installed = new WeakMap();
/** Binary-bounded transport reuses the existing verified SSH workspace connection. */
export async function nativeRpc(transport, request) {
    if (!transport.transfer)
        throw new RemoteError('Native sharing needs bounded SSH transfer support', 501);
    const bytes = Buffer.from(JSON.stringify(request));
    if (bytes.length > NATIVE_LIMIT)
        throw new RemoteError('Native snapshot exceeds 12 MiB', 413);
    let installation = installed.get(transport);
    if (!installation) {
        installation = transport.exec(script.install, 20_000, { login: false }).then(result => { if (result.trim() !== 'ready')
            throw new RemoteError('Native sharing requires Node.js 18 or newer on the SSH host', 501); });
        installed.set(transport, installation);
    }
    try {
        await installation;
    }
    catch (error) {
        installed.delete(transport);
        throw error;
    }
    let response;
    try {
        response = await transport.transfer(`node ${script.path} ${REMOTE_HOME}/shared-native-v1`, {
            input: (async function* () { yield bytes; })(), maxBytes: NATIVE_LIMIT + 1024, signal: AbortSignal.timeout(20_000), login: false,
        });
    }
    catch (error) {
        installed.delete(transport);
        throw error;
    }
    const value = JSON.parse(response.toString('utf8'));
    if (typeof value.error === 'string')
        throw new RemoteError(value.error, 409);
    return value.result;
}
