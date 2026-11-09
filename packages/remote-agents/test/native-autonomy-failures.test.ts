import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { NativeSharing, type NativeHost } from '../src/chat/native-service.js';
import { captureNativeGoal, nativeDshGoalAdapter, nativeParkedQueues, NATIVE_DSH_GOAL_ADAPTER, type NativeAutonomyBundle, type NativeGoalView, type NativeSchedule, type NativeScheduleApi } from '../src/chat/native-autonomy.js';
import { NATIVE_CLOSED_PROVIDER, type NativeSnapshot } from '../src/chat/native-protocol.js';
import { registryFixture } from './fixtures/native-authority.js';

const clone = <T,>(value: T): T => structuredClone(value);
async function rig(t: TestContext, work = true) {
  const authority = await registryFixture(t), id = randomUUID(), source = Session.create(SessionId(id));
  source.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Original source text with no identity rewriting' }], source: { kind: 'user' } }), { surfaceOp: 'append' });
  (source as any).append('model/selection', { provider: 'normal', model: 'configured' });
  const data = new Map<string, NativeSnapshot>([[id, { protocol: 'shared-native-v1', header: source.header, inheritedEventCount: 0, project: '/srv/project', title: 'Recovery', events: clone([...source.snapshotEvents()]), files: [] }]]);
  const add = (owner: string, type: string, payload: any) => { const s = data.get(owner)!; s.events.push({ type, data: clone(payload), seq: s.events.length, time: Date.now(), ...(type === 'user/message' ? { surfaceOp: 'append' } : {}) }); };
  const goals = new Map<string, NativeGoalView>(), tasks = new Map<string, NativeSchedule>(), archived = new Set<string>(), freezeIds: string[] = [], delivered: string[] = [], requests: any[] = [];
  let goalResumes = 0, scheduleCreates = 0, metadataRestores = 0, offline = false, failArchive = false, failFrozenAppend = false, lostCreate = false, rejectCreate = false, loseCancel = false, loseAppend = false;
  const recordGoal = (owner: string, operation: string, view: NativeGoalView) => { const { activation, roundsStarted, createdAt, updatedAt, ...goal } = view; add(owner, 'goal/change', { kind: 'goal/change', version: 1, operation, goal, roundsStarted, createdAt, updatedAt }); };
  const goalApi = {
    get(owner: string) { return goals.has(owner) ? clone(goals.get(owner)!) : undefined; },
    pause(owner: string, ref: { id: string; revision: number }) { const v = goals.get(owner)!; assert.equal(ref.revision, v.revision); const next = { ...v, revision: v.revision + 1, phase: 'paused' as const, activation: 'disarmed' as const, updatedAt: Date.now() }; goals.set(owner, next); recordGoal(owner, 'pause', next); return clone(next); },
    resume(owner: string, ref: { id: string; revision: number }) { const v = goals.get(owner)!; assert.equal(ref.revision, v.revision); const next = { ...v, revision: v.revision + 1, phase: 'active' as const, activation: 'armed' as const, updatedAt: Date.now() }; goals.set(owner, next); recordGoal(owner, 'resume', next); goalResumes++; return clone(next); },
  };
  const schedule: NativeScheduleApi = {
    catalog: async () => clone([...tasks.values()]), list: async () => ({ items: clone([...tasks.values()]), total: tasks.size }), view: async ({ id }) => tasks.has(id) ? clone(tasks.get(id)!) : { id, code: 'schedule_not_found' },
    edit: async request => { const task = tasks.get(request.id)!; if (request.expectedUpdatedAt !== (task.updatedAt ?? null)) return { id: request.id, code: 'schedule_conflict' }; const next = { ...task, status: request.patch.active ? 'active' as const : 'paused' as const, updatedAt: `${Date.now()}-${request.patch.active}` }; tasks.set(task.id, next); return clone(next); },
    create: async request => { scheduleCreates++; const task: NativeSchedule = { id: randomUUID(), title: request.title, prompt: request.prompt, kind: 'every', everySeconds: Number(request.timing.every_seconds), scheduledAt: '2030-01-01T00:00:00.000Z', status: 'active', target: request.target, involvedSessionIds: [request.target.sessionId], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }; tasks.set(task.id, task); return clone(task); },
  };
  if (work) {
    const view: NativeGoalView = { id: 'retained-goal', revision: 1, phase: 'active', activation: 'armed', objective: 'Retain exact source objective', maxGoalRounds: 3, roundsStarted: 0, createdAt: Date.now(), updatedAt: Date.now() }; goals.set(id, view); recordGoal(id, 'create', view);
    tasks.set('original-schedule', { id: 'original-schedule', title: 'Original task', prompt: 'Exact task instructions', kind: 'every', everySeconds: 600, scheduledAt: '2030-01-01T00:00:00.000Z', status: 'active', target: { kind: 'session', sessionId: id }, involvedSessionIds: [id], updatedAt: 'original-revision' });
    add(id, 'agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [{ id: 'original-input', content: [{ type: 'text', text: '保留排队输入🙂' }], role: 'user', source: { kind: 'user' } }] });
  }
  let native!: NativeSharing;
  const goalAdapter = nativeDshGoalAdapter(goalApi, { liveAgent: owner => goals.has(owner) ? owner : undefined, readColdGoal: async owner => { const v = goalApi.get(owner); if (!v) return; const { activation, ...durable } = v; return durable; } });
  const capture = async (owner: string): Promise<NativeAutonomyBundle> => ({ schema: 1, rootId: owner, children: [], queues: nativeParkedQueues(data.get(owner)!), schedules: clone([...tasks.values()].filter(s => s.target.sessionId === owner)), goals: goalApi.get(owner) ? [captureNativeGoal(goalApi, owner, owner)!] : [] });
  const host: NativeHost = { available: () => true, placement: async () => '/srv/project', snapshot: async owner => clone(data.get(owner)!), idle: async (_id, run) => run(), validate: async () => {},
    import: async (owner, _host, snapshot) => { data.set(owner, { ...clone(snapshot), header: { ...snapshot.header, id: owner as never } }); const goal = snapshot.autonomy?.goals?.[0]; if (goal) goals.set(owner, { ...goal.state as Omit<NativeGoalView, 'activation'>, activation: 'disarmed' }); },
    activate: async () => {}, seal: async owner => { add(owner, 'model/selection', { provider: NATIVE_CLOSED_PROVIDER, model: 'closed' }); }, unseal: async (owner, selection) => { add(owner, 'model/selection', selection); },
  };
  host.autonomy = { capture: owner => capture(owner), preflight: async () => {}, importParked: async () => {}, goals: { [NATIVE_DSH_GOAL_ADAPTER]: goalAdapter }, schedule,
    deliver: async (owner, _target, message) => { await native.guard(owner); delivered.push(message.id); add(owner, 'user/message', message); },
    freeze: async (owner, bundle, operationId) => {
      freezeIds.push(operationId);
      return native.autonomy.freezeSource(data.get(owner)!, bundle, { snapshot: async child => clone(data.get(child)!), runtime: () => ({ status: 'idle' }), schedule, goals: { [NATIVE_DSH_GOAL_ADAPTER]: goalAdapter },
        clearInbox: async child => { for (const q of nativeParkedQueues(data.get(child)!)) add(child, 'agent/inbox/spliced', { target: q.target, start: 0, removedCount: q.messages.length, inserted: [] }); },
        archiveSession: async child => { if (failArchive) throw Error('injected archive failure after clear'); archived.add(child); },
      }, operationId);
    },
    restoreSource: async owner => { metadataRestores++; archived.delete(owner); },
  };
  const path = join(authority.root, 'source.json');
  const rpc = { call: async (_host: string, request: Record<string, any>) => {
    requests.push(clone(request)); if (offline) throw Error('offline');
    if (request.action === 'create' && rejectCreate) throw Error('injected create refusal');
    if (request.action === 'append' && native.replica(String(request.id))?.pendingFreeze && failFrozenAppend) throw Error('injected frozen append failure');
    // Lookup by local root instead: the wire id deliberately differs.
    if (request.action === 'append' && native.status().replicas.some(r => r.sharedId === request.id && r.pendingFreeze) && failFrozenAppend) throw Error('injected frozen append failure');
    const result = await authority.run(request);
    if (request.action === 'create' && lostCreate) { lostCreate = false; throw Error('lost committed create reply'); }
    if (request.action === 'cancel-create' && loseCancel) { loseCancel = false; throw Error('lost cancellation reply'); }
    if (request.action === 'append' && loseAppend) { loseAppend = false; throw Error('lost committed append reply'); }
    return result;
  } };
  const restart = () => native = new NativeSharing(path, 'instance-air', rpc, host);
  restart(); await native.configure('remote-host', true); t.after(() => native.close());
  return { authority, id, data, goals, tasks, archived, requests, delivered, freezeIds, host, get native() { return native; }, restart, add,
    counts: () => ({ goalResumes, scheduleCreates, metadataRestores }), flags: (values: { offline?: boolean; archive?: boolean; frozenAppend?: boolean; lostCreate?: boolean; rejectCreate?: boolean; loseCancel?: boolean; loseAppend?: boolean }) => { offline = values.offline ?? offline; failArchive = values.archive ?? failArchive; failFrozenAppend = values.frozenAppend ?? failFrozenAppend; lostCreate = values.lostCreate ?? lostCreate; rejectCreate = values.rejectCreate ?? rejectCreate; loseCancel = values.loseCancel ?? loseCancel; loseAppend = values.loseAppend ?? loseAppend; } };
}

for (const failure of ['archive','checkpoint'] as const) test(`${failure} failure pins the freeze across restart, blocks continued input/checkpoint and retries the same handoff without losing cleared messages`, async t => {
  const x = await rig(t, false), shared = await x.native.share(x.id, 'remote-host'), active = await x.native.open('remote-host', shared.sharedId, true);
  x.add(active.sessionId, 'agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [{ id: 'during-handoff', content: [{ type: 'text', text: 'Never lose this' }], role: 'user', source: { kind: 'user' } }] });
  x.flags(failure === 'archive' ? { archive: true } : { frozenAppend: true });
  await assert.rejects(x.native.handoff(active.sessionId), /injected/);
  const pending = clone(x.native.replica(active.sessionId)!.pendingFreeze!), version = x.native.replica(active.sessionId)!.version;
  assert.equal(nativeParkedQueues(x.data.get(active.sessionId)!).length, 0);
  await assert.rejects(x.native.guard(active.sessionId), /Freeze recovery pending/);
  x.native.rejected(active.sessionId, [{ id: 'rejected-new-input', content: [] }]);
  await assert.rejects(x.native.checkpoint(active.sessionId), /pending freeze/);
  assert.equal(x.native.replica(active.sessionId)!.version, version);
  assert.equal(x.native.autonomy.sourcePacket(pending.operationId)!.original!.bundle.queues[0].messages[0].id, 'during-handoff');
  x.restart(); x.flags({ archive: false, frozenAppend: false });
  await x.native.handoff(active.sessionId);
  assert.equal(x.native.replica(active.sessionId)!.pendingFreeze, undefined); assert.equal(x.native.replica(active.sessionId)!.phase, 'sealed');
  assert.equal(new Set(x.freezeIds.filter(op => op.startsWith('handoff/'))).size, 1);
  const stored = await x.authority.call('get', { id: shared.sharedId });
  assert.equal(stored.snapshot.autonomy.queues[0].messages[0].id, 'during-handoff');
  assert.equal(x.native.recoveryInput(active.sessionId)[0] && (x.native.recoveryInput(active.sessionId)[0] as any).id, 'rejected-new-input');
});

test('rollback reopens only the same owned writer, leaves cleared input parked, then explicit resume uses guarded delivery without deadlock', async t => {
  const x = await rig(t, false), shared = await x.native.share(x.id, 'remote-host'), active = await x.native.open('remote-host', shared.sharedId, true);
  x.add(active.sessionId, 'agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [{ id: 'rollback-input', role: 'user', content: [], source: { kind: 'user' } }] });
  x.flags({ archive: true }); await assert.rejects(x.native.handoff(active.sessionId), /archive failure/); x.flags({ archive: false });
  await x.native.rollbackFreeze(active.sessionId); await x.native.guard(active.sessionId); assert.equal(x.delivered.length, 0);
  await x.native.resumeAutonomy(active.sessionId, { queues: true }); assert.deepEqual(x.delivered, ['rollback-input']);
  await x.native.checkpoint(active.sessionId);
});

test('cancelled lost-create enrollment retains goals/schedules/input until explicit source restore and resumes existing task IDs once', async t => {
  const x = await rig(t), originalGoal = clone(x.goals.get(x.id)!);
  x.flags({ lostCreate: true }); await assert.rejects(x.native.share(x.id, 'remote-host'), /lost committed create/);
  const failed = clone(x.native.replica(x.id)!), create = clone(failed.pending!);
  x.native.rejected(x.id, [{ id: 'post-freeze-rejection', content: [{ type: 'text', text: 'Also retain this rejected input' }] }]);
  assert.equal(x.goals.get(x.id)!.phase, 'paused'); assert.equal(x.tasks.get('original-schedule')!.status, 'paused');
  x.flags({ offline: true }); await assert.rejects(x.native.cancelEnrollment(x.id), /offline/); assert.equal(x.counts().metadataRestores, 0);
  x.restart(); x.flags({ offline: false, loseCancel: true }); await assert.rejects(x.native.cancelEnrollment(x.id), /lost cancellation/);
  await x.native.cancelEnrollment(x.id); assert.equal(x.native.replica(x.id)!.enrollmentCancelled, true); assert.equal(x.counts().metadataRestores, 0);
  await assert.rejects(x.authority.run({ protocol: 'shared-native-v1', instance: 'instance-air', ...create }), /create conflict/);
  await x.native.restoreCancelledSource(x.id); assert.equal(x.native.replica(x.id), undefined); assert.equal(x.delivered.length, 0); assert.equal(x.tasks.get('original-schedule')!.status, 'paused');
  assert.equal((x.native.recoveryInput(x.id)[0] as any).id, 'post-freeze-rejection');
  await x.native.resumeSourceWork(x.id, { queues: true, schedules: ['original-schedule'], goals: true });
  assert.deepEqual(x.delivered, ['original-input']); assert.equal(x.counts().scheduleCreates, 0); assert.equal(x.counts().goalResumes, 1); assert.equal(x.goals.get(x.id)!.id, originalGoal.id);
  x.restart(); await x.native.resumeSourceWork(x.id, { queues: true, schedules: ['original-schedule'], goals: true });
  assert.deepEqual(x.delivered, ['original-input']); assert.equal(x.counts().goalResumes, 1);
  assert.equal(x.native.autonomy.sourcePacket(`freeze/${failed.sharedId}`)!.original!.bundle.queues[0].messages[0].id, 'original-input');
});

test('lost append/get responses replay the exact autonomy request and receipt without duplicating root history', async t => {
  const x = await rig(t, false), shared = await x.native.share(x.id, 'remote-host'), active = await x.native.open('remote-host', shared.sharedId, true);
  x.add(active.sessionId, 'session/title', { title: 'Committed suffix', source: { kind: 'user' }, messageSeqs: [] });
  x.flags({ loseAppend: true }); await assert.rejects(x.native.checkpoint(active.sessionId), /lost committed append/);
  const pending = clone(x.native.replica(active.sessionId)!.pending!);
  await x.native.checkpoint(active.sessionId);
  const attempts = x.requests.filter(r => r.op === pending.op); assert.equal(attempts.length, 2); assert.deepEqual(attempts[0], attempts[1]);
  const record = await x.authority.call('get', { id: shared.sharedId }); assert.equal(record.snapshot.events.filter((e: any) => e.type === 'session/title').length, 1); assert.equal(record.snapshot.autonomy.rootId, record.snapshot.header.id);
});
