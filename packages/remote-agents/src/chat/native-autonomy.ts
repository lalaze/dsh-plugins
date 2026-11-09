import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { RemoteError } from '../core/domain.js';
import { nativeDigest, type NativeSnapshot } from './native-protocol.js';
import type { NativeRuntimePlacement } from './native-placement.js';

export interface NativeQueue { sessionId: string; target: 'next-turn' | 'next-step'; messages: any[] }
export interface NativeSchedule {
  id: string; title: string; prompt: string; kind: 'after' | 'at' | 'every' | 'daily' | 'weekly' | 'cron' | 'rrule';
  scheduledAt: string; status: 'active' | 'paused' | 'ended'; updatedAt?: string;
  target: { kind: 'session' | 'new_once' | 'new'; sessionId?: string; create?: unknown };
  involvedSessionIds: string[]; executionActive?: boolean;
  afterSeconds?: number; everySeconds?: number; time?: string; timeZone?: string; weekdays?: number[]; expression?: string; rrule?: string;
  createdAt?: string; resumeIntent?: 'active' | 'paused' | 'ended'; migrationState?: 'expired';
}
/** Extension contract only: an embedding must supply an audited adapter for its goal dialect. */
export interface NativeGoalState { adapter: string; version: number; sessionId: string; state: unknown; sourceMode?: 'cold-log' }
export interface NativeAutonomyBundle {
  schema: 1; rootId: string; children: NativeSnapshot[]; queues: NativeQueue[]; schedules: NativeSchedule[]; goals?: NativeGoalState[];
  /** Historical tool identities -> current wire identities, including all prior roots. */
  agentAliases?: Record<string, string>;
}
export interface NativeAutonomySnapshot extends NativeSnapshot { autonomy?: NativeAutonomyBundle }
export interface NativeAutonomyPlan {
  bundle: NativeAutonomyBundle; ids: Record<string, string>; children: NativeSnapshot[]; aliases: string; agentAliases: Record<string, string>;
  /** Fixed receiver runtime target; apply to each child's execution header, never to event strings. */
  placement?: NativeRuntimePlacement;
}
/** No activation API exists here. Imports create cold artifacts; each child gets receiver policy first. */
export interface NativeAutonomyHost {
  capture(sessionId: string, project: string): Promise<NativeAutonomyBundle | undefined>;
  /** Persist the packet before take/clear; CAS-pause schedules, archiveSession(root), then return drained logs. Idempotent by operationId. */
  freeze(sessionId: string, bundle: NativeAutonomyBundle, operationId: string): Promise<{ snapshot: NativeSnapshot; bundle: NativeAutonomyBundle }>;
  /** Verify EVERY child's descriptor provider/model/persona/toolFilter and receiver sandbox dependencies before claiming. */
  preflight(plan: NativeAutonomyPlan): Promise<void>;
  /** Cold persistence only, idempotent by fixed session IDs. Apply fresh sandbox/approval policy to every child. */
  importParked(sessionId: string, plan: NativeAutonomyPlan, operationId: string): Promise<void>;
  /** Exact identified message acceptance. Caller persists intent first; no implicit retry after unknown result. */
  deliver(sessionId: string, target: NativeQueue['target'], message: any): Promise<void>;
  schedule?: NativeScheduleApi;
  goals?: Record<string, NativeGoalAdapter>;
  /** Reopen original artifacts idempotently, but do NOT deliver inbox messages or arm tasks.
   * Pending work stays exclusively in the recovery journal until explicit resume. */
  restoreSource?(sessionId: string, operationId: string, packet?: { snapshot: NativeSnapshot; bundle: NativeAutonomyBundle }): Promise<void>;
  /** Exact admission evidence from the owning queue/goal service or a settled out-of-process schedule invocation. */
  queryWork?(request: NativeWorkRequest): Promise<{ requestDigest: string; state: 'accepted' | 'absent' | 'unknown' | 'conflict'; settled?: boolean; localId?: string }>;
}
export interface NativeResumeOptions { queues?: boolean; schedules?: string[]; goals?: boolean; activatePaused?: string[]; onlyKeys?: string[] }
export interface NativeWorkRequest { kind: 'schedule-create' | 'schedule-update' | 'queue' | 'goal'; sessionId: string; payload: any; startedAt: string; settledAt?: string; requestDigest: string; baselineIds?: string[]; runId: string }
/** Throw only when the owning service proves that no input/task was accepted. */
export class NativeWorkNotAccepted extends RemoteError {
  readonly accepted = false;
  constructor(readonly code: string, message: string) { super(message, 409); this.name = 'NativeWorkNotAccepted'; }
}
export interface NativeGoalAdapter {
  preflight(state: NativeGoalState): Promise<void>;
  importParked(state: NativeGoalState, sessionId: string, operationId: string): Promise<void>;
  resume(state: NativeGoalState, sessionId: string, operationId: string): Promise<void>;
  pause?(state: NativeGoalState, sessionId: string, operationId: string): Promise<NativeGoalState>;
}
/** Matches the audited 0.2.2-rc.1 Schedule Service. create() always arms; never call it during import. */
export interface NativeScheduleApi {
  /** Public in-process native catalog: one complete host snapshot, without activating sessions. */
  catalog?(): Promise<NativeSchedule[]>;
  list(request: { limit: number; offset: number }): Promise<{ items: NativeSchedule[]; total: number }>;
  view(request: { id: string }): Promise<NativeSchedule | { id: string; code: string }>;
  edit(request: { id: string; action: 'update'; patch: { active: boolean }; expectedUpdatedAt: string | null }): Promise<NativeSchedule | { id: string; code: string }>;
  create(request: { title: string; prompt: string; timing: Record<string, unknown>; target: { kind: 'session'; sessionId: string } }): Promise<NativeSchedule>;
}
const fail: (message: string) => never = message => { throw new RemoteError(`Native autonomy: ${message}`, 409); };
const terminal = new Set(['completed', 'killed', 'failed']);

/** Retains completed job facts without claiming to transfer their process-local registry or OS resources. */
export function assertNativeAutonomyIdle(snapshot: NativeSnapshot, runtime: { status?: string; jobs?: { owner?: string; status: string }[] } = {}): void {
  if (runtime.status === 'running' || runtime.jobs?.some(j => j.owner === snapshot.header.id && !terminal.has(j.status))) fail('finish or stop live turns/jobs before handoff; OS processes cannot migrate');
  const jobs = new Map<string, string>(); let turn = false, step = false;
  for (const event of snapshot.events) {
    if (event.type === 'turn/start') turn = true;
    if (event.type === 'turn/end') turn = false;
    if (event.type === 'step/start') step = true;
    if (event.type === 'step/end') step = false;
    if (event.type === 'job/registered') { if (jobs.has(event.data.jobId)) fail('duplicate historical job registration'); jobs.set(event.data.jobId, 'live'); }
    if (event.type === 'job/settled') {
      if (!terminal.has(event.data.status)) fail('invalid terminal job status');
      if (jobs.get(event.data.jobId) !== 'live') fail('terminal job must have its paired registration');
      jobs.set(event.data.jobId, 'settled');
    }
  }
  if (turn || step || [...jobs.values()].includes('live')) fail('finish or stop live turns/jobs before handoff; OS processes cannot migrate');
}

