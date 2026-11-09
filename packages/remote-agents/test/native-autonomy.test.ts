import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NativeAutonomyJournal, assertNativeAutonomyIdle, canonicalNativeAutonomy, canonicalNativeStructure, captureNativeSchedules, nativeAutonomyAgentId, nativeParkedQueues, pauseNativeSchedules, planNativeAutonomy, remapNativeStructure, validateNativeAutonomy, type NativeAutonomyBundle, type NativeAutonomyHost, type NativeAutonomySource, type NativeSchedule, type NativeScheduleApi } from '../src/chat/native-autonomy.js';
import type { NativeSnapshot } from '../src/chat/native-protocol.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'native-autonomy-')); t.after(() => rm(root, { recursive: true, force: true }));
  return { path: join(root, 'journal.json') };
}
const event = (type: string, data: any, seq: number) => ({ type, data, seq, time: seq + 1 });
function tree() {
  const root: NativeSnapshot = { protocol: 'shared-native-v1', header: { id: 'old-root', version: 4, createdAt: 1, cwd: '/source/project' } as never, inheritedEventCount: 0, project: '/source/project', title: 'Root', files: [], events: [] };
  const child: NativeSnapshot = { ...structuredClone(root), header: { ...root.header, id: 'old-child', parentSession: 'old-root', origin: 'subagent', createdAt: 2, delegationDepth: 1 } as never, title: 'Child', events: [] };
  root.events = [event('subagent/catalog', { version: 0, childId: 'old-child', childCreatedAt: 2, mode: 'continuable', label: 'Research' }, 0), event('user/message', { content: [{ type: 'text', text: 'verbatim old-child /source/project old-root' }] }, 1)];
  child.events = [event('subagent/descriptor', { version: 3, mode: 'continuable', provider: 'native', agentProvider: 'ordinary', agentModel: 'configured', label: 'Research', persona: 'Scientist', toolFilter: { allow: ['Read'] } }, 0), event('job/registered', { jobId: 'bash-historical', owner: 'old-child' }, 1), event('job/settled', { jobId: 'bash-historical', owner: 'old-child', status: 'completed' }, 2)];
  const bundle: NativeAutonomyBundle = { schema: 1, rootId: 'old-root', children: [child], queues: [{ sessionId: 'old-child', target: 'next-turn', messages: [{ id: 'message-1', content: [{ type: 'text', text: 'old-child unchanged' }] }, { id: 'message-2', content: [] }] }], schedules: [] };
  return { root, child, bundle };
}
function schedule(): NativeSchedule { return { id: 'schedule-source', title: 'Check progress', prompt: 'Preserve this old-child text', kind: 'every', everySeconds: 600, scheduledAt: '2030-01-01T00:00:00.000Z', target: { kind: 'session', sessionId: 'old-root' }, involvedSessionIds: ['old-root'], status: 'active', updatedAt: '2026-01-01T00:00:00.000Z' }; }
function harness() {
  const sent: { id: string; target: string; message: any }[] = [], created: any[] = [], imports: any[] = [], preflights: any[] = [], edits: any[] = [];
  let stored = schedule(), lose = false;
  const api: NativeScheduleApi = {
    list: async () => ({ items: [structuredClone(stored)], total: 1 }), view: async () => structuredClone(stored),
    edit: async request => { edits.push(request); if (request.expectedUpdatedAt !== (stored.updatedAt ?? null)) return { id: stored.id, code: 'schedule_conflict' }; stored = { ...stored, status: request.patch.active ? 'active' : 'paused', updatedAt: 'changed' }; return structuredClone(stored); },
    create: async request => { created.push(request); if (lose) throw Error('response lost after durable creation'); return { ...schedule(), id: 'schedule-receiver', target: request.target }; },
  };
  const host: NativeAutonomyHost = { capture: async () => undefined, freeze: async () => { throw Error('not freezing'); }, preflight: async plan => { preflights.push(plan); }, importParked: async (_id, plan) => { imports.push(plan); }, deliver: async (id, target, message) => { sent.push({ id, target, message }); }, schedule: api };
  return { host, api, sent, created, imports, preflights, edits, lose: () => { lose = true; }, stored: () => stored };
}

