import { Session, SessionId } from '@deepseek-ai/dsh-session';
import { RemoteError } from '../core/domain.js';
import type { NativeHost, NativeSharing } from './native-service.js';
import { nativeDigest, validateNative, type NativeSnapshot } from './native-protocol.js';
import { assertNativeAutonomyIdle, nativeParkedQueues, captureNativeSchedules, nativeDshGoalAdapter, captureNativeGoal, NATIVE_DSH_GOAL_ADAPTER,
  NativeWorkNotAccepted, type NativeWorkRequest, type NativeAutonomyHost, type NativeAutonomyBundle, type NativeDurableGoal, type NativeQueue } from './native-autonomy.js';
import { NativeAdmissionReceipts, queueAdmissionEvent, goalAdmissionEvent } from './native-admission-receipts.js';

/** Concrete public-service binding. Capturing/importing never creates Agents,
 * goals, schedules, tools or model requests. All activation is explicit. */
export function nativeRuntimeAutonomy(get: (name: string) => any, load: (name: string) => Promise<any>, host: NativeHost, sharing: NativeSharing): NativeAutonomyHost {
  const fail: (message: string) => never = message => { throw new RemoteError(`Native runtime: ${message}`, 409); };
  const receipts = new NativeAdmissionReceipts(`${sharing.path}.admissions.json`);
  const flushAdmission = async (agent: any) => {
    if (await get('sessions').flush(agent.session) === false) throw new Error('Native admission persistence did not acknowledge the log; reconcile before retrying');
  };
  const beforeAdmission = async (agent: any) => {
    try { await flushAdmission(agent); }
    catch (error) { throw new NativeWorkNotAccepted('native_persistence_unavailable', `No native work was submitted: ${String(error)}`); }
  };
  const receiptEvents = async (id: string) => {
    const agent = get('agents').get(id); if (agent) await flushAdmission(agent);
    const observed = await get('sessionQuery').observeSession(id, { projectionMode: 'none' });
    try { return structuredClone(observed.events); } finally { observed[Symbol.dispose](); }
  };
  const admit = async (id: string) => {
    try { await sharing.guard(id); }
    catch (error) { throw new NativeWorkNotAccepted('native_owner_unavailable', `No native work was submitted: ${String(error)}`); }
  };
  const existingAdmission = async (kind: 'queue' | 'goal', id: string, payload: any): Promise<boolean> => {
    const key = receipts.key(kind, id, payload), row = receipts.get(key);
    if (!row || row.state === 'rejected') return false;
    const state = receipts.evidence({ kind, sessionId: id, payload, requestDigest: key } as NativeWorkRequest, await receiptEvents(id));
    if (state === 'accepted') return true;
    fail('prior native admission has no exact receipt proof; reconcile it before another submission');
  };
  const runtime = (id: string) => ({ status: get('agents').get(id)?.status, jobs: get('jobs')?.list(id) ?? [] });
  const coldGoal = async (id: string): Promise<NativeDurableGoal | undefined> => {
    const observed = await get('sessionQuery').observeSession(id, { projectionMode: 'none' });
    try { const { foldGoal } = await load('@deepseek-ai/dsh-goal'); const folded = foldGoal(observed.events);
      return folded.goal && { ...folded.goal, roundsStarted: folded.roundsStarted, createdAt: folded.createdAt, updatedAt: folded.updatedAt };
    } finally { observed[Symbol.dispose](); }
  };
  const goalAdapters = () => {
    const api = get('goals'); if (!api) return undefined;
    const base = nativeDshGoalAdapter(api, { liveAgent: id => get('agents').get(id), readColdGoal: coldGoal });
    return { [NATIVE_DSH_GOAL_ADAPTER]: { ...base, async resume(state: any, id: string, operationId: string) {
      await admit(id);
      const agent = get('agents').get(id);
      if (!agent) throw new NativeWorkNotAccepted('native_child_cold', 'Continue this cold child through its native parent before explicitly retrying its goal');
      if (await existingAdmission('goal', id, state)) return;
      try { await base.preflight(state); }
      catch (error) { throw new NativeWorkNotAccepted('native_goal_invalid', String(error)); }
      let current: any;
      try { current = api.get(agent); }
      catch (error) { throw new NativeWorkNotAccepted('native_goal_unavailable', String(error)); }
      const expected = state.state;
      if (!current || current.id !== expected.id || current.revision !== expected.revision) throw new NativeWorkNotAccepted('native_goal_revision', 'Goal identity/revision changed; no resume was submitted');
      await beforeAdmission(agent);
      const before = agent.session.snapshotEvents(), key = receipts.begin('goal', id, state, before);
      let error: unknown;
      try { await base.resume(state, id, operationId); } catch (caught) { error = caught; }
      const noop = current.phase === 'complete';
      const proof = agent.session.snapshotEvents().find((event: any) => (noop || event.seq >= before.length) && goalAdmissionEvent(event, state, noop));
      if (!proof) {
        receipts.rejected(key);
        throw new NativeWorkNotAccepted('native_goal_not_accepted', error ? String(error) : 'Native goal resume produced no matching CAS event');
      }
      receipts.proof(key, proof, noop); await flushAdmission(agent); receipts.accepted(key);
      if (error) throw error; // Lost response stays uncertain until exact queryWork reconciliation.
    } } };
  };
  const editCold = async (id: string, operation: (session: any) => void) => {
    const handle = await get('sessionPersistence').open(SessionId(id), 'write');
    try { const { events } = await handle.read(), session = Session.create(SessionId(id), events, handle.header, handle.inheritedEventCount, get('sessions').messageProjections) as any;
      operation(session); await handle.append(session.snapshotEvents(events.length)); await handle.flush();
    } finally { await handle.close(); }
  };
  const clearInbox = async (id: string, expected: NativeQueue[]) => {
    const snapshot = await host.snapshot(id, '/native-freeze');
    const current = nativeParkedQueues(snapshot);
    if (!current.length) return;
    if (nativeDigest(current) !== nativeDigest(expected)) fail('inbox changed since the durable freeze cut');
    const agent = get('agents').get(id);
    if (agent) {
      for (const queue of current) agent.inbox.splice(queue.target, 0, queue.messages.length, []);
      await get('sessions').flush(agent.session);
    } else await editCold(id, session => { for (const queue of current) session.append('agent/inbox/spliced', { target: queue.target, start: 0, removedCount: queue.messages.length, inserted: [] }); });
  };
  const result: NativeAutonomyHost = {
    get schedule() {
      const api = get('schedule'); if (!api) return undefined;
      // A migration action belongs to its target Session. Use the public actor
      // argument so the native service does not inject an outside-change notice
      // into that very inbox after its durable freeze cut was captured.
      return {
        list: (request: any) => api.list(request), view: (request: any) => api.view(request), catalog: () => api.catalog(),
        create: (request: any) => api.create(request, request.target?.sessionId),
        async edit(request: any) {
          const current = await api.view({ id: request.id });
          return api.edit(request, 'code' in current ? undefined : current.target?.sessionId);
        },
      };
    }, get goals() { return goalAdapters(); },
    async capture(id, project) {
      const goalApi = get('goals'), schedule = get('schedule');
      const root = await host.snapshot(id, project), children: NativeSnapshot[] = [];
      const catalog = root.events.some(e => e.type === 'subagent/catalog');
      if (catalog && !get('subagents')?.listDescendants) fail('native subagent discovery service is required for this catalog');
      if (get('subagents')?.listDescendants) for (const row of await get('subagents').listDescendants(SessionId(id))) {
        if (row.kind !== 'child') fail(`unreadable descendant ${row.id}: ${row.reason}`);
        if (row.activity === 'running') fail(`child ${row.id} is running; settle it before handoff`);
        if (row.mode === 'external') continue; // Catalog fact only; never recreate its process.
        children.push(await host.snapshot(row.id, project));
      }
      const all = [root, ...children], capturedGoals = [];
      for (const snapshot of all) {
        assertNativeAutonomyIdle(snapshot, runtime(snapshot.header.id));
        if (snapshot.events.some(e => e.type === 'goal/change')) {
          if (!goalApi) fail('native goals service is required to migrate goal history');
          const agent = get('agents').get(snapshot.header.id);
          const state = agent ? captureNativeGoal(goalApi, agent, snapshot.header.id) : (() => undefined)();
          if (state) capturedGoals.push(state);
          else { const state = await coldGoal(snapshot.header.id); if (state) capturedGoals.push({ adapter: NATIVE_DSH_GOAL_ADAPTER, version: 1, sessionId: snapshot.header.id, state, sourceMode: 'cold-log' as const }); }
        }
      }
      const scheduled = new Map();
      if (schedule) for (const snapshot of all) for (const task of await captureNativeSchedules(schedule, snapshot.header.id)) scheduled.set(task.id, task);
      const bundle: NativeAutonomyBundle = { schema: 1, rootId: id, children, queues: all.flatMap(nativeParkedQueues), schedules: [...scheduled.values()], ...(capturedGoals.length ? { goals: capturedGoals } : {}) };
      return bundle; // Even plain roots get a durable identity map for future children.
    },
    async freeze(id, bundle, operationId) {
      const replica = sharing.replica(id); if (!replica) fail('source replica is missing');
      const project = await host.placement(id, replica.hostId);
      const root = await host.snapshot(id, project);
      return sharing.autonomy.freezeSource(root, bundle, {
        runtime, snapshot: childId => host.snapshot(childId, root.project), clearInbox, schedule: result.schedule, goals: result.goals,
        async archiveSession() {
          for (const child of [...bundle.children].reverse()) await get('workspaceRegistry').archiveSession(SessionId(child.header.id));
          await get('workspaceRegistry').archiveSession(SessionId(id));
        },
      }, operationId);
    },
    async preflight(plan) {
      for (const snapshot of plan.children) {
        validateNative(snapshot, { treeChild: true });
        await host.validate(snapshot);
        const { foldSubagentDescriptor } = await load('@deepseek-ai/dsh-subagent');
        const descriptor = foldSubagentDescriptor(snapshot.events);
        if (!descriptor || descriptor.version !== 3 || !get('subagents')?.getProvider(descriptor.provider)) fail('receiver subagent provider/descriptor is unavailable');
        if (descriptor.mode === 'continuable' && !get('subagents').getProvider(descriptor.provider).prepareContinuable) fail('receiver provider cannot continue this child');
        if (descriptor.agentProvider && descriptor.agentModel) await get('llm').resolveCallConfig({ provider: descriptor.agentProvider, model: descriptor.agentModel, reasoningEffort: descriptor.agentReasoningEffort });
        if (descriptor.toolFilter) {
          // Resolve against the RECEIVER registry. A filter can only narrow.
          const known = get('tools').definitions().map((d: any) => d.name);
          const names = Array.isArray(descriptor.toolFilter) ? descriptor.toolFilter : [...(descriptor.toolFilter.allow ?? []), ...(descriptor.toolFilter.deny ?? [])];
          if (names.some((n: string) => !known.includes(n))) fail('a child tool filter names an unavailable receiver tool');
        }
      }
      const goals = result.goals;
      for (const goal of plan.bundle.goals ?? []) { if (!goals?.[goal.adapter as keyof typeof goals]) fail('receiver native goal adapter is unavailable'); await goals[NATIVE_DSH_GOAL_ADAPTER].preflight(goal); }
    },
    async importParked(id, plan) {
      const replica = sharing.replica(id); if (!replica) fail('owning root replica is missing');
      for (const child of plan.children) {
        let existing: any;
        try { existing = await get('sessionQuery').observeSession(child.header.id, { projectionMode: 'none' }); }
        catch (error) { if (!/not.found|missing|does not exist|unavailable/i.test(String(error))) throw error; }
        if (existing) {
          try { if (get('agents').get(child.header.id) || nativeDigest(existing.events.slice(0, child.events.length)) !== nativeDigest(child.events) || existing.header.parentSession !== child.header.parentSession || existing.header.createdAt !== child.header.createdAt) fail('existing child identity is active or differs from the fixed import'); }
          finally { existing[Symbol.dispose](); }
        } else await host.import(child.header.id, replica.hostId, child, false, plan.placement ?? replica.placement);
      }
    },
    async deliver(id, target, message) {
      if (!['next-turn', 'next-step'].includes(target) || typeof message?.id !== 'string' || !message.id) throw new NativeWorkNotAccepted('native_input_invalid', 'No input was submitted: native inbox target/message identity is invalid');
      await admit(id);
      const agent = get('agents').get(id);
      if (!agent) throw new NativeWorkNotAccepted('native_child_cold', 'Continue this cold child through its native parent before explicitly retrying its parked input');
      const payload = { target, message };
      if (await existingAdmission('queue', id, payload)) return;
      await beforeAdmission(agent);
      const before = agent.session.snapshotEvents();
      if (before.some((e: any) => e.type === 'user/message' && e.data.id === message.id)) throw new NativeWorkNotAccepted('native_message_identity', 'This input identity already occurs outside this receiver admission; review it instead of duplicating it');
      const key = receipts.begin('queue', id, payload, before);
      let error: unknown;
      try { if (target === 'next-step') agent.steer(message); else agent.followup(message); } catch (caught) { error = caught; }
      const proof = queueAdmissionEvent(agent.session.snapshotEvents(), before.length, target, message);
      if (!proof) {
        receipts.rejected(key);
        throw new NativeWorkNotAccepted('native_queue_not_accepted', error ? String(error) : 'Native inbox did not accept the identified input');
      }
      receipts.proof(key, proof); await flushAdmission(agent); receipts.accepted(key);
      if (error) throw error;
    },
    async queryWork(request) {
      const requestDigest = nativeDigest({ kind: request.kind, sessionId: request.sessionId, payload: request.payload });
      if (requestDigest !== request.requestDigest) return { requestDigest, state: 'conflict' };
      if (request.kind !== 'queue' && request.kind !== 'goal') return { requestDigest, state: 'unknown' };
      const state = receipts.evidence(request, await receiptEvents(request.sessionId));
      return { requestDigest, state, ...(state === 'absent' ? { settled: true } : {}) };
    },
    async restoreSource(_id, operationId) {
      const cut = sharing.autonomy.sourcePacket(operationId); if (!cut) fail('frozen source backup is missing');
      // The journal parks cancelled input separately. Never reinsert it here:
      // restoring an ordinary model must not implicitly resume old tasks.
      for (const snapshot of [cut.snapshot, ...cut.bundle.children]) {
        const id = snapshot.header.id, agent = get('agents').get(id);
        if (agent && get('goals')?.get(agent)) get('goals').disarm(agent);
        await get('workspaceRegistry').unarchiveSession(SessionId(id));
      }
    },
  };
  return result;
}
