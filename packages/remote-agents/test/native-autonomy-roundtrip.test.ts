import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { join } from 'node:path';
import { NativeAutonomyJournal, canonicalNativeStructure, nativeCheckpointEvents, nativeAutonomyAgentId, remapNativeAutonomy, remapNativeStructure, validateNativeAutonomy, type NativeAutonomyBundle, type NativeAutonomySnapshot } from '../src/chat/native-autonomy.js';
import type { NativeSnapshot } from '../src/chat/native-protocol.js';
import { nativeDigest } from '../src/chat/native-protocol.js';
import { registryFixture } from './fixtures/native-authority.js';
function append(s: NativeSnapshot, type: string, data: any) { s.events.push({ type, data: structuredClone(data), seq: s.events.length, time: s.events.length + 1 }); }
function seed(id: string): NativeSnapshot { return { protocol: 'shared-native-v1', header: { id, version: 4, createdAt: 1, cwd: '/source/project', isSeeded: false, delegationDepth: 0 } as never, inheritedEventCount: 0, project: '/source/project', title: 'Tree', events: [], files: [] }; }
let createdAt = 2;
function grow(root: NativeSnapshot, bundle: NativeAutonomyBundle, parentId: string, id: string) {
  const parent = root.header.id === parentId ? root : bundle.children.find(c => c.header.id === parentId)!;
  const child = seed(id); child.header = { ...child.header, parentSession: parentId as never, origin: 'subagent', createdAt: createdAt++ as never, delegationDepth: (parent.header.delegationDepth ?? 0) + 1 };
  append(child, 'subagent/descriptor', { version: 3, mode: 'continuable', provider: 'native', agentProvider: 'normal', agentModel: 'configured', label: id, persona: `Literal ${parentId} must remain unchanged`, toolFilter: { allow: ['Read'] } });
  append(child, 'user/message', { content: [{ type: 'text', text: `Code/string ${id} ${parentId}` }], meta: { opaqueId: id } });
  const bytes = Buffer.from(`file of ${id}`), ref = { attachmentId: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, name: 'fixture.txt', bytes: bytes.length };
  child.files = [{ ref, data: bytes.toString('base64') }];
  append(child, 'user/message', { content: [{ type: 'file', attachment: ref }] });
  append(parent, 'subagent/catalog', { version: 0, childId: id, childCreatedAt: child.header.createdAt, mode: 'continuable', label: id });
  bundle.children.push(child); return child;
}