test('complete continuable tree and settled jobs migrate; live jobs/turns require physical settlement', () => {
  const x = tree(); validateNativeAutonomy(x.root, x.bundle);
  assert.doesNotThrow(() => assertNativeAutonomyIdle(x.child, { jobs: [{ owner: 'old-child', status: 'completed' }, { owner: 'foreign', status: 'running' }] }));
  assert.throws(() => assertNativeAutonomyIdle(x.child, { status: 'running' }), /OS processes cannot migrate/);
  assert.throws(() => assertNativeAutonomyIdle(x.child, { jobs: [{ owner: 'old-child', status: 'stopping' }] }), /OS processes cannot migrate/);
  x.child.events.pop(); assert.throws(() => validateNativeAutonomy(x.root, x.bundle), /live turns\/jobs/);
});

test('missing child logs, foreign lineage, descriptor and catalog mismatches refuse before import', () => {
  for (const corrupt of [
    (b: NativeAutonomyBundle) => { b.children = []; },
    (b: NativeAutonomyBundle) => { b.children[0].header = { ...b.children[0].header, parentSession: 'foreign' as never }; },
    (b: NativeAutonomyBundle) => { b.children[0].events[0].data.version = 99; },
    (b: NativeAutonomyBundle) => { b.children[0].header = { ...b.children[0].header, createdAt: 99 as never }; },
  ]) { const x = tree(); corrupt(x.bundle); assert.throws(() => validateNativeAutonomy(x.root, x.bundle)); }
});

test('only schema-owned identity fields change; raw text, job ownership and descriptors remain exact; checkpoint inverse is stable', () => {
  const x = tree(), ids = { 'old-root': 'new-root', 'old-child': 'new-child' }, plan = planNativeAutonomy(x.bundle, 'new-root', ids);
  const root = remapNativeStructure(x.root, ids), child = plan.children[0];
  assert.equal(root.events[0].data.childId, 'new-child'); assert.deepEqual(root.events[1], x.root.events[1]);
  assert.equal(child.header.parentSession, 'new-root'); assert.equal(child.header.id, 'new-child');
  assert.deepEqual(child.events, x.child.events); assert.equal(child.events[1].data.owner, 'old-child');
  assert.deepEqual(canonicalNativeStructure(root, plan), x.root);
  assert.match(plan.aliases, /new-child/); assert.match(plan.aliases, /list_agents\/send_message/);
  const exported = { ...structuredClone(x.bundle), rootId: 'new-root', children: plan.children, queues: [{ ...x.bundle.queues[0], sessionId: 'new-child' }] };
  const canonical = canonicalNativeAutonomy(exported, plan);
  assert.deepEqual({ ...canonical, agentAliases: undefined }, { ...x.bundle, agentAliases: undefined });
  assert.equal(canonical.agentAliases?.['new-child'], 'old-child');
});

test('inherited catalogs and all non-identity metadata stay exact; repeated hops flatten old root/child aliases', () => {
  const x = tree(); x.root.inheritedEventCount = 1;
  assert.deepEqual(remapNativeStructure(x.root, { 'old-child': 'new-child' }).events[0], x.root.events[0]);
  x.root.inheritedEventCount = 0;
  x.bundle.agentAliases = { 'ancient-child': 'earlier-child', 'earlier-child': 'old-child', 'ancient-root': 'old-root' };
  const plan = planNativeAutonomy(x.bundle, 'new-root', { 'old-root': 'new-root', 'old-child': 'new-child' });
  assert.equal(nativeAutonomyAgentId(plan, 'ancient-child'), 'new-child');
  assert.equal(nativeAutonomyAgentId(plan, 'ancient-root'), 'new-root');
  const canonical = canonicalNativeAutonomy({ ...x.bundle, rootId: 'new-root', children: plan.children }, plan);
  const next = planNativeAutonomy(canonical, 'third-root', { 'old-root': 'third-root', 'old-child': 'third-child' });
  assert.equal(nativeAutonomyAgentId(next, 'ancient-child'), 'third-child');
  assert.equal(nativeAutonomyAgentId(next, 'new-child'), 'third-child');
  assert.equal(nativeAutonomyAgentId(next, 'new-root'), 'third-root');
  assert.throws(() => nativeAutonomyAgentId(next, 'foreign'), /outside/);
  assert.deepEqual({ ...plan.children[0].header, id: x.child.header.id, parentSession: x.child.header.parentSession }, x.child.header);
});