/** Fold actual durable inbox splices, preserving order and identified messages verbatim. */
export function nativeParkedQueues(snapshot: NativeSnapshot): NativeQueue[] {
  const queues: Record<NativeQueue['target'], any[]> = { 'next-turn': [], 'next-step': [] };
  for (const event of snapshot.events) if (event.type === 'agent/inbox/spliced') {
    const { target, start, removedCount = 0, inserted } = event.data;
    if (!(target === 'next-turn' || target === 'next-step') || !Number.isSafeInteger(start) || !Number.isSafeInteger(removedCount) || start < 0 || removedCount < 0 || !Array.isArray(inserted)) fail('invalid durable inbox splice');
    const pending = queues[target as NativeQueue['target']];
    if (start > pending.length || removedCount > pending.length - start) fail('inbox splice outside queue');
    pending.splice(start, removedCount, ...structuredClone(inserted));
  }
  return (['next-step', 'next-turn'] as const).filter(target => queues[target].length).map(target => ({ sessionId: snapshot.header.id, target, messages: queues[target] }));
}

export function validateNativeAutonomy(root: NativeSnapshot, bundle: NativeAutonomyBundle): void {
  if (bundle?.schema !== 1 || !bundle.rootId || !Array.isArray(bundle.children) || !Array.isArray(bundle.queues) || !Array.isArray(bundle.schedules)) fail('unsupported autonomy packet');
  if (bundle.children.length > 64 || bundle.schedules.length > 256 || Buffer.byteLength(JSON.stringify(bundle)) > 12 * 1024 * 1024) fail('autonomy packet exceeds bounds');
  if (root.header.id !== bundle.rootId) fail('autonomy root must match the snapshot canonical header ID');
  const sessions = new Map<string, NativeSnapshot>([[bundle.rootId, root]]);
  for (const child of bundle.children) {
    if (sessions.has(child.header.id)) fail('duplicate child identity');
    sessions.set(child.header.id, child);
  }
  for (const [id, snapshot] of sessions) {
    assertNativeAutonomyIdle(snapshot);
    if (id !== bundle.rootId) {
      if (!snapshot.header.parentSession || !sessions.has(snapshot.header.parentSession)) fail('child parent log is missing');
      const own = snapshot.events.slice(snapshot.inheritedEventCount);
      const descriptor = own.find(e => e.type === 'subagent/descriptor')?.data;
      if (descriptor?.version !== 3 || !['continuable', 'one-shot'].includes(descriptor.mode) || typeof descriptor.provider !== 'string') fail('child needs a supported durable descriptor');
      if (descriptor.mode === 'continuable' && typeof descriptor.label !== 'string') fail('continuable child label is missing');
      if (snapshot.header.origin !== 'subagent') fail('child origin must be subagent');
      const parent = sessions.get(snapshot.header.parentSession)!;
      const catalog = parent.events.slice(parent.inheritedEventCount).find(e => e.type === 'subagent/catalog' && e.data.childId === id)?.data;
      if (!catalog || catalog.mode !== descriptor.mode || catalog.childCreatedAt !== snapshot.header.createdAt) fail('parent catalog does not identify child');
      const lineage = new Set([id]); let ancestor = snapshot.header.parentSession;
      while (ancestor !== bundle.rootId) {
        if (lineage.has(ancestor)) fail('cyclic child lineage'); lineage.add(ancestor);
        ancestor = sessions.get(ancestor)?.header.parentSession!;
        if (!ancestor) fail('child lineage does not reach root');
      }
    }
    for (const event of snapshot.events.slice(snapshot.inheritedEventCount)) if (event.type === 'subagent/catalog' && event.data.mode !== 'external' && !sessions.has(event.data.childId)) fail('catalog child log is missing');
  }
  const messageIds = new Set<string>();
  for (const queue of bundle.queues) {
    if (!sessions.has(queue.sessionId) || !['next-turn', 'next-step'].includes(queue.target) || !Array.isArray(queue.messages)) fail('queue has foreign owner or target');
    for (const message of queue.messages) {
      if (typeof message?.id !== 'string' || messageIds.has(message.id)) fail('queue message ID is missing or duplicated');
      messageIds.add(message.id);
    }
  }
  const scheduleIds = new Set<string>();
  for (const schedule of bundle.schedules) {
    if (!schedule.involvedSessionIds?.includes(bundle.rootId) && !(schedule.target?.kind === 'session' && schedule.target.sessionId === bundle.rootId)) fail('schedule is unrelated to root');
    if (schedule.executionActive) fail('finish or stop queued/running schedule execution before handoff');
    if (scheduleIds.has(schedule.id)) fail('duplicate schedule identity'); scheduleIds.add(schedule.id);
  }
  for (const goal of bundle.goals ?? []) if (!sessions.has(goal.sessionId) || !goal.adapter || !Number.isSafeInteger(goal.version)) fail('invalid goal extension');
}

