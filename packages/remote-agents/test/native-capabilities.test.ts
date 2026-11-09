import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { fileRefs, validateNative, validateNativeInput, nativeDigest, NATIVE_CLOSED_PROVIDER, type NativeSnapshot } from '../src/chat/native-protocol.js';
import { exportNativeAttachments, importNativeAttachments } from '../src/chat/native-attachments.js';

const bytes = Buffer.from('isolated encoded image placeholder');
const image = { attachmentId: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, mediaType: 'image/png', bytes: bytes.length, width: 1, height: 1 };
function snapshot(): NativeSnapshot {
  const id = SessionId(randomUUID());
  const session = Session.create(id, [], { version: 4, id, createdAt: 1, cwd: '/isolated/project', isSeeded: false, delegationDepth: 0 } as never);
  session.append('user/message', createUserMessage({ content: [{ type: 'image', attachment: image } as never], source: { kind: 'user' } }) as never, { surfaceOp: 'append' });
  (session as any).append('model/selection', { provider: 'normal', model: 'model' } as never);
  return { protocol: 'shared-native-v1', header: session.header, inheritedEventCount: 0, events: structuredClone([...session.snapshotEvents()]), files: [{ ref: image, data: bytes.toString('base64') }], project: '/isolated/project', title: 'Image fixture' };
}

test('image refs in user/tool/compaction raw history deduplicate without losing metadata', () => {
  const input = [{role:'user',content:[{ type: 'image', attachment: image }]}, {type:'tool/result',data:{message:{role:'tool',content:[{ type: 'image', attachment: { ...image, originalDimensions: { width: 2, height: 2 }, name: 'result.png' } }]},meta:{type:'resource',spillPath:'/must-not-read',attachmentId:'opaque'}}}, {type:'assistant/attempt',data:{stream:[{type:'chunk',chunk:{type:'block-end',block:{type:'image',attachment:image}}}]}}];
  const refs = fileRefs(input);
  assert.equal(refs.length, 2); assert.deepEqual(refs[1].originalDimensions, { width: 2, height: 2 });
  validateNativeInput(input); validateNative(snapshot());
});

test('image validation rejects corruption, missing objects, unsafe names and resource paths', () => {
  const valid = snapshot();
  for (const change of [
    (s: NativeSnapshot) => { s.files[0].data = Buffer.from('corrupt').toString('base64'); },
    (s: NativeSnapshot) => { s.files = []; },
    (s: NativeSnapshot) => { s.files[0].ref.name = '../escape'; },
    (s: NativeSnapshot) => { s.files[0].ref.width = 0; },
  ]) { const s = structuredClone(valid); change(s); assert.throws(() => validateNative(s)); }
  assert.throws(() => validateNativeInput([{ type: 'image', url: '/private/source.png' }]), /path-backed/);
  assert.throws(() => validateNativeInput([{ type: 'image_url', url: 'https://example.test/image' }]), /artifact adapter/);
  assert.throws(() => validateNativeInput([{ type: 'image', attachment: { ...image, bytes: 4 * 1024 * 1024 + 1 } }]), /limits/);
});

test('effective CLOSED is refused while explicitly reselected historical CLOSED stays portable', () => {
  const s = snapshot();
  const push = (provider: string) => s.events.push({ seq: s.events.length, type: 'model/selection', time: 1, data: { provider, model: 'model' } });
  push(NATIVE_CLOSED_PROVIDER); assert.throws(() => validateNative(s), /closed-route/);
  push('normal'); validateNative(s);
});

test('image offload decisions replay without dropping original image objects and reject invalid targets', () => {
  const s = snapshot();
  const imageSeq = s.events.find(e => e.type === 'user/message')!.seq, modelSeq = s.events.find(e => e.type === 'model/selection')!.seq;
  s.events.push({ type: 'image/offload', seq: s.events.length, time: 1, data: { targets: [{ seq: imageSeq, imageIndexes: [0] }] } });
  validateNative(s); assert.equal(fileRefs(s.events).length, 1); assert.equal(s.files.length, 1);
  for (const target of [{ seq: imageSeq, imageIndexes: [1] }, { seq: imageSeq, imageIndexes: [0, 0] }, { seq: modelSeq, imageIndexes: [0] }]) {
    const bad = structuredClone(s); bad.events.at(-1)!.data.targets = [target]; assert.throws(() => validateNative(bad), /image\/offload/);
  }
});

test('bounded AttachmentStore export validates source integrity and byte caps', async () => {
  const store = { readImage: async () => ({ data: bytes }) };
  const files = await exportNativeAttachments(store, [{ type: 'image', attachment: image }]);
  assert.deepEqual(files[0].ref, { attachmentId: image.attachmentId, bytes: image.bytes, mediaType: image.mediaType, width: 1, height: 1 });
  await assert.rejects(exportNativeAttachments({ readImage: async () => ({ data: Buffer.from('bad') }) }, { type:'image', attachment: image }), /integrity/);
  await assert.rejects(exportNativeAttachments(store, { type:'image', attachment: { ...image, bytes: 5 * 1024 * 1024 } }), /limits/);
});

test('lossless image import refuses unknown backends rather than silently reencoding IDs', async () => {
  let saves = 0;
  const store = { saveImage: async () => { saves++; } };
  await assert.rejects(importNativeAttachments(store, snapshot().files, async () => ({ LocalAttachmentStore: class {} })), /Lossless image import/);
  assert.equal(saves, 0);
});