test('durable inbox fold keeps next-step/next-turn message order without changing content', () => {
  const x = tree(); x.root.events = [event('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 0, inserted: [{ id: 'a' }, { id: 'b' }] }, 0), event('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] }, 1), event('agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 0, inserted: [{ id: 'steer' }] }, 2)];
  assert.deepEqual(nativeParkedQueues(x.root), [{ sessionId: 'old-root', target: 'next-step', messages: [{ id: 'steer' }] }, { sessionId: 'old-root', target: 'next-turn', messages: [{ id: 'b' }] }]);
});

test('cold import preflights children, parks queues/schedules with zero execution, and persists fixed IDs privately', async t => {
  const f = await fixture(t), x = tree(), h = harness(), journal = new NativeAutonomyJournal(f.path); x.bundle.schedules = [schedule()];
  const plan = journal.stage('receiver', x.bundle); await journal.importParked('receiver', h.host); await journal.importParked('receiver', h.host);
  assert.equal(h.imports.length, 1); assert.equal(h.sent.length, 0); assert.equal(h.created.length, 0);
  assert.equal(h.preflights[0].children[0].events[0].data.agentModel, 'configured');
  const restarted = new NativeAutonomyJournal(f.path); assert.deepEqual(restarted.plan('receiver')?.ids, plan.ids);
  await restarted.importParked('receiver', h.host); assert.equal(h.imports.length, 1);
  assert.equal((await stat(f.path)).mode & 0o777, 0o600);
});

test('explicit resume delivers queues FIFO and creates schedules once, including across restart', async t => {
  const f = await fixture(t), x = tree(), h = harness(), journal = new NativeAutonomyJournal(f.path); x.bundle.schedules = [schedule()];
  journal.stage('receiver', x.bundle); await journal.importParked('receiver', h.host);
  await journal.resume('receiver', h.host, { queues: true, schedules: ['schedule-source'] });
  assert.deepEqual(h.sent.map(s => s.message.id), ['message-1', 'message-2']);
  assert.equal(h.sent[0].id, journal.plan('receiver')?.ids['old-child']);
  assert.equal(h.created[0].target.sessionId, 'receiver'); assert.equal(h.created[0].timing.every_seconds, 600);
  await new NativeAutonomyJournal(f.path).resume('receiver', h.host, { queues: true, schedules: ['schedule-source'] });
  assert.equal(h.sent.length, 2); assert.equal(h.created.length, 1);
});

test('lost schedule response leaves durable uncertainty and never creates a duplicate on replay', async t => {
  const f = await fixture(t), x = tree(), h = harness(), journal = new NativeAutonomyJournal(f.path); x.bundle.schedules = [schedule()];
  journal.stage('receiver', x.bundle); await journal.importParked('receiver', h.host); h.lose();
  await assert.rejects(journal.resume('receiver', h.host, { schedules: ['schedule-source'] }), /response lost/);
  await assert.rejects(new NativeAutonomyJournal(f.path).resume('receiver', h.host, { schedules: ['schedule-source'] }), /reconcile/);
  assert.equal(h.created.length, 1); assert.equal(journal.status('receiver')?.receipts['schedule/schedule-source'].state, 'uncertain');
});

test('schedule capture includes only root-associated tasks; pause uses exact updatedAt CAS and never creates', async () => {
  const h = harness(); assert.deepEqual(await captureNativeSchedules(h.api, 'unrelated'), []);
  const captured = await captureNativeSchedules(h.api, 'old-root'); await pauseNativeSchedules(h.api, captured);
  assert.equal(h.stored().status, 'paused'); assert.equal(h.created.length, 0); assert.equal(h.edits[0].expectedUpdatedAt, schedule().updatedAt);
  const conflict = harness(); await assert.rejects(pauseNativeSchedules(conflict.api, [{ ...schedule(), updatedAt: 'stale' }]), /changed during pause/);
});