test('Air→Mini→Air canonical checkpoints preserve old and new child prefixes, immutable metadata, attachments and transitive aliases', async t => {
  const authority = await registryFixture(t), sharedId = randomUUID(), airSource = randomUUID();
  const root = seed(airSource), bundle: NativeAutonomyBundle = { schema: 1, rootId: airSource, children: [], queues: [], schedules: [] };
  append(root, 'user/message', { content: [{ type: 'text', text: `Original ${airSource} is code, not an alias substitution site` }], meta: { session: airSource } });
  const sourceChild = grow(root, bundle, airSource, randomUUID()), sourceExtra = grow(root, bundle, airSource, randomUUID());
  append(sourceExtra, 'assistant/message', { raw: `Keep ${sourceChild.header.id} verbatim` });
  const wire: NativeAutonomySnapshot = { ...remapNativeStructure(root, { [airSource]: sharedId }), autonomy: remapNativeAutonomy(bundle, { [airSource]: sharedId }) };
  validateNativeAutonomy(wire, wire.autonomy!);
  await authority.call('create', { id: sharedId, version: 0, op: randomUUID(), snapshot: wire });
  const receive = async (name: string) => {
    const record = await authority.call('get', { id: sharedId }), localId = randomUUID(), journal = new NativeAutonomyJournal(join(authority.root, `${name}.json`));
    const plan = journal.stage(localId, record.snapshot.autonomy), token = randomUUID();
    await authority.call('claim', { id: sharedId, token, op: randomUUID(), version: record.version, digest: record.digest });
    const local = remapNativeStructure(record.snapshot, plan.ids) as NativeAutonomySnapshot;
    local.autonomy = remapNativeAutonomy(record.snapshot.autonomy, plan.ids);
    return { local, localId, journal, token };
  };
  const publish = async (copy: Awaited<ReturnType<typeof receive>>, loseReply = false) => {
    const previous = await authority.call('get', { id: sharedId });
    const plan = copy.journal.prepareExport(copy.localId, previous.snapshot.header.id, copy.local.autonomy!);
    const canonical = canonicalNativeStructure(copy.local, plan) as NativeAutonomySnapshot;
    canonical.autonomy = copy.journal.exportBundle(copy.localId, copy.local.autonomy!);
    assert.equal(canonical.header.id, sharedId); assert.equal(canonical.autonomy.rootId, sharedId);
    validateNativeAutonomy(canonical, canonical.autonomy);
    const events = nativeCheckpointEvents(canonical, previous.snapshot);
    const request = { protocol: 'shared-native-v1', instance: 'instance-air', action: 'append', id: sharedId, token: copy.token, op: randomUUID(), version: previous.version, digest: previous.digest,
      offset: previous.snapshot.events.length, events, files: [], title: canonical.title, autonomy: canonical.autonomy };
    const acknowledged = await authority.run(request);
    if (loseReply) {
      const retry = await authority.run(JSON.parse(JSON.stringify(request)));
      assert.deepEqual(retry.receipt, acknowledged.receipt);
      assert.equal(retry.version, acknowledged.version);
    }
    const stored = await authority.call('get', { id: sharedId });
    assert.equal(stored.digest, nativeDigest(stored.snapshot)); assert.deepEqual(stored.snapshot.autonomy, canonical.autonomy);
    assert.deepEqual(nativeCheckpointEvents(canonical, stored.snapshot), []);
    return stored;
  };
  const release = async (copy: Awaited<ReturnType<typeof receive>>) => {
    const r = await authority.call('get', { id: sharedId }); await authority.call('release', { id: sharedId, token: copy.token, op: randomUUID(), version: r.version, digest: r.digest });
  };
  const mini = await receive('mini'), miniPlan = mini.journal.plan(mini.localId)!;
  append(mini.local, 'user/message', { content: [{ type: 'text', text: `Mini root suffix ${mini.localId}` }] });
  append(mini.local.autonomy!.children[0], 'assistant/message', { raw: `Source child now continued on ${mini.localId}` });
  const miniChildId = randomUUID(), miniChild = grow(mini.local, mini.local.autonomy!, miniPlan.ids[sourceChild.header.id], miniChildId);
  const miniDirect = grow(mini.local, mini.local.autonomy!, mini.localId, randomUUID());
  await publish(mini, true);
  append(miniChild, 'assistant/message', { raw: 'Another child suffix' }); append(mini.local, 'session/title', { title: 'Mini second checkpoint' });
  await publish(mini); await release(mini);
  const air = await receive('air-return'), airPlan = air.journal.plan(air.localId)!;
  assert.equal(nativeAutonomyAgentId(airPlan, airSource), air.localId); assert.equal(nativeAutonomyAgentId(airPlan, mini.localId), air.localId);
  assert.equal(nativeAutonomyAgentId(airPlan, miniPlan.ids[sourceChild.header.id]), airPlan.ids[sourceChild.header.id]);
  const miniCanonical = mini.journal.plan(mini.localId)!;
  const miniChildCanonical = Object.entries(miniCanonical.ids).find(([, local]) => local === miniChildId)![0];
  append(air.local, 'assistant/message', { raw: `Air root suffix ${air.localId}` });
  const airNew = grow(air.local, air.local.autonomy!, airPlan.ids[miniChildCanonical], randomUUID());
  grow(air.local, air.local.autonomy!, air.localId, randomUUID());
  const oldText = structuredClone(air.local.events[0]);
  await publish(air, true); append(airNew, 'assistant/message', { raw: `New Air child talks about ${miniChildId}` });
  await publish(air); await release(air);
  const miniAgain = await receive('mini-second'), latest = await authority.call('get', { id: sharedId });
  const aliases = miniAgain.journal.plan(miniAgain.localId)!;
  assert.equal(nativeAutonomyAgentId(aliases, airSource), miniAgain.localId);
  assert.equal(nativeAutonomyAgentId(aliases, mini.localId), miniAgain.localId);
  assert.equal(nativeAutonomyAgentId(aliases, air.localId), miniAgain.localId);
  assert.equal(nativeAutonomyAgentId(aliases, miniChildId), aliases.ids[miniChildCanonical]);
  assert.deepEqual(latest.snapshot.events[0], oldText); assert.deepEqual(latest.snapshot.events[0], root.events[0]);
  const initial = latest.snapshot.autonomy.children.find((c: NativeSnapshot) => c.header.id === sourceChild.header.id);
  assert.deepEqual(initial.events.slice(0, sourceChild.events.length), sourceChild.events); assert.deepEqual(initial.files, sourceChild.files);
  assert.equal(latest.snapshot.autonomy.children.length, 6);
  assert.equal(miniDirect.header.origin, 'subagent');
  await publish(miniAgain); // A third host-local identity still matches the exact canonical prefixes.
});