/** Remap only fields owned by the session/subagent schemas. Never recurse into arbitrary text/tool payloads. */
export function remapNativeStructure(snapshot: NativeSnapshot, ids: Record<string, string>): NativeSnapshot {
  const copy = structuredClone(snapshot);
  copy.header = { ...copy.header, id: (ids[copy.header.id] ?? copy.header.id) as never,
    ...(copy.header.parentSession && ids[copy.header.parentSession] ? { parentSession: ids[copy.header.parentSession] as never } : {}) };
  for (const event of copy.events) if (event.seq >= copy.inheritedEventCount && event.type === 'subagent/catalog' && Object.hasOwn(ids, event.data.childId)) event.data.childId = ids[event.data.childId];
  return copy;
}
export function planNativeAutonomy(bundle: NativeAutonomyBundle, localRootId: string, ids?: Record<string, string>): NativeAutonomyPlan {
  const mapping = ids ?? Object.fromEntries([[bundle.rootId, localRootId], ...bundle.children.map(child => [child.header.id, randomUUID()])]);
  if (mapping[bundle.rootId] !== localRootId || new Set(Object.values(mapping)).size !== Object.keys(mapping).length || bundle.children.some(child => !mapping[child.header.id])) fail('invalid fixed local identities');
  const agentAliases: Record<string, string> = { ...mapping };
  for (const alias of Object.keys(bundle.agentAliases ?? {})) {
    const seen = new Set<string>(); let id = alias;
    while (!Object.hasOwn(mapping, id)) {
      if (seen.has(id)) fail('cyclic historical agent alias'); seen.add(id);
      const next = bundle.agentAliases?.[id]; if (!next || next === id) fail('alias points outside the imported tree'); id = next;
    }
    agentAliases[alias] = mapping[id];
  }
  return { bundle: structuredClone(bundle), ids: { ...mapping }, children: bundle.children.map(child => remapNativeStructure(child, mapping)),
    agentAliases, aliases: `Imported subagent identities (historical text is unchanged). Use the new IDs with list_agents/send_message:\n${JSON.stringify(agentAliases)}` };
}
export function canonicalNativeStructure(snapshot: NativeSnapshot, plan: NativeAutonomyPlan): NativeSnapshot {
  return remapNativeStructure(snapshot, canonicalNativeIds(plan));
}
function canonicalNativeIds(plan: NativeAutonomyPlan): Record<string, string> {
  const inverse = Object.fromEntries(Object.entries(plan.ids).map(([oldId, localId]) => [localId, oldId]));
  const mapping = { ...Object.fromEntries(Object.entries(plan.agentAliases ?? plan.ids).map(([alias, id]) => [alias, inverse[id] ?? id])), ...inverse };
  for (const canonical of Object.keys(plan.ids)) mapping[canonical] = canonical;
  return mapping;
}
export function remapNativeAutonomy(bundle: NativeAutonomyBundle, mapping: Record<string, string>): NativeAutonomyBundle {
  const copy = structuredClone(bundle);
  copy.rootId = mapping[copy.rootId] ?? copy.rootId;
  copy.children = copy.children.map(child => remapNativeStructure(child, mapping));
  for (const queue of copy.queues) queue.sessionId = mapping[queue.sessionId] ?? queue.sessionId;
  for (const schedule of copy.schedules) {
    schedule.involvedSessionIds = schedule.involvedSessionIds.map(id => mapping[id] ?? id);
    if (schedule.target.sessionId) schedule.target.sessionId = mapping[schedule.target.sessionId] ?? schedule.target.sessionId;
  }
  for (const goal of copy.goals ?? []) goal.sessionId = mapping[goal.sessionId] ?? goal.sessionId;
  copy.agentAliases = { ...Object.fromEntries(Object.entries(copy.agentAliases ?? {}).map(([alias, id]) => [alias, mapping[id] ?? id])), ...mapping };
  return copy;
}
export function canonicalNativeAutonomy(bundle: NativeAutonomyBundle, plan: NativeAutonomyPlan): NativeAutonomyBundle {
  return remapNativeAutonomy(bundle, canonicalNativeIds(plan));
}
/** Compare only after identity normalization. Existing child logs/attachments are immutable prefixes too. */
export function nativeCheckpointEvents(snapshot: NativeSnapshot, remote: NativeSnapshot): NativeSnapshot['events'] {
  if (snapshot.header.id !== remote.header.id) fail('checkpoint root is not the authority canonical identity');
  if (nativeDigest(snapshot.events.slice(0, remote.events.length)) !== nativeDigest(remote.events)) fail('Native history diverged; both copies retained');
  const previous = (remote as NativeAutonomySnapshot).autonomy, next = (snapshot as NativeAutonomySnapshot).autonomy;
  if (previous) {
    if (!next || next.rootId !== previous.rootId) fail('checkpoint cannot omit or rename the existing subtree');
    for (const child of previous.children) {
      const current = next.children.find(c => c.header.id === child.header.id);
      if (!current) fail('checkpoint cannot omit an existing child log');
      const immutable = (s: NativeSnapshot) => [s.header.id, s.header.parentSession, s.header.createdAt, s.header.origin, s.header.delegationDepth, s.header.isSeeded, s.inheritedEventCount];
      if (nativeDigest(immutable(current)) !== nativeDigest(immutable(child)) || nativeDigest(current.events.slice(0, child.events.length)) !== nativeDigest(child.events)) fail('child history or immutable metadata diverged; both copies retained');
      for (const file of child.files) if (!current.files.some(f => nativeDigest(f) === nativeDigest(file))) fail('checkpoint cannot omit or change an existing child attachment');
    }
  }
  return snapshot.events.slice(remote.events.length);
}
/** Tool-argument alias adapter; no rewriting of messages, code, prompts or tool result strings. */
export function nativeAutonomyAgentId(plan: NativeAutonomyPlan, id: string): string {
  if (Object.hasOwn(plan.agentAliases ?? plan.ids, id)) return (plan.agentAliases ?? plan.ids)[id];
  if (Object.values(plan.ids).includes(id)) return id;
  return fail('agent identity is outside this imported subtree');
}

export async function captureNativeSchedules(api: NativeScheduleApi, rootId: string): Promise<NativeSchedule[]> {
  const schedules: NativeSchedule[] = [];
  for (let offset = 0;;) {
    const page = await api.list({ limit: 500, offset });
    schedules.push(...page.items.filter(s => s.involvedSessionIds.includes(rootId) || s.target.kind === 'session' && s.target.sessionId === rootId));
    offset += page.items.length;
    if (offset >= page.total) return structuredClone(schedules);
    if (!page.items.length) fail('incomplete schedule catalog');
  }
}
export async function pauseNativeSchedules(api: NativeScheduleApi, schedules: NativeSchedule[]): Promise<void> {
  for (const schedule of schedules) {
    const current = await api.view({ id: schedule.id });
    if ('code' in current) fail(`schedule unavailable: ${schedule.id}`);
    if (current.executionActive) fail('finish or stop schedule execution before handoff');
    const identity = (s: NativeSchedule) => [s.id, s.title, s.prompt, s.kind, s.scheduledAt, s.target, s.everySeconds, s.time, s.timeZone, s.weekdays, s.expression, s.rrule];
    if (nativeDigest(identity(current)) !== nativeDigest(identity(schedule)) || current.status === 'ended' && schedule.status !== 'ended') fail(`schedule changed during pause: ${schedule.id}`);
    if (current.status !== 'active') continue;
    const result = await api.edit({ id: schedule.id, action: 'update', patch: { active: false }, expectedUpdatedAt: schedule.updatedAt ?? null });
    if ('code' in result || result.status !== 'paused') fail(`schedule changed during pause: ${schedule.id}`);
  }
}