test('source freeze persists queues before take/clear, retains failed packet, and archives the whole tree only after CAS pause', async t => {
  const f = await fixture(t), x = tree(), h = harness(), journal = new NativeAutonomyJournal(f.path); x.bundle.schedules = [schedule()];
  x.child.events.push(event('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 0, inserted: x.bundle.queues[0].messages }, x.child.events.length));
  let fail = true, archived = 0, cleared = 0;
  const source: NativeAutonomySource = { snapshot: async id => structuredClone(id === 'old-root' ? x.root : x.child), runtime: () => ({ status: 'idle' }), schedule: h.api,
    clearInbox: async (_id, expected) => { const packet = JSON.parse(await readFile(f.path, 'utf8')); assert.equal(packet.sources['freeze-cut'].bundle.queues[0].messages[0].id, 'message-1'); if (expected.length) { cleared++; if (fail) throw Error('clear failure'); x.child.events.push(event('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 2, inserted: [] }, x.child.events.length)); } },
    archiveSession: async rootId => { assert.equal(rootId, 'old-root'); assert.equal(h.stored().status, 'paused'); archived++; } };
  await assert.rejects(journal.freezeSource(x.root, x.bundle, source, 'freeze-cut'), /clear failure/);
  assert.equal(archived, 0); assert.equal(journal.sourcePacket('freeze-cut')?.bundle.queues[0].messages.length, 2);
  fail = false; const frozen = await new NativeAutonomyJournal(f.path).freezeSource(x.root, x.bundle, source, 'freeze-cut');
  assert.equal(archived, 1); assert.equal(frozen.bundle.queues[0].messages.length, 2);
  await new NativeAutonomyJournal(f.path).freezeSource(x.root, x.bundle, source, 'freeze-cut'); assert.equal(archived, 1); assert.equal(cleared, 2);
});

test('goal extension is pluggable with explicit preflight and parked import; missing adapter never invents a runtime API', async t => {
  const f = await fixture(t), x = tree(), h = harness(), journal = new NativeAutonomyJournal(f.path); x.bundle.goals = [{ adapter: 'audited-example', version: 1, sessionId: 'old-root', state: { objective: 'retained' } }];
  journal.stage('receiver', x.bundle); await assert.rejects(journal.preflight('receiver', h.host), /goal adapter unavailable/); assert.equal(h.imports.length, 0);
  let imported = 0, resumed = 0;
  h.host.goals = { 'audited-example': { preflight: async () => {}, importParked: async () => { imported++; }, resume: async () => { resumed++; } } };
  await journal.importParked('receiver', h.host); assert.equal(imported, 1); assert.equal(resumed, 0);
  await journal.resume('receiver', h.host, { goals: true }); await journal.resume('receiver', h.host, { goals: true }); assert.equal(resumed, 1);
});

test('real public GoalService: source pause, immutable goal ID, cold disarmed import and explicit rearm', {
  skip: !process.env.NATIVE_AUTONOMY_GOAL_PACKAGE && 'Set NATIVE_AUTONOMY_GOAL_PACKAGE to an isolated public dsh-goal package directory',
}, async () => {
  const { execFile } = await import('node:child_process'), { promisify } = await import('node:util'), { fileURLToPath } = await import('node:url');
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/native-autonomy-goal.mjs', import.meta.url)), process.env.NATIVE_AUTONOMY_GOAL_PACKAGE!], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), timeout: 15_000, env: { PATH: process.env.PATH, TMPDIR: '/tmp' },
  });
  const result = JSON.parse(stdout.trim());
  for (const key of ['sourcePaused', 'sourcePauseReplay', 'exactGoalId', 'importZeroMutation', 'coldDisarmed', 'explicitResumeArmed', 'revisionCAS']) assert.equal(result[key], true, key);
});

test('native inbox schema defaults omitted removedCount to zero; inserted remains required and opaque payloads stay exact', () => {
  const x = tree(), message = { id: 'native-omitted-zero', content: [{ type: 'text', text: 'verbatim' }], meta: { start: -99, removedCount: null, inserted: 'opaque' } };
  x.root.events = [event('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [message] }, 0), event('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [], outcome: 'canceled' }, 1)];
  const before = structuredClone(x.root.events);
  assert.deepEqual(nativeParkedQueues(x.root), [{ sessionId: 'old-root', target: 'next-turn', messages: [message] }]);
  assert.deepEqual(x.root.events, before);
  for (const invalid of [{ target: 'next-turn', start: 0 }, { target: 'next-turn', start: 0, removedCount: null, inserted: [] }]) {
    x.root.events = [event('agent/inbox/spliced', invalid, 0)]; assert.throws(() => nativeParkedQueues(x.root), /invalid durable inbox splice/);
  }
});
