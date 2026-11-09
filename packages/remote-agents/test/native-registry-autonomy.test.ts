import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NATIVE_SCRIPT } from '../src/chat/native-registry.js';
import { NATIVE_LIMIT, nativeDigest } from '../src/chat/native-protocol.js';

import { registryFixture } from './fixtures/native-authority.js';

function packet(id = randomUUID()) {
  return { protocol: 'shared-native-v1', header: { id, version: 4 }, inheritedEventCount: 0, project: '/source/project', title: 'Snapshot', events: [] as any[], files: [] as any[],
    autonomy: { schema: 1, rootId: id, children: [] as any[], queues: [] as any[], schedules: [] as any[], agentAliases: {} } };
}
async function enrolled(t: TestContext) {
  const x = await registryFixture(t), snapshot = packet(), id = snapshot.header.id, token = randomUUID();
  const created = await x.call('create', { id, op: randomUUID(), version: 0, digest: '', snapshot });
  const owned = await x.call('claim', { id, op: randomUUID(), version: created.version, digest: created.digest, token });
  return { ...x, snapshot, id, token, created, owned };
}

test('real authority stores append.autonomy atomically in snapshot digest and returns an original-operation receipt', async t => {
  const x = await enrolled(t), autonomy = { ...x.snapshot.autonomy, children: [{ header: { id: 'child', parentSession: x.id }, events: [{ data: { text: '完整原话🙂'.repeat(30000) } }], files: [{ ref: { attachmentId: 'image-id' }, data: 'image bytes' }] }] };
  const op = randomUUID(), request = { protocol: 'shared-native-v1', instance: 'instance-air', action: 'append', id: x.id, token: x.token, version: x.owned.version, digest: x.owned.digest, op, offset: 0, events: [{ type: 'root/update', data: { raw: 'child unchanged' } }], files: [], title: 'Updated', autonomy };
  const reply = await x.run(request), record = await x.call('get', { id: x.id });
  assert.deepEqual(record.snapshot.autonomy, autonomy); assert.equal(record.digest, nativeDigest(record.snapshot));
  assert.equal(reply.autonomyDigest, nativeDigest(autonomy)); assert.equal(reply.receipt.autonomyDigest, nativeDigest(autonomy));
  assert.equal(reply.receipt.requestDigest, nativeDigest(request)); assert.equal(reply.receipt.version, x.owned.version + 1);
  assert.deepEqual((await x.run(request)).receipt, reply.receipt); assert.equal((await x.call('get', { id: x.id })).snapshot.events.length, 1);
  await assert.rejects(x.run({ ...request, autonomy: { ...autonomy, schedules: [{ id: 'changed' }] } }), /replay payload conflict/);
  await assert.rejects(x.run({ ...request, instance: 'instance-mini' }), /replay payload conflict/);
});

test('autonomy CAS, ownership and immutable canonical root reject stale packets without changing the stored record', async t => {
  const x = await enrolled(t), before = await x.call('get', { id: x.id });
  const base = { id: x.id, token: x.token, version: x.owned.version, digest: x.owned.digest, offset: 0, events: [], files: [], title: 'Update', autonomy: x.snapshot.autonomy };
  for (const patch of [{ version: 1 }, { digest: 'stale' }, { token: randomUUID() }, { autonomy: { ...x.snapshot.autonomy, rootId: randomUUID() } }, { autonomy: null }]) await assert.rejects(x.call('append', { ...base, ...patch, op: randomUUID() }));
  assert.deepEqual(await x.call('get', { id: x.id }), before);
});

test('request and cumulative snapshot payload limits count root events, all children and attachments together', async t => {
  const x = await registryFixture(t), snapshot = packet(), id = snapshot.header.id, token = randomUUID();
  snapshot.events.push({ text: 'r'.repeat(5 * 1024 * 1024) });
  snapshot.autonomy.children.push({ header: { id: 'child', parentSession: id }, events: [], files: [{ data: 'a'.repeat(1024 * 1024) }] });
  const create = await x.call('create', { id, op: randomUUID(), version: 0, snapshot });
  const owned = await x.call('claim', { id, op: randomUUID(), version: create.version, digest: create.digest, token });
  const before = await x.call('get', { id });
  const autonomy = { ...snapshot.autonomy, children: [{ header: { id: 'child', parentSession: id }, events: [], files: [{ data: 'b'.repeat(4 * 1024 * 1024) }] }] };
  const append = { id, op: randomUUID(), version: owned.version, digest: owned.digest, token, offset: 1, events: [{ text: 's'.repeat(5 * 1024 * 1024) }], title: 'Too large combined', autonomy };
  assert.ok(Buffer.byteLength(JSON.stringify(append)) < NATIVE_LIMIT);
  await assert.rejects(x.call('append', append), /total payload limit|exceeds limit/);
  assert.deepEqual(await x.call('get', { id }), before, 'overflow leaves file, digest and CAS version unchanged');
  await assert.rejects(x.call('append', { ...append, events: [{ text: 'x'.repeat(NATIVE_LIMIT + 1) }] }), /request exceeds total payload limit/);
});

test('legacy create/append/replay without autonomy stays compatible; omitted autonomy preserves a newer packet', async t => {
  const x = await registryFixture(t), snapshot: any = packet(); delete snapshot.autonomy;
  const id = snapshot.header.id, token = randomUUID();
  const created = await x.call('create', { id, op: randomUUID(), version: 0, snapshot });
  assert.equal(created.autonomyDigest, undefined);
  const owned = await x.call('claim', { id, op: randomUUID(), version: created.version, digest: created.digest, token });
  const request = { id, op: randomUUID(), version: owned.version, digest: owned.digest, token, offset: 0, events: [{ text: 'Legacy suffix' }], title: 'Legacy' };
  const appended = await x.call('append', request); assert.equal(appended.autonomyDigest, undefined);
  const file = join(x.directory, `${id}.json`), old = JSON.parse(await readFile(file, 'utf8')); delete old.receiptData; await writeFile(file, JSON.stringify(old));
  assert.equal((await x.call('append', request)).version, appended.version);
  const autonomy = packet(id).autonomy;
  const added = await x.call('append', { ...request, op: randomUUID(), version: appended.version, digest: appended.digest, offset: 1, events: [], autonomy });
  await x.call('append', { ...request, op: randomUUID(), version: added.version, digest: added.digest, offset: 1, events: [] });
  assert.deepEqual((await x.call('get', { id })).snapshot.autonomy, autonomy);
});

for (const action of ['withdraw', 'delete']) test(`${action} removes shared descendant logs and attachment payloads as well as root history`, async t => {
  const x = await enrolled(t), changed = { ...x.snapshot.autonomy, children: [{ private: 'retained only in local originals' }] };
  const appended = await x.call('append', { id: x.id, token: x.token, op: randomUUID(), version: x.owned.version, digest: x.owned.digest, offset: 0, events: [], title: 'Shared', autonomy: changed });
  await x.call(action, { id: x.id, token: x.token, op: randomUUID(), version: appended.version, digest: appended.digest });
  const stored = await readFile(join(x.directory, `${x.id}.json`), 'utf8');
  assert.doesNotMatch(stored, /retained only in local originals/); assert.equal(JSON.parse(stored).snapshot.autonomy, undefined);
});