function scheduleRequest(schedule: NativeSchedule, plan: NativeAutonomyPlan) {
  if (schedule.target.kind !== 'session' || !schedule.target.sessionId || !plan.ids[schedule.target.sessionId]) fail('schedule destination needs explicit receiver review before resuming');
  const timing: Record<string, unknown> = { kind: schedule.kind === 'after' ? 'at' : schedule.kind };
  switch (schedule.kind) {
    case 'after': case 'at': timing.at = schedule.scheduledAt; break;
    case 'every': timing.every_seconds = schedule.everySeconds; break;
    case 'daily': timing.daily = { time: schedule.time, time_zone: schedule.timeZone }; break;
    case 'weekly': timing.weekly = { time: schedule.time, time_zone: schedule.timeZone, weekdays: schedule.weekdays }; break;
    case 'cron': timing.cron = { expression: schedule.expression, time_zone: schedule.timeZone }; break;
    case 'rrule': timing.rrule = schedule.rrule; break;
  }
  return { title: schedule.title, prompt: schedule.prompt, timing, target: { kind: 'session' as const, sessionId: plan.ids[schedule.target.sessionId] } };
}
async function scheduleCatalog(api: NativeScheduleApi): Promise<NativeSchedule[]> {
  if (api.catalog) return api.catalog();
  const all: NativeSchedule[] = [];
  for (let offset = 0; offset < 10_000;) {
    const page = await api.list({ limit: 500, offset }); all.push(...page.items); offset += page.items.length;
    if (offset >= page.total) return all;
    if (!page.items.length) fail('incomplete schedule catalog');
  }
  return fail('schedule reconciliation catalog exceeds safe query bound');
}
function scheduleMatches(schedule: NativeSchedule, request: any): boolean {
  if (schedule.title !== request.title || schedule.prompt !== request.prompt || nativeDigest(schedule.target) !== nativeDigest(request.target) || schedule.kind !== request.timing.kind) return false;
  const timing = request.timing;
  switch (schedule.kind) {
    case 'at': return schedule.scheduledAt === timing.at;
    case 'every': return schedule.everySeconds === timing.every_seconds;
    case 'daily': return schedule.time === timing.daily?.time && schedule.timeZone === timing.daily?.time_zone;
    case 'weekly': return schedule.time === timing.weekly?.time && schedule.timeZone === timing.weekly?.time_zone && nativeDigest(schedule.weekdays) === nativeDigest(timing.weekly?.weekdays);
    case 'cron': return schedule.expression === timing.cron?.expression && schedule.timeZone === timing.cron?.time_zone;
    case 'rrule': return schedule.rrule === timing.rrule;
    default: return false;
  }
}

