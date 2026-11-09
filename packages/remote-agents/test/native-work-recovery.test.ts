import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NativeAutonomyJournal, NativeWorkNotAccepted, type NativeAutonomyHost, type NativeAutonomyBundle, type NativeSchedule } from '../src/chat/native-autonomy.js';
async function setup(t: TestContext, schedule?: Partial<NativeSchedule>) {
  const root = await mkdtemp(join(tmpdir(), 'native-work-proof-')); t.after(() => rm(root, { recursive: true, force: true }));
  const source: NativeSchedule = { id: 'source-task', title: 'Exact title', prompt: 'Exact original text old-root', kind: 'every', everySeconds: 600, scheduledAt: '2030-01-01T00:00:00.000Z', status: 'active', target: { kind: 'session', sessionId: 'old-root' }, involvedSessionIds: ['old-root'], ...schedule };
  const bundle: NativeAutonomyBundle = { schema: 1, rootId: 'old-root', children: [], queues: [], schedules: [source] };
  const journal = new NativeAutonomyJournal(join(root, 'state.json')), inventory: NativeSchedule[] = [];
  let creates = 0, mode: 'ok' | 'lost' | 'empty-lost' | 'conflict' | 'rejected' = 'ok';
  const host: NativeAutonomyHost = { capture: async () => undefined, freeze: async () => { throw Error('not freezing'); }, preflight: async () => {}, importParked: async () => {}, deliver: async () => {}, schedule: {
    catalog: async () => structuredClone(inventory), list: async () => ({ items: structuredClone(inventory), total: inventory.length }), view: async ({ id }) => structuredClone(inventory.find(s => s.id === id) ?? { id, code: 'schedule_not_found' }), edit: async () => { throw Error('no edit'); },
    create: async request => {
      creates++;
      if (mode === 'rejected') throw new NativeWorkNotAccepted('invalid_rule', 'Definitely rejected before task creation');
      if (mode === 'empty-lost') throw Error('Unknown transport outcome but no record was committed');
      const task: NativeSchedule = { ...structuredClone(source), id: `created-${creates}`, target: request.target, status: 'active', createdAt: new Date().toISOString() }; inventory.push(task);
      if (mode === 'conflict') inventory.push({ ...structuredClone(task), id: 'simultaneous-identical-task' });
      if (mode === 'lost' || mode === 'conflict') throw Error('Reply lost after commit');
      return task;
    },
  } };
  journal.stage('receiver', bundle); await journal.importParked('receiver', host);
  return { journal, host, bundle, inventory, source, creates: () => creates, mode: (value: typeof mode) => { mode = value; } };
}

test('expired one-shots are retained ended/expired with their original instant and never become uncertain or retimed', async t => {
  for (const kind of ['at','after'] as const) {
    const x = await setup(t, { kind, scheduledAt: '2000-01-01T00:00:00.000Z' });
    await x.journal.resume('receiver', x.host, { schedules: ['source-task'] });
    assert.equal(x.creates(), 0); assert.equal(x.journal.status('receiver')!.receipts['schedule/source-task'].state, 'expired');
    const exported = x.journal.exportBundle('receiver', { ...x.bundle, schedules: [] });
    assert.equal(exported.schedules[0].scheduledAt, x.source.scheduledAt); assert.equal(exported.schedules[0].status, 'ended'); assert.equal(exported.schedules[0].migrationState, 'expired');
  }
});

test('originally paused tasks stay parked through ordinary resume; explicit enable is a distinct request', async t => {
  const x = await setup(t, { status: 'paused' });
  await x.journal.resume('receiver', x.host, { schedules: ['source-task'] }); assert.equal(x.creates(), 0);
  assert.equal(x.journal.status('receiver')!.schedules[0].resumeIntent, 'paused');
  await x.journal.resume('receiver', x.host, { activatePaused: ['source-task'] }); assert.equal(x.creates(), 1);
  await x.journal.resume('receiver', x.host, { schedules: ['source-task'] }); assert.equal(x.creates(), 1);
});

test('definite pre-acceptance errors remain retryable by explicit action and do not block exporting retained work', async t => {
  const x = await setup(t); x.mode('rejected');
  await assert.rejects(x.journal.resume('receiver', x.host, { schedules: ['source-task'] }), /Definitely rejected/);
  assert.equal(x.journal.status('receiver')!.receipts['schedule/source-task'].state, 'not-accepted');
  assert.doesNotThrow(() => x.journal.exportBundle('receiver', x.bundle));
  await assert.rejects(x.journal.resume('receiver', x.host, { schedules: ['source-task'] }), /reconcile/);
  x.mode('ok'); await x.journal.retryWork('receiver', 'schedule/source-task', x.host); assert.equal(x.creates(), 2);
  await assert.rejects(x.journal.retryWork('receiver', 'schedule/source-task', x.host), /confirm non-acceptance/); assert.equal(x.creates(), 2);
});