test('file transfer still uses native verbatim saveFile and preserves reference identity', async () => {
  const ref = { attachmentId: image.attachmentId, name: 'file.txt', bytes: bytes.length };
  let saves = 0;
  await importNativeAttachments({ saveFile: async (input: any) => { saves++; assert.deepEqual(input.data, bytes); return ref; } }, [{ ref, data: bytes.toString('base64') }], async () => { throw Error('file imports need no image provider'); });
  assert.equal(saves, 1);
  await assert.rejects(importNativeAttachments({ saveFile: async () => ({ ...ref, attachmentId: 'wrong' }) }, [{ ref, data: bytes.toString('base64') }], async () => ({})), /changed a file/);
});

test('protocol validation and attachment discovery do not mutate source events', () => {
  const s = snapshot(), digest = nativeDigest(s); validateNative(s); fileRefs(s.events); assert.equal(nativeDigest(s), digest);
});

test('opaque tool metadata, parameters and tool-call JSON are never scanned as attachment paths', () => {
  const opaque = { type: 'resource', spillPath: '/must/not/read', schema: { type: 'file', attachmentId: 'opaque' }, content: [{ type: 'file', path: '/opaque' }] };
  const input = [{ type: 'tool/result', data: { message: { role: 'tool', content: [{ type: 'text', text: JSON.stringify(opaque), meta: opaque }] }, meta: opaque } },
    { type: 'request/header', data: { header: { tools: [{ name: 'normal', parameters: opaque }] } } },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'id', name: 'normal', arguments: JSON.stringify(opaque) }] }];
  const before = nativeDigest(input); assert.deepEqual(fileRefs(input), []); assert.equal(nativeDigest(input), before);
  assert.throws(() => fileRefs({ role: 'tool', content: [{ type: 'cache-ref', path: '/unknown' }] }), /content block.*portable artifact/);
});

test('complete structured child trees replay, while missing children and cycles are rejected', () => {
  const root = snapshot(), child = snapshot();
  child.header = { ...child.header, origin: 'subagent', parentSession: root.header.id, createdAt: 2 } as never;
  child.events.push({ type: 'subagent/descriptor', seq: child.events.length, time: 1, data: { version: 3, mode: 'continuable', label: 'child', provider: 'spawn' } });
  root.events.push({ type: 'subagent/catalog', seq: root.events.length, time: 1, data: { childId: child.header.id, childCreatedAt: 2, mode: 'continuable', label: 'child' } });
  root.autonomy = { schema: 1, rootId: root.header.id, children: [child], queues: [], schedules: [] };
  validateNative(root);
  const missing = structuredClone(root); missing.autonomy!.children = []; assert.throws(() => validateNative(missing), /missing/);
  const cycle = structuredClone(root); cycle.autonomy!.children[0].header = { ...child.header, parentSession: child.header.id }; cycle.autonomy!.children[0].events.push({type:'subagent/catalog',seq:child.events.length,time:1,data:{childId:child.header.id,childCreatedAt:2,mode:'continuable',label:'child'}}); assert.throws(() => validateNative(cycle), /cyclic/);
  const noPacket = structuredClone(root); delete noPacket.autonomy; assert.throws(() => validateNative(noPacket), /complete subtree/);
});

test('real native content probe: image normalization IDs, lossless import, full large output and auxiliary stream hooks', {
  skip: !process.env.DSH_NATIVE_TEST_RUNTIME && 'Set DSH_NATIVE_TEST_RUNTIME to installed runtime node_modules',
}, async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', './test/setup.mjs', '--import', 'tsx',
    fileURLToPath(new URL('./fixtures/native-content-probes.mjs', import.meta.url)), process.env.DSH_NATIVE_TEST_RUNTIME!],
  { cwd: fileURLToPath(new URL('..', import.meta.url)), timeout: 30_000, maxBuffer: 512 * 1024, env: { PATH: process.env.PATH, TMPDIR: '/tmp' } });
  const result = JSON.parse(stdout.trim());
  for (const name of ['ordinaryTool','largeResultVerbatim','opaqueMetaPreserved','compactionStreamHook','titlePreparedStreamHook','samePolicyStable','differentPolicyReencodes','losslessNativeImageImport']) assert.equal(result[name], true, name);
  assert.ok(result.largeResultBytes > 300_000);
});

test('real 0.2.2-rc.1: lossless images, normal native tools/commands, new compaction/title, fenced two-instance continuation', {
  skip: !process.env.DSH_NATIVE_TEST_RUNTIME && 'Set DSH_NATIVE_TEST_RUNTIME to installed runtime node_modules; no user profile is read',
}, async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', './test/setup.mjs', '--import', 'tsx',
    fileURLToPath(new URL('./fixtures/native-capabilities.mjs', import.meta.url)), process.env.DSH_NATIVE_TEST_RUNTIME!],
  { cwd: fileURLToPath(new URL('..', import.meta.url)), timeout: 60_000, maxBuffer: 512 * 1024, env: { PATH: process.env.PATH, TMPDIR: '/tmp' } });
  const result = JSON.parse(stdout.trim());
  for (const capability of ['normalNativeTool','largeOutputVerbatim','opaqueToolMetaPreserved','samePolicyImageStable','differentPolicyReencodes','losslessImageImport','imageOffloadReplay','receiverPermissions','ordinarySlash','freshCompaction','ordinaryTitle','fullAuxiliaryLifecycle','commandLifecycle','importZeroExecution','offlineAuxiliaryFenced','twoInstanceRoundTrip','localMappingRoundTrip','localToolCwd','receiverCwdRebuilt','goalColdRestoreDisarmed','goalArchiveKeepsArmed','pausedGoalImportZeroExecution','explicitGoalResume','nativeAliasBothDirections','aliasPreservesAuthorization','childRootOwnership','coldDescendantDiscovery','productionTreeColdImport','productionHistoricalAlias','productionGoalResume']) assert.equal(result[capability], true, capability);
  assert.ok(result.streamHooks.includes('compaction')); assert.ok(result.streamHooks.includes('session-title'));
});