export interface Receipt { state: 'attempting' | 'done' | 'uncertain' | 'not-accepted' | 'absent' | 'expired'; localId?: string; error?: string; code?: string; request?: NativeWorkRequest; retryApproved?: boolean; explicitEnable?: boolean }
interface SourceRecovery { operationId: string; hostId: string; phase: 'fenced' | 'restoring' | 'parked' }
interface AutonomyEntry { plan: NativeAutonomyPlan; imported: boolean; receipts: Record<string, Receipt>; sourceRecovery?: SourceRecovery; receiptHistory?: Record<string, Receipt[]> }
interface SourceCut { snapshot: NativeSnapshot; bundle: NativeAutonomyBundle; complete: boolean; original?: { snapshot: NativeSnapshot; bundle: NativeAutonomyBundle } }
export interface NativeAutonomySource {
  snapshot(sessionId: string): Promise<NativeSnapshot>;
  runtime(sessionId: string): { status?: string; jobs?: { owner?: string; status: string }[] };
  /** Compare IDs/order with expected, take+clear durably; an already empty queue is an idempotent replay. */
  clearInbox(sessionId: string, expected: NativeQueue[]): Promise<void>;
  /** Native workspace archiveSession(root), with no stopActivity override; refuses live physical work. */
  archiveSession(sessionId: string): Promise<void>;
  schedule?: NativeScheduleApi;
  goals?: Record<string, NativeGoalAdapter>;
}
/** Intent is durable BEFORE acceptance. Unknown outcomes stop replay; they never silently duplicate execution. */
export class NativeAutonomyJournal {
  private entries: Record<string, AutonomyEntry>;
  private sources: Record<string, SourceCut>;
  private savedInput: Record<string, unknown[]>;
  private busy = new Set<string>();
  private readonly runId = randomUUID();
  constructor(readonly path: string) {
    const state = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { schema: 1, entries: {} };
    if (state.schema !== 1 || !state.entries || typeof state.entries !== 'object') throw new Error('Unsupported native autonomy journal; preserve for recovery');
    this.entries = state.entries;
    this.sources = state.sources ?? {};
    this.savedInput = state.savedInput ?? {};
  }
  private save() {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`, fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify({ schema: 1, entries: this.entries, sources: this.sources, savedInput: this.savedInput })); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, this.path); const dir = openSync(dirname(this.path), 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
  }
  stage(sessionId: string, bundle: NativeAutonomyBundle, ids?: Record<string, string>, placement?: NativeRuntimePlacement): NativeAutonomyPlan {
    const existing = this.entries[sessionId];
    if (existing) { if (nativeDigest(existing.plan.bundle) !== nativeDigest(bundle)) fail('different autonomy packet already staged for this copy'); return structuredClone(existing.plan); }
    const plan = planNativeAutonomy(bundle, sessionId, ids);
    if (placement) plan.placement = structuredClone(placement);
    this.entries[sessionId] = { plan, imported: false, receipts: {} }; this.save(); return structuredClone(plan);
  }
  plan(sessionId: string): NativeAutonomyPlan | undefined { const entry = this.entries[sessionId]; return entry && structuredClone(entry.plan); }
  rootFor(id: string): string | undefined { return Object.entries(this.entries).find(([, entry]) => Object.values(entry.plan.ids).includes(id))?.[0]; }
  linkDescendant(rootId: string, parentId: string, childId: string): void {
    const entry = this.entries[rootId]; if (!entry || !Object.values(entry.plan.ids).includes(parentId)) fail('parent is outside imported subtree');
    const owner = this.rootFor(childId); if (owner && owner !== rootId) fail('child already belongs to another shared subtree');
    if (!Object.values(entry.plan.ids).includes(childId)) {
      entry.plan.ids[Object.hasOwn(entry.plan.ids, childId) ? randomUUID() : childId] = childId;
      entry.plan.agentAliases ??= { ...entry.plan.ids }; entry.plan.agentAliases[childId] = childId;
      entry.plan.aliases = `Imported subagent identities (historical text is unchanged). Use the new IDs with list_agents/send_message:\n${JSON.stringify(entry.plan.agentAliases)}`;
      this.save();
    }
  }
  detach(sessionId: string): void { delete this.entries[sessionId]; this.save(); }
  retainInput(sessionId: string, messages: unknown[]): void {
    if (!messages.length) return;
    const saved = this.savedInput[sessionId] ??= [];
    for (const message of messages) if (!saved.some(old => nativeDigest(old) === nativeDigest(message))) saved.push(structuredClone(message));
    this.save();
  }
  retainedInput(sessionId: string): unknown[] { return structuredClone(this.savedInput[sessionId] ?? []); }
  /** Persist every new child's stable identity before constructing a remotely replayable operation. */
  prepareExport(sessionId: string, canonicalRootId: string, captured: NativeAutonomyBundle): NativeAutonomyPlan {
    if (!this.entries[sessionId]) this.stage(sessionId, captured, Object.fromEntries([captured.rootId, ...captured.children.map(c => c.header.id)].map(id => [id, id === captured.rootId ? sessionId : id])));
    const entry = this.entries[sessionId];
    if (entry.plan.bundle.rootId !== canonicalRootId) {
      const oldRoot = entry.plan.bundle.rootId;
      const bundle = remapNativeAutonomy(canonicalNativeAutonomy(entry.plan.bundle, entry.plan), { [oldRoot]: canonicalRootId });
      const ids = { ...entry.plan.ids }; delete ids[oldRoot]; ids[canonicalRootId] = sessionId;
      const placement = entry.plan.placement;
      entry.plan = { ...planNativeAutonomy(bundle, sessionId, ids), ...(placement ? { placement } : {}) }; this.save();
    }
    const pending = captured.children.filter(child => !Object.values(entry.plan.ids).includes(child.header.id) && !Object.hasOwn(entry.plan.ids, child.header.id));
    while (pending.length) {
      const index = pending.findIndex(child => child.header.parentSession && (Object.values(entry.plan.ids).includes(child.header.parentSession) || Object.hasOwn(entry.plan.ids, child.header.parentSession)));
      if (index < 0) fail('new child parent is outside the captured tree');
      const [child] = pending.splice(index, 1);
      const parent = entry.plan.ids[child.header.parentSession!] ?? child.header.parentSession!;
      this.linkDescendant(sessionId, parent, child.header.id);
    }
    return structuredClone(entry.plan);
  }
  /** Keep never-resumed input/tasks in the next handoff even though they have no live inbox/timer yet. */
  exportBundle(sessionId: string, captured: NativeAutonomyBundle): NativeAutonomyBundle {
    const entry = this.entries[sessionId]; if (!entry) return structuredClone(captured);
    const bundle = canonicalNativeAutonomy(captured, entry.plan);
    for (const queue of entry.plan.bundle.queues) {
      const messages = queue.messages.filter(message => entry.receipts[`queue/${message.id}`]?.state !== 'done');
      const existing = bundle.queues.find(q => q.sessionId === queue.sessionId && q.target === queue.target);
      const present = new Set(bundle.queues.flatMap(q => q.messages.map(m => m.id)));
      const retained = messages.filter(message => !present.has(message.id));
      if (existing) existing.messages.push(...structuredClone(retained));
      else if (retained.length) bundle.queues.push({ ...structuredClone(queue), messages: structuredClone(retained) });
    }
    for (const schedule of entry.plan.bundle.schedules) if (!bundle.schedules.some(s => s.id === schedule.id)) {
      const receipt = entry.receipts[`schedule/${schedule.id}`];
      // Retain the original record as inert history after explicit local recreation.
      bundle.schedules.push({ ...structuredClone(schedule), ...(receipt?.state === 'done' ? { status: 'ended' as const } : {}) });
    }
    for (const [key, receipt] of Object.entries(entry.receipts)) if (receipt.state === 'attempting' || receipt.state === 'uncertain') fail(`unconfirmed operation ${key}; reconcile acceptance before another handoff`);
    return bundle;
  }
  mergeFrozenWork(sessionId: string, operationId: string, captured: NativeAutonomyBundle): void {
    const entry = this.entries[sessionId], cut = this.sources[operationId]; if (!entry || !cut) fail('freeze backup is unavailable');
    const current = this.exportBundle(sessionId, captured), frozen = canonicalNativeAutonomy(cut.bundle, entry.plan);
    for (const queue of frozen.queues) {
      const present = new Set(current.queues.flatMap(q => q.messages.map(m => m.id)));
      const missing = queue.messages.filter(m => !present.has(m.id));
      const target = current.queues.find(q => q.sessionId === queue.sessionId && q.target === queue.target);
      if (target) target.messages.push(...structuredClone(missing)); else if (missing.length) current.queues.push({ ...queue, messages: structuredClone(missing) });
    }
    for (const schedule of current.schedules) schedule.resumeIntent ??= frozen.schedules.find(s => s.id === schedule.id)?.resumeIntent ?? cut.original?.bundle.schedules.find(s => s.id === schedule.id)?.status ?? schedule.status;
    for (const schedule of frozen.schedules) if (!current.schedules.some(s => s.id === schedule.id)) fail('restore the existing frozen schedule before rollback');
    for (const goal of frozen.goals ?? []) if (!current.goals?.some(g => g.adapter === goal.adapter && g.sessionId === goal.sessionId)) fail('restore the frozen goal before rollback');
    entry.plan.bundle = current; entry.imported = true; this.save();
  }
  async inspectWork(sessionId: string, key: string, host: NativeAutonomyHost) {
    const entry = this.entries[sessionId], receipt = entry?.receipts[key]; if (!receipt) fail('work receipt not found');
    if (['done', 'expired', 'not-accepted', 'absent'].includes(receipt.state)) return { state: receipt.state, localId: receipt.localId, candidates: [] as string[], canConfirmAbsent: receipt.state === 'absent', request: receipt.request };
    const work = receipt.request; if (!work) return { state: 'unknown', candidates: [] as string[], canConfirmAbsent: false, reason: 'Legacy receipt has no saved request; no automatic replay', request: work };
    if (this.busy.has(sessionId)) fail('wait for the current acceptance attempt before querying');
    if (host.queryWork) {
      const evidence = await host.queryWork(structuredClone(work));
      if (evidence.requestDigest !== work.requestDigest) fail('reconciliation proof does not match the saved request');
      if (evidence.state === 'accepted') { receipt.state = 'done'; receipt.localId = evidence.localId; this.save(); return { state: 'done', localId: evidence.localId, candidates: [] as string[], canConfirmAbsent: false, request: work }; }
      if (evidence.state === 'absent' && evidence.settled) return { state: 'absent', candidates: [] as string[], canConfirmAbsent: true, request: work };
      if (evidence.state === 'conflict') return { state: 'conflict', candidates: [] as string[], canConfirmAbsent: false, request: work };
    }
    if (work.kind !== 'schedule-create' || !host.schedule) return { state: 'unknown', candidates: [] as string[], canConfirmAbsent: false, reason: 'Owning service must supply exact settled acceptance evidence', request: work };
    const matching = (await scheduleCatalog(host.schedule)).filter(s => !work.baselineIds?.includes(s.id) && scheduleMatches(s, work.payload));
    const candidates = matching.filter(s => s.createdAt && Date.parse(s.createdAt) >= Date.parse(work.startedAt) && Date.parse(s.createdAt) <= Date.parse(work.settledAt ?? new Date().toISOString()));
    const canConfirmAbsent = matching.length === 0 && !!work.settledAt && !!host.schedule.catalog;
    return { state: matching.length > 1 ? 'conflict' : matching.length !== candidates.length ? 'unknown' : candidates.length === 1 ? 'candidate' : canConfirmAbsent ? 'absent' : 'unknown', candidates: candidates.map(s => s.id), canConfirmAbsent, request: work };
  }
  async reconcileWork(sessionId: string, key: string, host: NativeAutonomyHost, decision: { candidateId?: string; confirmAbsent?: boolean }) {
    const query = await this.inspectWork(sessionId, key, host), receipt = this.entries[sessionId].receipts[key];
    if (query.state === 'done') return query;
    if (decision.candidateId) {
      if (query.state !== 'candidate' || query.candidates.length !== 1 || query.candidates[0] !== decision.candidateId || !host.schedule || !receipt.request) fail('candidate is not a unique exact request/target/time match; keep the receipt unresolved');
      const candidate = await host.schedule.view({ id: decision.candidateId });
      if ('code' in candidate || !scheduleMatches(candidate, receipt.request.payload) || !candidate.createdAt || Date.parse(candidate.createdAt) < Date.parse(receipt.request.startedAt) || Date.parse(candidate.createdAt) > Date.parse(receipt.request.settledAt ?? new Date().toISOString()) || receipt.request.baselineIds?.includes(candidate.id)) fail('candidate changed during reconciliation');
      receipt.state = 'done'; receipt.localId = candidate.id; this.save();
    } else if (decision.confirmAbsent) {
      if (!query.canConfirmAbsent || query.state !== 'absent') fail('absence is not proven for the settled saved request; retry remains blocked');
      receipt.state = 'absent'; this.save();
    }
    return this.inspectWork(sessionId, key, host);
  }
  async retryWork(sessionId: string, key: string, host: NativeAutonomyHost): Promise<void> {
    const receipt = this.entries[sessionId]?.receipts[key];
    if (!receipt || !['not-accepted','absent'].includes(receipt.state)) fail('confirm non-acceptance or proven absence before an explicit retry');
    receipt.retryApproved = true; this.save();
    const schedule = key.startsWith('schedule/') ? key.slice(9) : undefined;
    await this.resume(sessionId, host, { queues: key.startsWith('queue/'), goals: key.startsWith('goal/'), schedules: schedule ? [schedule] : [], activatePaused: schedule && receipt.explicitEnable ? [schedule] : [], onlyKeys: [key] });
  }
  sourcePacket(operationId: string) { const cut = this.sources[operationId]; return cut && structuredClone(cut); }
  rememberSource(operationId: string, snapshot: NativeSnapshot, bundle: NativeAutonomyBundle): void {
    if (this.sources[operationId]) return;
    validateNativeAutonomy(snapshot, bundle);
    const original = { snapshot: structuredClone(snapshot), bundle: structuredClone(bundle) };
    this.sources[operationId] = { ...structuredClone(original), complete: false, original }; this.save();
  }
  rememberFrozen(operationId: string, frozen: { snapshot: NativeSnapshot; bundle: NativeAutonomyBundle }): void {
    const cut = this.sources[operationId]; if (!cut) fail('source backup must precede freezing');
    for (const schedule of frozen.bundle.schedules) schedule.resumeIntent ??= cut.original?.bundle.schedules.find(s => s.id === schedule.id)?.resumeIntent ?? cut.original?.bundle.schedules.find(s => s.id === schedule.id)?.status ?? schedule.status;
    cut.snapshot = structuredClone(frozen.snapshot); cut.bundle = structuredClone(frozen.bundle); cut.complete = true; this.save();
  }
  fenceSourceRecovery(sessionId: string, hostId: string, operationId: string): void {
    const cut = this.sources[operationId]; if (!cut) fail('frozen source backup is unavailable');
    if (this.entries[sessionId]?.sourceRecovery) return;
    const ids = Object.fromEntries([cut.bundle.rootId, ...cut.bundle.children.map(c => c.header.id)].map(id => [id, id]));
    this.entries[sessionId] = { plan: planNativeAutonomy(cut.bundle, sessionId, ids), imported: false, receipts: {}, sourceRecovery: { hostId, operationId, phase: 'fenced' } }; this.save();
  }
  sourceRecoveries() { return Object.entries(this.entries).filter(([, entry]) => entry.sourceRecovery).map(([sessionId, entry]) => ({ sessionId, ...entry.sourceRecovery!, retainedInput: this.savedInput[sessionId]?.length ?? 0, ...this.status(sessionId) })); }
  sourceRecovery(sessionId: string) { const recovery = this.entries[sessionId]?.sourceRecovery; return recovery && structuredClone(recovery); }
  restoringSource(sessionId: string): void {
    const recovery = this.entries[sessionId]?.sourceRecovery; if (!recovery) fail('cancel the remote enrollment before source recovery');
    recovery.phase = 'restoring'; this.save();
  }
  parkSourceRecovery(sessionId: string, current: NativeAutonomyBundle): void {
    const entry = this.entries[sessionId]; if (!entry?.sourceRecovery) fail('source recovery not found');
    const cut = this.sources[entry.sourceRecovery.operationId];
    if (current.rootId !== sessionId) fail('source recovery identity changed');
    const messages = new Set(current.queues.flatMap(q => q.messages.map(m => m.id)));
    for (const queue of cut.bundle.queues) {
      const missing = queue.messages.filter(message => !messages.has(message.id));
      const existing = current.queues.find(q => q.sessionId === queue.sessionId && q.target === queue.target);
      if (existing) existing.messages.push(...structuredClone(missing));
      else if (missing.length) current.queues.push({ ...structuredClone(queue), messages: structuredClone(missing) });
      for (const message of missing) messages.add(message.id);
    }
    for (const schedule of cut.bundle.schedules) if (!current.schedules.some(s => s.id === schedule.id)) fail('source schedule missing during recovery; original backup retained');
    for (const schedule of current.schedules) schedule.resumeIntent ??= cut.original?.bundle.schedules.find(s => s.id === schedule.id)?.resumeIntent ?? cut.original?.bundle.schedules.find(s => s.id === schedule.id)?.status ?? schedule.status;
    for (const goal of cut.bundle.goals ?? []) if (!current.goals?.some(g => g.adapter === goal.adapter && g.sessionId === goal.sessionId)) fail('source goal missing during recovery; original backup retained');
    const ids = Object.fromEntries([current.rootId, ...current.children.map(c => c.header.id)].map(id => [id, id]));
    entry.plan = planNativeAutonomy(current, sessionId, ids); entry.imported = true; entry.sourceRecovery.phase = 'parked'; this.save();
  }
  async freezeSource(snapshot: NativeSnapshot, bundle: NativeAutonomyBundle, source: NativeAutonomySource, operationId: string): Promise<{ snapshot: NativeSnapshot; bundle: NativeAutonomyBundle }> {
    let cut = this.sources[operationId];
    if (cut?.complete) return { snapshot: structuredClone(cut.snapshot), bundle: structuredClone(cut.bundle) };
    if (!cut) {
      validateNativeAutonomy(snapshot, bundle);
      for (const session of [snapshot, ...bundle.children]) assertNativeAutonomyIdle(session, source.runtime(session.header.id));
      const sortedQueues = (queues: NativeQueue[]) => [...queues].sort((a, b) => `${a.sessionId}/${a.target}`.localeCompare(`${b.sessionId}/${b.target}`));
      if (nativeDigest(sortedQueues([snapshot, ...bundle.children].flatMap(nativeParkedQueues))) !== nativeDigest(sortedQueues(bundle.queues))) fail('captured queues do not match the source logs');
      // Durable backup precedes schedule pause, inbox take/clear and native recursive archive.
      this.rememberSource(operationId, snapshot, bundle); cut = this.sources[operationId];
    }
    if (cut.bundle.schedules.length) { if (!source.schedule) fail('source schedule service unavailable'); await pauseNativeSchedules(source.schedule, cut.bundle.schedules); }
    for (let i = 0; i < (cut.bundle.goals?.length ?? 0); i++) {
      const goal = cut.bundle.goals![i], adapter = source.goals?.[goal.adapter];
      if (!adapter?.pause) fail(`source goal pause adapter unavailable: ${goal.adapter}`);
      cut.bundle.goals![i] = await adapter.pause(goal, goal.sessionId, `${operationId}/goal/${goal.sessionId}/${goal.adapter}`); this.save();
    }
    for (const id of [cut.bundle.rootId, ...cut.bundle.children.map(c => c.header.id)]) {
      const current = await source.snapshot(id); assertNativeAutonomyIdle(current, source.runtime(id));
      await source.clearInbox(id, structuredClone(cut.bundle.queues.filter(q => q.sessionId === id)));
    }
    await source.archiveSession(cut.bundle.rootId);
    const root = await source.snapshot(cut.bundle.rootId), children: NativeSnapshot[] = [];
    for (const original of cut.bundle.children) children.push(await source.snapshot(original.header.id));
    for (const session of [root, ...children]) { assertNativeAutonomyIdle(session, source.runtime(session.header.id)); if (nativeParkedQueues(session).length) fail('source inbox was not durably drained'); }
    cut.snapshot = root; cut.bundle.children = children; cut.complete = true; this.save();
    return { snapshot: structuredClone(root), bundle: structuredClone(cut.bundle) };
  }
  status(sessionId: string) {
    const entry = this.entries[sessionId];
    return entry && { imported: entry.imported, children: Object.values(entry.plan.ids).filter(id => id !== sessionId), aliases: entry.plan.agentAliases ?? entry.plan.ids,
      goals: (entry.plan.bundle.goals ?? []).map(g => ({ sessionId: g.sessionId, adapter: g.adapter, phase: (g.state as any)?.phase })),
      queues: entry.plan.bundle.queues.reduce((n, q) => n + q.messages.filter(m => entry.receipts[`queue/${m.id}`]?.state !== 'done').length, 0), schedules: entry.plan.bundle.schedules.map(s => ({ id: s.id, title: s.title, status: s.status, resumeIntent: s.resumeIntent ?? s.status, migrationState: s.migrationState })), receipts: structuredClone(entry.receipts) };
  }
  async preflight(sessionId: string, host: NativeAutonomyHost): Promise<void> {
    const entry = this.entries[sessionId]; if (!entry) fail('autonomy packet is not staged');
    await host.preflight(structuredClone(entry.plan));
    for (const goal of entry.plan.bundle.goals ?? []) { const adapter = host.goals?.[goal.adapter]; if (!adapter) fail(`goal adapter unavailable: ${goal.adapter}`); await adapter.preflight(goal); }
  }
  async importParked(sessionId: string, host: NativeAutonomyHost): Promise<void> {
    const entry = this.entries[sessionId]; if (!entry || entry.imported) return;
    await this.preflight(sessionId, host);
    await host.importParked(sessionId, structuredClone(entry.plan), `import/${sessionId}`);
    for (const goal of entry.plan.bundle.goals ?? []) await host.goals![goal.adapter].importParked(goal, entry.plan.ids[goal.sessionId], `import/${sessionId}/goal/${goal.sessionId}/${goal.adapter}`);
    entry.imported = true; this.save();
  }
  private async attempt(entry: AutonomyEntry, key: string, operation: () => Promise<string | void>, request: Omit<NativeWorkRequest, 'startedAt' | 'settledAt' | 'requestDigest' | 'runId'>, explicitEnable = false) {
    const receipt = entry.receipts[key];
    if (receipt?.state === 'done' || receipt?.state === 'expired') return;
    if (receipt && !receipt.retryApproved) fail(`unconfirmed operation ${key}; reconcile its acceptance before retrying`);
    if (receipt) { entry.receiptHistory ??= {}; (entry.receiptHistory[key] ??= []).push(structuredClone(receipt)); }
    const work: NativeWorkRequest = { ...structuredClone(request), startedAt: new Date().toISOString(), requestDigest: nativeDigest({ kind: request.kind, sessionId: request.sessionId, payload: request.payload }), runId: this.runId };
    entry.receipts[key] = { state: 'attempting', request: work, explicitEnable }; this.save();
    try { const localId = await operation(); work.settledAt = new Date().toISOString(); entry.receipts[key] = { state: 'done', request: work, ...(localId ? { localId } : {}) }; this.save(); }
    catch (error) {
      work.settledAt = new Date().toISOString();
      const e = error as { accepted?: boolean; code?: string; name?: string };
      const rejected = e?.accepted === false && typeof e.code === 'string' || e?.name === 'ScheduleInputError' && ['invalid_prompt','invalid_selector','invalid_rule','invalid_time_zone','not_future','time_out_of_range','frequency_too_high','subagent_session'].includes(e.code ?? '');
      entry.receipts[key] = { state: rejected ? 'not-accepted' : 'uncertain', request: work, code: e?.code, error: error instanceof Error ? error.message : String(error), explicitEnable }; this.save(); throw error;
    }
  }
  async resume(sessionId: string, host: NativeAutonomyHost, options: NativeResumeOptions): Promise<void> {
    const entry = this.entries[sessionId]; if (!entry?.imported) fail('parked import is not complete');
    if (this.busy.has(sessionId)) fail('resume is already in progress'); this.busy.add(sessionId);
    try {
      if (options.queues) for (const queue of entry.plan.bundle.queues) for (const message of queue.messages) if (!options.onlyKeys || options.onlyKeys.includes(`queue/${message.id}`)) await this.attempt(entry, `queue/${message.id}`, () => host.deliver(entry.plan.ids[queue.sessionId], queue.target, structuredClone(message)), { kind: 'queue', sessionId: entry.plan.ids[queue.sessionId], payload: { target: queue.target, message } });
      for (const id of new Set([...(options.schedules ?? []), ...(options.activatePaused ?? [])])) {
        const schedule = entry.plan.bundle.schedules.find(s => s.id === id); if (!schedule) fail('unknown staged schedule');
        const key = `schedule/${id}`, receipt = entry.receipts[key];
        if (receipt?.state === 'done' || receipt?.state === 'expired' || schedule.status === 'ended') continue;
        if (receipt && !receipt.retryApproved) fail(`unconfirmed operation ${key}; reconcile its acceptance before retrying`);
        const explicitEnable = options.activatePaused?.includes(id) === true;
        if ((schedule.resumeIntent ?? schedule.status) !== 'active' && !explicitEnable) continue;
        if ((schedule.kind === 'at' || schedule.kind === 'after') && Number.isFinite(Date.parse(schedule.scheduledAt)) && Date.parse(schedule.scheduledAt) <= Date.now()) {
          schedule.resumeIntent ??= schedule.status; schedule.migrationState = 'expired'; schedule.status = 'ended'; entry.receipts[key] = { state: 'expired', code: 'not_future', error: 'Expired one-shot retained without changing its target time' }; this.save(); continue;
        }
        if (!host.schedule) fail('schedule service unavailable');
        const request = scheduleRequest(schedule, entry.plan);
        const baseline = entry.sourceRecovery ? [] : (await scheduleCatalog(host.schedule)).map(s => s.id);
        await this.attempt(entry, key, async () => {
          if (!entry.sourceRecovery) return (await host.schedule!.create(request)).id;
          const current = await host.schedule!.view({ id });
          if ('code' in current || current.status !== 'paused' || current.target.kind !== 'session' || current.target.sessionId !== request.target.sessionId || current.updatedAt !== schedule.updatedAt) throw new NativeWorkNotAccepted('schedule_conflict', 'source schedule changed before explicit resume');
          const resumed = await host.schedule!.edit({ id, action: 'update', patch: { active: true }, expectedUpdatedAt: current.updatedAt ?? null });
          if ('code' in resumed || resumed.status !== 'active') throw new NativeWorkNotAccepted('schedule_conflict', 'source schedule resume conflicted');
          return resumed.id;
        }, { kind: entry.sourceRecovery ? 'schedule-update' : 'schedule-create', sessionId: request.target.sessionId, payload: request, baselineIds: baseline }, explicitEnable);
      }
      if (options.goals) for (const goal of entry.plan.bundle.goals ?? []) {
        const adapter = host.goals?.[goal.adapter]; if (!adapter) fail(`goal adapter unavailable: ${goal.adapter}`);
        const key = `goal/${goal.sessionId}/${goal.adapter}`;
        if (!options.onlyKeys || options.onlyKeys.includes(key)) await this.attempt(entry, key, () => adapter.resume(goal, entry.plan.ids[goal.sessionId], `resume/${sessionId}/goal/${goal.sessionId}/${goal.adapter}`), { kind: 'goal', sessionId: entry.plan.ids[goal.sessionId], payload: goal });
      }
    } finally { this.busy.delete(sessionId); }
  }
}

/** Public dsh-goal 0.2.2-rc.1 state. activation is process-local and excluded from every transfer. */
export interface NativeGoalView {
  id: string; revision: number; objective: string; phase: 'active' | 'paused' | 'blocked' | 'complete';
  maxGoalRounds: number; roundsStarted: number; createdAt: number; updatedAt: number;
  blockedReason?: { code: string; message: string }; activation: 'armed' | 'disarmed';
}
export type NativeDurableGoal = Omit<NativeGoalView, 'activation'>;
export interface NativeGoalsApi<Agent = unknown> {
  get(agent: Agent): NativeGoalView | undefined;
  pause(agent: Agent, ref: { id: string; revision: number }): NativeGoalView;
  resume(agent: Agent, ref: { id: string; revision: number }): NativeGoalView;
}
export const NATIVE_DSH_GOAL_ADAPTER = 'dsh-goal-v1';
function durableGoal(view: NativeGoalView | NativeDurableGoal): NativeDurableGoal {
  const copy = structuredClone(view) as Partial<NativeGoalView>;
  delete copy.activation;
  return copy as NativeDurableGoal;
}
function goalIdentity(goal: NativeDurableGoal): unknown[] {
  return [goal.id, goal.revision, goal.objective, goal.phase, goal.maxGoalRounds, goal.roundsStarted, goal.createdAt, goal.updatedAt, goal.blockedReason?.code, goal.blockedReason?.message];
}
function checkedGoal(state: NativeGoalState): NativeDurableGoal {
  const goal = state.state as NativeDurableGoal;
  if (state.adapter !== NATIVE_DSH_GOAL_ADAPTER || state.version !== 1 || !goal || typeof goal.id !== 'string' || !Number.isSafeInteger(goal.revision) || goal.revision < 1
    || !['active', 'paused', 'blocked', 'complete'].includes(goal.phase) || typeof goal.objective !== 'string' || !Number.isSafeInteger(goal.maxGoalRounds) || !Number.isSafeInteger(goal.roundsStarted)
    || Object.hasOwn(goal, 'activation')) fail('invalid durable dsh goal state');
  return goal;
}
export function captureNativeGoal<Agent>(api: NativeGoalsApi<Agent>, agent: Agent, sessionId: string): NativeGoalState | undefined {
  const view = api.get(agent);
  return view && { adapter: NATIVE_DSH_GOAL_ADAPTER, version: 1, sessionId, state: durableGoal(view) };
}
/** Uses audited public methods only. Cold-log reading is supplied by the host's real foldGoal/projection adapter. */
export function nativeDshGoalAdapter<Agent>(api: NativeGoalsApi<Agent>, options: {
  liveAgent(sessionId: string): Agent | undefined;
  readColdGoal(sessionId: string): Promise<NativeDurableGoal | undefined>;
}): NativeGoalAdapter {
  const live = (id: string) => { const agent = options.liveAgent(id); if (!agent) throw new NativeWorkNotAccepted('agent_not_live', 'resume the owning agent through its parent before resuming this goal'); return agent; };
  return {
    preflight: async state => { checkedGoal(state); },
    async pause(state, sessionId) {
      const expected = checkedGoal(state), agent = options.liveAgent(sessionId);
      if (!agent) {
        const cold = await options.readColdGoal(sessionId);
        if (!cold || nativeDigest(goalIdentity(cold)) !== nativeDigest(goalIdentity(expected))) fail('cold source goal changed before freeze');
        // There is no Agent/driver to arm. Keep its durable phase exact; recursive
        // native archive closes the source tree before this packet is published.
        return { ...state, state: durableGoal(cold), sourceMode: 'cold-log' };
      }
      const current = api.get(agent);
      if (!current || current.id !== expected.id) fail('source goal identity changed');
      let paused = current;
      if (current.phase === 'active') {
        if (current.revision !== expected.revision) fail('source goal revision changed before pause');
        paused = api.pause(agent, { id: expected.id, revision: expected.revision });
      } else if (current.revision !== expected.revision && !(expected.phase === 'active' && current.phase === 'paused' && current.revision === expected.revision + 1
        && current.objective === expected.objective && current.maxGoalRounds === expected.maxGoalRounds && current.roundsStarted === expected.roundsStarted)) fail('source goal revision changed before pause');
      if (paused.activation !== 'disarmed') fail('native goal pause did not disarm continuation');
      return { ...state, state: durableGoal(paused) };
    },
    async importParked(state, sessionId) {
      const expected = checkedGoal(state), restored = await options.readColdGoal(sessionId);
      if (!restored || nativeDigest(goalIdentity(restored)) !== nativeDigest(goalIdentity(expected))) fail('imported goal log does not match frozen goal state');
      const agent = options.liveAgent(sessionId);
      if (agent && api.get(agent)?.activation === 'armed') fail('imported goal unexpectedly armed; keep its writer gate closed');
      // No create/resume or agent activation: session-start begins disarmed.
    },
    async resume(state, sessionId) {
      const expected = checkedGoal(state), agent = live(sessionId), current = api.get(agent);
      if (!current || current.id !== expected.id || current.revision !== expected.revision) throw new NativeWorkNotAccepted('goal_revision_conflict', 'goal changed since import; review its current revision before resuming');
      if (current.phase === 'complete') return;
      api.resume(agent, { id: current.id, revision: current.revision });
    },
  };
}