test('unknown create is queried by exact saved request, target, new identity and creation interval; unique candidate needs confirmation', async t => {
  const x = await setup(t);
  x.inventory.push({ ...x.source, id: 'preexisting-identical', target: { kind: 'session', sessionId: 'receiver' }, createdAt: '2000-01-01T00:00:00.000Z' });
  x.mode('lost'); await assert.rejects(x.journal.resume('receiver', x.host, { schedules: ['source-task'] }), /Reply lost/);
  const query = await x.journal.inspectWork('receiver', 'schedule/source-task', x.host);
  assert.equal(query.state, 'candidate'); assert.deepEqual(query.candidates, ['created-1']);
  assert.equal(x.journal.status('receiver')!.receipts['schedule/source-task'].state, 'uncertain');
  await assert.rejects(x.journal.reconcileWork('receiver', 'schedule/source-task', x.host, { candidateId: 'preexisting-identical' }), /unique exact/);
  await x.journal.reconcileWork('receiver', 'schedule/source-task', x.host, { candidateId: 'created-1' });
  await x.journal.resume('receiver', x.host, { schedules: ['source-task'] }); assert.equal(x.creates(), 1);
});

test('conflicting exact candidates cannot be auto-claimed or treated as absent', async t => {
  const x = await setup(t); x.mode('conflict'); await assert.rejects(x.journal.resume('receiver', x.host, { schedules: ['source-task'] }));
  const query = await x.journal.inspectWork('receiver', 'schedule/source-task', x.host); assert.equal(query.state, 'conflict');
  await assert.rejects(x.journal.reconcileWork('receiver', 'schedule/source-task', x.host, { candidateId: 'created-1' }), /unique exact/);
  await assert.rejects(x.journal.reconcileWork('receiver', 'schedule/source-task', x.host, { confirmAbsent: true }), /not proven/);
  await assert.rejects(x.journal.retryWork('receiver', 'schedule/source-task', x.host), /confirm non-acceptance/); assert.equal(x.creates(), 1);
});

test('settled unknown with complete catalog and confirmed absence allows one explicit retry; inspection alone never retries', async t => {
  const x = await setup(t); x.mode('empty-lost'); await assert.rejects(x.journal.resume('receiver', x.host, { schedules: ['source-task'] }));
  assert.equal((await x.journal.inspectWork('receiver', 'schedule/source-task', x.host)).state, 'absent'); assert.equal(x.creates(), 1);
  await assert.rejects(x.journal.retryWork('receiver', 'schedule/source-task', x.host), /confirm non-acceptance/);
  await x.journal.reconcileWork('receiver', 'schedule/source-task', x.host, { confirmAbsent: true });
  x.mode('ok'); await x.journal.retryWork('receiver', 'schedule/source-task', x.host); assert.equal(x.creates(), 2);
});

test('definite rejected input remains exact; queue admission proof must match the saved digest before clearing uncertainty', async t => {
  const x = await setup(t); const message = { id: 'queued-message', content: [{ type: 'text', text: 'Opaque old-root text' }] };
  const packet = { ...x.bundle, queues: [{ sessionId: 'old-root', target: 'next-turn' as const, messages: [message] }] };
  x.journal.stage('queue-copy', packet); await x.journal.importParked('queue-copy', x.host);
  x.host.deliver = async () => { throw new NativeWorkNotAccepted('agent_not_live', 'Child is not resident; no acceptance'); };
  await assert.rejects(x.journal.resume('queue-copy', x.host, { queues: true })); assert.equal(x.journal.status('queue-copy')!.receipts['queue/queued-message'].state, 'not-accepted');
  x.host.deliver = async (_id, _target, accepted) => { assert.deepEqual(accepted, message); throw Error('acceptance reply lost'); };
  await assert.rejects(x.journal.retryWork('queue-copy', 'queue/queued-message', x.host));
  x.host.queryWork = async request => ({ state: 'accepted', requestDigest: request.requestDigest, localId: message.id });
  assert.equal((await x.journal.inspectWork('queue-copy', 'queue/queued-message', x.host)).state, 'done');
});
