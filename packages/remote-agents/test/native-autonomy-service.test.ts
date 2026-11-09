import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { join } from 'node:path';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { fixture } from './fakes.js';
import { NativeSharing, type NativeHost } from '../src/chat/native-service.js';
import { nativeDigest, type NativeSnapshot } from '../src/chat/native-protocol.js';
import { remapNativeAutonomy, type NativeAutonomyBundle, type NativeAutonomyHost } from '../src/chat/native-autonomy.js';
import { createHandler } from '../src/http.js';
const request = (body: unknown) => new Request('http://test/api', { method: 'POST', headers: { 'content-type': 'application/json', 'X-DSH-Remote-Agents': '1' }, body: JSON.stringify(body) });
async function setup(t: TestContext) {
  const f = await fixture(t), session = Session.create(SessionId('original-root'));
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'History with pending autonomy' }], source: { kind: 'user' } }), { surfaceOp: 'append' });
  session.append('request/header', { header: { config: { provider: 'normal', model: 'configured' } }, reason: 'initial' } as never);
  const root: NativeSnapshot = { protocol: 'shared-native-v1', header: session.header, inheritedEventCount: 0, project: '/srv/project', title: 'Autonomy', events: [...session.snapshotEvents()], files: [] };
  const bundle: NativeAutonomyBundle = { schema: 1, rootId: 'original-root', children: [], schedules: [], queues: [{ sessionId: 'original-root', target: 'next-turn', messages: [{ id: 'pending-1', content: [{ type: 'text', text: 'parked exact input' }] }] }] };
  const snapshots = new Map<string, NativeSnapshot>([['original-root', root]]);
  let record: any, claims = 0, freezes = 0, imports = 0, deliveries = 0, preflightFailure = false, persistAppend = true;
  const capture = (id: string) => remapNativeAutonomy(bundle, { 'original-root': id });
  const autonomy: NativeAutonomyHost = { capture: async id => capture(id), freeze: async id => { freezes++; return { snapshot: structuredClone(snapshots.get(id)!), bundle: capture(id) }; }, preflight: async () => { if (preflightFailure) throw Error('child model unavailable'); }, importParked: async () => { imports++; }, deliver: async () => { deliveries++; } };
  const host: NativeHost = { autonomy, available: () => true, placement: async () => '/srv/project', snapshot: async id => structuredClone(snapshots.get(id)!), idle: async (_id, run) => run(), validate: async () => {}, import: async (id, _host, snapshot) => { snapshots.set(id, { ...structuredClone(snapshot), header: { ...snapshot.header, id: id as never } }); }, activate: async () => {}, seal: async () => {} };
  const native = new NativeSharing(join(f.directory, 'autonomy-service.json'), 'instance', { call: async (_host, data) => {
    switch (data.action) {
      case 'create': record = { id: data.id, version: 1, digest: nativeDigest(data.snapshot), snapshot: structuredClone(data.snapshot), owner: null }; break;
      case 'get': return structuredClone(record);
      case 'list': return [];
      case 'claim': claims++; record.owner = 'instance'; record.token = data.token; record.version++; break;
      case 'check': return {};
      case 'append': if (persistAppend && data.autonomy) record.snapshot.autonomy = data.autonomy; record.snapshot.title = data.title; record.snapshot.events.push(...data.events as any[]); record.version++; break;
      case 'release': record.owner = null; record.version++; break;
      default: throw Error(`unexpected ${data.action}`);
    }
    record.digest = nativeDigest(record.snapshot); return structuredClone(record);
  } }, host);
  await native.configure(f.hostId, true); t.after(() => native.close());
  const handler = createHandler(f.service, undefined, undefined, undefined, undefined, undefined, undefined, native);
  return { ...f, root, bundle, native, host, snapshots, handler, counts: () => ({ claims, freezes, imports, deliveries }), preflightFailure: () => { preflightFailure = true; }, dropAutonomy: () => { persistAppend = false; }, record: () => record };
}

test('service freezes source, imports parked with no delivery, and HTTP requires explicit root-owner resume confirmation', async t => {
  const x = await setup(t), shared = await x.native.share('original-root', x.hostId);
  assert.equal(x.counts().freezes, 1); assert.equal(x.record().snapshot.autonomy.queues[0].messages[0].id, 'pending-1');
  const active = await x.native.open(x.hostId, shared.sharedId, true); assert.equal(x.counts().imports, 1); assert.equal(x.counts().deliveries, 0);
  assert.equal((await x.handler(request({ action: 'nativeResumeAutonomy', sessionId: active.sessionId, queues: true }))).status, 400);
  assert.equal((await x.handler(request({ action: 'nativeResumeAutonomy', sessionId: active.sessionId, queues: true, confirmed: true }))).status, 200);
  await x.native.resumeAutonomy(active.sessionId, { queues: true }); assert.equal(x.counts().deliveries, 1);
  await assert.rejects(x.native.resumeAutonomy('original-root', { queues: true }), /owning root/);
});

test('receiver dependency preflight fails before claim and leaves remote owner unclaimed', async t => {
  const x = await setup(t), shared = await x.native.share('original-root', x.hostId); x.preflightFailure();
  await assert.rejects(x.native.open(x.hostId, shared.sharedId, true), /child model unavailable/);
  assert.equal(x.counts().claims, 0); assert.equal(x.counts().imports, 0); assert.equal(x.record().owner, null);
});

test('child aliases inherit root writer guard; sealed/restarted root fences all descendants', async t => {
  const x = await setup(t), shared = await x.native.share('original-root', x.hostId), active = await x.native.open(x.hostId, shared.sharedId, true);
  x.native.enrollDescendant(active.sessionId, 'new-child');
  assert.equal(x.native.autonomyOwner('new-child')?.rootSessionId, active.sessionId);
  await x.native.guard('new-child');
  x.native.enrollDescendant('original-root', 'source-child');
  await assert.rejects(x.native.guard('source-child'), /closed for writing/);
  x.native.activated.delete(active.sessionId); await assert.rejects(x.native.guard(active.sessionId), /closed for writing/);
  await assert.rejects(x.native.guard('new-child'), /closed for writing/);
});

test('checkpoint cannot hand off when authority drops append.autonomy; pending input stays durable', async t => {
  const x = await setup(t), shared = await x.native.share('original-root', x.hostId), active = await x.native.open(x.hostId, shared.sharedId, true);
  x.bundle.queues[0].messages.push({ id: 'pending-2', content: [] }); x.dropAutonomy();
  await assert.rejects(x.native.handoff(active.sessionId), /persist append.autonomy/);
  assert.equal(x.record().owner, 'instance'); assert.equal(x.native.autonomy.plan(active.sessionId)?.bundle.queues[0].messages[0].id, 'pending-1');
});
