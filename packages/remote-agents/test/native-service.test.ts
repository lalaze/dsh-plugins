import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Session, SessionId, buildForkSeed } from '@deepseek-ai/dsh-session';
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm';
import { NativeSharing, type NativeHost } from '../src/chat/native-service.js';
import { NATIVE_SCRIPT, nativeRpc, type NativeRpc } from '../src/chat/native-registry.js';
import { fileRefs, validateNative, validateNativeInput, nativeSelection, type NativeSnapshot } from '../src/chat/native-protocol.js';

export function conversation(): NativeSnapshot {
  const id = SessionId(randomUUID()), session = Session.create(id, undefined, { version: 4, id, createdAt: 1, cwd: '/srv/project', isSeeded: false, delegationDepth: 0 } as never);
  session.append('turn/start', { turn: 1 }); session.append('step/start', { turn: 1, step: 1 });
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Original native prompt' }], source: { kind: 'user' } }), { surfaceOp: 'append' });
  session.append('request/header', { header: { config: { provider: 'normal', model: 'native-model' } }, reason: 'initial' } as never);
  session.append('assistant/message', { turn: 1, step: 1, message: createAssistantMessage({ content: [{ type: 'text', text: 'Original native answer' }], source: { provider: 'normal', model: 'native-model' } }), stream: [] }, { surfaceOp: 'append' });
  session.append('step/end', { turn: 1, step: 1 }); session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  return { protocol: 'shared-native-v1', header: session.header, inheritedEventCount: 0, project: '/srv/project', title: 'Native chat', events: structuredClone([...session.snapshotEvents()]), files: [] };
}
async function setup(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'native-service-')); t.after(() => rm(root, { recursive: true, force: true }));
  const script = join(root, 'registry.mjs'), registry = join(root, 'registry'); await writeFile(script, NATIVE_SCRIPT);
  let offline = false, lost = false;
  const calls: Record<string, unknown>[] = [];
  const rpc: NativeRpc = { async call(_host, request) {
    calls.push(request);
    if (offline) throw new Error('offline');
    const result = await new Promise<any>((accept, reject) => {
      const child = spawn(process.execPath, [script, registry], { stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '', err = ''; child.stdout.on('data', data => { out += data; }); child.stderr.on('data', data => { err += data; });
      child.on('error', reject); child.on('exit', code => { if (code) return reject(new Error(err)); const value = JSON.parse(out); value.error ? reject(new Error(value.error)) : accept(value.result); });
      child.stdin.end(JSON.stringify(request));
    });
    if (lost) { lost = false; throw new Error('reply lost after remote commit'); }
    return result;
  } };
  const maps = new Map<string, NativeSnapshot>(), busy = new Set<string>(), sealed = new Set<string>(), archived = new Set<string>();
  let imports = 0, activations = 0, unavailable = false;
  const host: NativeHost = {
    available: () => true,
    async placement(_session, hostId) { if (hostId !== 'remote-host') throw new Error('local workspace is not verified'); return '/srv/project'; },
    async idle(id, action) { if (busy.has(id)) throw new Error('busy'); return action(); },
    async snapshot(id) { const snapshot = maps.get(id); if (!snapshot) throw new Error('snapshot missing'); return structuredClone(snapshot); },
    async validate(snapshot) { validateNative(snapshot); if (unavailable) throw new Error('model unavailable'); },
    async import(id, _host, snapshot) { if (maps.has(id)) throw new Error('already exists'); maps.set(id, structuredClone(snapshot)); imports++; },
    async activate() { activations++; },
    async seal(id) { sealed.add(id); },
    async unseal(id) { sealed.delete(id); },
    async archive(id) { archived.add(id); },
  };
  const machine = (name: string) => new NativeSharing(join(root, `${name}.json`), name, rpc, host);
  const air = machine('instance-air'), mini = machine('instance-mini');
  await air.configure('remote-host', true); await mini.configure('remote-host', true);
  const id = randomUUID(); maps.set(id, conversation());
  return { root, registry, air, mini, host, rpc, calls, machine, maps, busy, sealed, archived, id,
    offline: (value: boolean) => { offline = value; }, lost: () => { lost = true; }, unavailable: () => { unavailable = true; }, counts: () => ({ imports, activations }) };
}

test('two instances import exact native logs, publish only suffixes, handoff and continue linked copies', async t => {
  const x = await setup(t), original = structuredClone(x.maps.get(x.id)!);
  const shared = await x.air.share(x.id, 'remote-host');
  assert.ok(x.sealed.has(x.id)); assert.deepEqual(x.maps.get(x.id), original);
  await x.mini.sync(); const mirror = x.mini.status().replicas[0];
  assert.equal(mirror.phase, 'mirror'); assert.deepEqual(x.maps.get(mirror.sessionId)!.events, original.events);
  await assert.rejects(x.mini.guard(mirror.sessionId), /closed/);
  const active = await x.mini.open('remote-host', shared.sharedId, true); await x.mini.guard(active.sessionId);
  await assert.rejects(x.air.open('remote-host', shared.sharedId, true), /handoff/);
  const continued = x.maps.get(active.sessionId)!;
  continued.events.push({ type: 'session/title', seq: continued.events.length, time: 2, data: { title: 'Continued on Mini', source: { kind: 'user' }, messageSeqs: [] } });
  continued.title = 'Continued on Mini';
  await x.mini.checkpoint(active.sessionId);
  const append = x.calls.find(c => c.action === 'append')!;
  assert.equal((append.events as unknown[]).length, 1); assert.equal(append.offset, original.events.length);
  const before = x.calls.filter(c => c.action === 'append').length; await x.mini.checkpoint(active.sessionId);
  assert.equal(x.calls.filter(c => c.action === 'append').length, before, 'unchanged checkpoint is deduplicated');
  await x.mini.handoff(active.sessionId); await assert.rejects(x.mini.guard(active.sessionId), /closed/);
  const returned = await x.air.open('remote-host', shared.sharedId, true);
  assert.notEqual(returned.sessionId, x.id); assert.notEqual(returned.sessionId, active.sessionId);
  assert.equal(x.maps.get(returned.sessionId)!.events.at(-1)!.data.title, 'Continued on Mini');
  assert.deepEqual(x.maps.get(x.id), original, 'return trip never overwrites original native logs');
});

test('simultaneous claim uses a remote atomic CAS; loser retains a recoverable journal', async t => {
  const x = await setup(t), shared = await x.air.share(x.id, 'remote-host');
  const results = await Promise.allSettled([x.air.open('remote-host', shared.sharedId, true), x.mini.open('remote-host', shared.sharedId, true)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const loser = results[0].status === 'rejected' ? x.air : x.mini;
  const failed = loser.status().replicas.find(r => r.phase === 'importing')!;
  assert.ok(failed.pending); await loser.recover(failed.sessionId);
  assert.equal(loser.replica(failed.sessionId)?.phase, 'sealed'); assert.equal(loser.replica(failed.sessionId)?.token, undefined);
});

test('offline attempts fail closed, claimed messages survive restart, pending remote commits deduplicate', async t => {
  const x = await setup(t), shared = await x.air.share(x.id, 'remote-host'), active = await x.mini.open('remote-host', shared.sharedId, true);
  x.offline(true); await assert.rejects(x.mini.guard(active.sessionId), /offline/);
  const input = createUserMessage({ content: [{ type: 'text', text: 'Do not lose this claimed input' }], source: { kind: 'user' } });
  x.mini.rejected(active.sessionId, [input]); x.mini.rejected(active.sessionId, [input]);
  const restarted = x.machine('instance-mini'); assert.deepEqual(restarted.recoveryInput(active.sessionId), [input]);
  await assert.rejects(restarted.guard(active.sessionId), /closed/);
  x.offline(false); await restarted.recover(active.sessionId);
  assert.equal((await x.air.list('remote-host'))[0].owner, null);
  const next = await x.air.open('remote-host', shared.sharedId, true);
  const snapshot = x.maps.get(next.sessionId)!; snapshot.title = 'A durable checkpoint';
  x.lost(); await assert.rejects(x.air.checkpoint(next.sessionId), /reply lost/);
  // Lost read response writes nothing; now lose an append response specifically.
  const base = x.rpc.call.bind(x.rpc); let loseAppend = true;
  x.rpc.call = async (host, request) => { const value = await base(host, request); if (request.action === 'append' && loseAppend) { loseAppend = false; throw new Error('lost append reply'); } return value; };
  await assert.rejects(x.air.checkpoint(next.sessionId), /lost append reply/);
  const pending = x.air.replica(next.sessionId)!.pending!;
  assert.equal(pending.action, 'append'); await x.air.guard(next.sessionId);
  assert.equal(x.air.replica(next.sessionId)!.pending, undefined);
  const remote = (await x.air.list('remote-host'))[0]; assert.equal(remote.title, 'A durable checkpoint');
});

test('busy, queued, unsupported attachments, old format, unknown events and missing model refuse before import', async t => {
  const x = await setup(t); x.busy.add(x.id); await assert.rejects(x.air.share(x.id, 'remote-host'), /busy/); assert.equal(x.air.status().replicas.length, 0); x.busy.clear();
  const snapshot = conversation();
  for (const mutate of [
    (s: any) => { s.header.version = 5; },
    (s: any) => { s.events.push({ type: 'future/required', seq: s.events.length, time: 1, data: {} }); },
    (s: any) => { s.events.push({ type: 'goal/change', seq: s.events.length, time: 1, data: {} }); },
    (s: any) => { s.events[2].data.content.push({ type: 'image', attachment: {} }); },
    (s: any) => { s.events.push({ type: 'agent/inbox/spliced', seq: s.events.length, time: 1, data: { target: 'next-turn', start: 0, inserted: [{ content: [], role: 'user', source: { kind: 'user' }, id: randomUUID() }] } }); },
    (s: any) => { s.events.push({ type: 'approval/asked', seq: s.events.length, time: 1, data: { id: 'approval', toolName: 'Bash' } }); },
  ]) { const bad = structuredClone(snapshot); mutate(bad); assert.throws(() => validateNative(bad)); }
  const shared = await x.air.share(x.id, 'remote-host'); x.unavailable();
  await assert.rejects(x.mini.open('remote-host', shared.sharedId, true), /model unavailable/);
  assert.equal(x.counts().imports, 0); assert.equal((await x.air.list('remote-host'))[0].owner, null);
});

test('file attachments validate exact content, names and bounds across compacted raw history', () => {
  const snapshot = conversation(), data = Buffer.from('exact native file bytes'), id = createHash('sha256').update(data).digest('hex');
  const ref = { attachmentId: `sha256:${id}`, name: 'fixture.txt', bytes: data.length };
  snapshot.events[2].data.content.push({ type: 'file', attachment: ref }); snapshot.files.push({ ref, data: data.toString('base64') });
  assert.deepEqual(fileRefs(snapshot.events), [ref]); validateNative(snapshot);
  const corrupted = structuredClone(snapshot); corrupted.files[0].data = Buffer.from('bad').toString('base64'); assert.throws(() => validateNative(corrupted), /integrity/);
  const traversal = structuredClone(snapshot); traversal.files[0].ref.name = '../private'; assert.throws(() => validateNative(traversal), /unsafe/);
  const missing = structuredClone(snapshot); missing.files = []; assert.throws(() => validateNative(missing), /missing/);
  const oversized = structuredClone(snapshot); oversized.files[0].data = 'A'.repeat(3 * 1024 * 1024); assert.throws(() => validateNative(oversized), /transfer limit/);
});

test('disable refuses owned copies; archive and withdraw stop imports and preserve local originals', async t => {
  const x = await setup(t), shared = await x.air.share(x.id, 'remote-host'), active = await x.mini.open('remote-host', shared.sharedId, true);
  await assert.rejects(x.mini.configure('remote-host', false), /Handoff/);
  await x.mini.handoff(active.sessionId, 'withdraw');
  const record = JSON.parse(await readFile(join(x.registry, `${shared.sharedId}.json`), 'utf8'));
  assert.equal(record.deleted, true); assert.deepEqual(record.snapshot.events, []); assert.deepEqual(record.snapshot.files, []);
  await assert.rejects(x.air.open('remote-host', shared.sharedId, true), /deleted/);
  await x.mini.configure('remote-host', false); await assert.rejects(x.mini.list('remote-host'), /Enable/);
  assert.ok(x.maps.has(x.id)); assert.ok(x.maps.has(active.sessionId));
});

test('restart refuses ordinary checkpoint/handoff, explicitly recovers only acknowledged history, and never publishes CLOSED', async t => {
  const x = await setup(t), shared = await x.air.share(x.id, 'remote-host'), active = await x.mini.open('remote-host', shared.sharedId, true);
  const before = JSON.parse(await readFile(join(x.registry, `${shared.sharedId}.json`), 'utf8'));
  const local = x.maps.get(active.sessionId)!;
  local.events.push({type:'model/selection',seq:local.events.length,time:3,data:{provider:'shared-native-closed',model:'closed by unload'}});
  await assert.rejects(x.mini.checkpoint(active.sessionId), /closed-route markers/);
  local.events.push({type:'model/selection',seq:local.events.length,time:4,data:{provider:'normal',model:'native-model'}});
  await assert.rejects(x.mini.checkpoint(active.sessionId), /closed-route markers cannot enter a managed checkpoint/);
  const restarted = x.machine('instance-mini');
  await assert.rejects(restarted.checkpoint(active.sessionId), /unreviewed local tail/);
  await assert.rejects(restarted.handoff(active.sessionId), /unreviewed local tail/);
  const unchanged = JSON.parse(await readFile(join(x.registry, `${shared.sharedId}.json`), 'utf8'));
  assert.deepEqual(unchanged, before);
  await restarted.recover(active.sessionId);
  const after = JSON.parse(await readFile(join(x.registry, `${shared.sharedId}.json`), 'utf8'));
  assert.deepEqual(after.snapshot, before.snapshot); assert.equal(after.owner, null);
  const returned = await x.air.open('remote-host', shared.sharedId, true);
  validateNative(x.maps.get(returned.sessionId)!); assert.ok(x.maps.get(active.sessionId)!.events.some(e=>e.data.provider==='shared-native-closed'));
});

test('failed enrollment cancellation fences late create, restores only after acknowledgement, and refuses claimed enrollments', async t => {
  const x=await setup(t), original=x.rpc.call.bind(x.rpc); let rejectCreate=true;
  x.rpc.call=async(host,request)=>{ if(request.action==='create' && rejectCreate) throw Error('deterministic transfer size refusal'); return original(host,request); };
  await assert.rejects(x.air.share(x.id,'remote-host'),/size refusal/);
  const failed=x.air.replica(x.id)!, late=structuredClone(failed.pending!);
  assert.ok(x.sealed.has(x.id)); x.offline(true);
  await assert.rejects(x.air.cancelEnrollment(x.id),/offline/); assert.ok(x.air.replica(x.id)); assert.ok(x.sealed.has(x.id));
  x.offline(false); await x.air.cancelEnrollment(x.id); assert.equal(x.air.replica(x.id),undefined); assert.ok(!x.sealed.has(x.id));
  rejectCreate=false; await assert.rejects(original('remote-host',{protocol:'shared-native-v1',instance:'instance-air',...late}),/create conflict/);
  // Lost create reply: an unclaimed record is safely tombstoned; a claimed one must stay closed.
  const id2=randomUUID(); x.maps.set(id2,conversation()); let lose=true;
  x.rpc.call=async(host,request)=>{const result=await original(host,request); if(request.action==='create'&&lose){lose=false;throw Error('lost create reply');}return result;};
  await assert.rejects(x.air.share(id2,'remote-host'),/lost create reply/);
  const pending=x.air.replica(id2)!; await x.mini.open('remote-host',pending.sharedId,true);
  await assert.rejects(x.air.cancelEnrollment(id2),/cancellation is unsafe/); assert.ok(x.sealed.has(id2)); assert.ok(x.air.replica(id2));
  await x.air.reconcileEnrollment(id2); assert.equal(x.air.replica(id2)!.pending,undefined);assert.ok(x.sealed.has(id2));assert.ok(x.air.replica(id2)!.version>1);
});

test('automatic sync imports a cold view only once; changed checkpoints refresh on explicit open', async t => {
  const x=await setup(t), shared=await x.air.share(x.id,'remote-host');
  await x.mini.sync(); const count=x.counts(); assert.equal(count.imports,1); assert.equal(count.activations,0);
  const active=await x.air.open('remote-host',shared.sharedId,true);
  for(let i=0;i<4;i++){x.maps.get(active.sessionId)!.title=`round ${i}`;await x.air.checkpoint(active.sessionId);await x.mini.sync();}
  assert.equal(x.counts().imports,2,'one mirror and one explicit owning continuation; no per-turn mirrors');
  assert.equal(x.counts().activations,1,'only the writer activates');
  const view=await x.mini.open('remote-host',shared.sharedId,false);
  assert.equal(x.maps.get(view.sessionId)!.title,'round 3'); assert.equal(x.archived.size,1);
});

test('ownership checks return metadata only, install scripts once, and diagnose crashed locks without stealing', async t => {
  const x=await setup(t), shared=await x.air.share(x.id,'remote-host'), active=await x.mini.open('remote-host',shared.sharedId,true);
  const r=x.mini.replica(active.sessionId)!;
  const check=await x.rpc.call('remote-host',{protocol:'shared-native-v1',instance:'instance-mini',action:'check',id:r.sharedId,version:r.version,digest:r.digest,token:r.token,op:randomUUID()});
  assert.equal(check.snapshot,undefined); assert.ok(JSON.stringify(check).length<1024);
  let installs=0,transfers=0;
  const transport={exec:async()=>{installs++;return 'ready';},start:()=>{throw Error('not used');},transfer:async()=>{transfers++;return Buffer.from('{"result":{"version":1}}');}};
  await nativeRpc(transport,{action:'check'});await nativeRpc(transport,{action:'check'});assert.equal(installs,1);assert.equal(transfers,2);
  const lock=join(x.registry,`${r.sharedId}.lock`);await writeFile(lock,'99999999');
  const diagnostic=await x.mini.diagnoseLock('remote-host',r.sharedId) as any;
  assert.equal(diagnostic.locked,true);assert.equal(diagnostic.processAlive,'no');assert.equal(diagnostic.automaticRemoval,false);
  await assert.rejects(x.mini.guard(active.sessionId),/no automatic lock stealing/);assert.equal(await readFile(lock,'utf8'),'99999999');
});

test('malformed images and path-backed input are refused while exact file input is bounded',()=>{
  assert.throws(()=>validateNativeInput([{type:'image',attachment:{}}]),/path-backed/);
  assert.throws(()=>validateNativeInput([{type:'file',path:'../source'}]),/path-backed/);
  assert.throws(()=>validateNativeInput([{type:'file',attachment:{attachmentId:'sha256:'+'a'.repeat(64),name:'large',bytes:3*1024*1024}}]),/limits/);
});

for (const action of ['release','archive','withdraw','delete'] as const) test(`${action}: lost committed response recovers once, retires token, and permits host disable`,async t=>{
  const x=await setup(t), shared=await x.air.share(x.id,'remote-host'), active=await x.mini.open('remote-host',shared.sharedId,true);
  const original=x.rpc.call.bind(x.rpc);let lose=true;
  x.rpc.call=async(host,request)=>{const result=await original(host,request);if(request.action===action&&lose){lose=false;throw Error(`lost committed ${action} response`);}return result;};
  await assert.rejects(x.mini.handoff(active.sessionId,action),/lost committed/);
  const pending=structuredClone(x.mini.replica(active.sessionId)!.pending!);
  assert.equal(pending.action,action);assert.ok(x.mini.replica(active.sessionId)!.token);
  if(action==='release') await x.air.open('remote-host',shared.sharedId,true); // Receipt may now describe another owner.
  const recovered=x.machine('instance-mini');await recovered.recover(active.sessionId);await recovered.recover(active.sessionId);
  const replica=recovered.replica(active.sessionId)!;
  assert.equal(replica.token,undefined);assert.equal(replica.pending,undefined);assert.equal(replica.phase,'sealed');
  const requests=x.calls.filter(request=>request.instance==='instance-mini'&&['release','archive','withdraw','delete'].includes(String(request.action)));
  assert.equal(requests.length,2,'one original attempt and one receipt replay, never a second release');
  assert.ok(requests.every(request=>request.op===pending.op));
  await recovered.configure('remote-host',false);assert.equal(recovered.status().enabled,false);
});

test('cancel -> native unseal -> share accepts superseded CLOSED history',async t=>{
  const x=await setup(t), normal={provider:'normal',model:'native-model'};
  x.host.seal=async id=>{x.sealed.add(id);const s=x.maps.get(id)!;s.events.push({type:'model/selection',seq:s.events.length,time:5,data:{provider:'shared-native-closed',model:'closed'}});};
  x.host.unseal=async(id,selection)=>{x.sealed.delete(id);const s=x.maps.get(id)!;s.events.push({type:'model/selection',seq:s.events.length,time:6,data:selection});};
  const original=x.rpc.call.bind(x.rpc);let fail=true;
  x.rpc.call=async(host,request)=>{if(request.action==='create'&&fail){fail=false;throw Error('create refused');}return original(host,request);};
  await assert.rejects(x.air.share(x.id,'remote-host'),/create refused/);await x.air.cancelEnrollment(x.id);
  assert.deepEqual(nativeSelection(x.maps.get(x.id)!.events),normal);validateNative(x.maps.get(x.id)!);
  const shared=await x.air.share(x.id,'remote-host'), active=await x.mini.open('remote-host',shared.sharedId,true);
  assert.deepEqual(nativeSelection(x.maps.get(active.sessionId)!.events),normal);await x.mini.guard(active.sessionId);
});

test('closed native copy -> private fork -> explicit ordinary selection -> share preserves branch metadata',async t=>{
  const x=await setup(t), source=conversation();source.events.push({type:'model/selection',seq:source.events.length,time:3,data:{provider:'shared-native-closed',model:'closed'}});
  const id=SessionId(randomUUID()), seed=buildForkSeed(source.events as never,source.events.at(-1)!.seq as never);
  const fork=Session.create(id,seed,{...source.header,id,parentSession:source.header.id,isSeeded:true},source.events.length as never);
  (fork as any).append('model/selection',{provider:'normal',model:'native-model'});
  x.maps.set(id,{...source,header:fork.header,inheritedEventCount:source.events.length,events:[...fork.snapshotEvents()]});
  const shared=await x.air.share(id,'remote-host'), active=await x.mini.open('remote-host',shared.sharedId,true), copy=x.maps.get(active.sessionId)!;
  assert.equal(copy.inheritedEventCount,source.events.length);assert.equal(copy.header.parentSession,source.header.id);
  assert.deepEqual(nativeSelection(copy.events),{provider:'normal',model:'native-model'});validateNative(copy);
});

test('a still-pending CLOSED selection is not retired by an unrelated older request header',()=>{
  const s=conversation();s.events.push({type:'model/selection',seq:s.events.length,time:3,data:{provider:'shared-native-closed',model:'closed'}});
  s.events.push({type:'request/header',seq:s.events.length,time:4,data:{header:{config:{provider:'normal',model:'native-model'}},reason:'initial'}});
  assert.equal(nativeSelection(s.events)!.provider,'shared-native-closed');assert.throws(()=>validateNative(s),/closed-route/);
});
