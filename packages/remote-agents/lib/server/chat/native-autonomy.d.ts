import { RemoteError } from '../core/domain.js';
import { type NativeSnapshot } from './native-protocol.js';
import type { NativeRuntimePlacement } from './native-placement.js';
export interface NativeQueue {
    sessionId: string;
    target: 'next-turn' | 'next-step';
    messages: any[];
}
export interface NativeSchedule {
    id: string;
    title: string;
    prompt: string;
    kind: 'after' | 'at' | 'every' | 'daily' | 'weekly' | 'cron' | 'rrule';
    scheduledAt: string;
    status: 'active' | 'paused' | 'ended';
    updatedAt?: string;
    target: {
        kind: 'session' | 'new_once' | 'new';
        sessionId?: string;
        create?: unknown;
    };
    involvedSessionIds: string[];
    executionActive?: boolean;
    afterSeconds?: number;
    everySeconds?: number;
    time?: string;
    timeZone?: string;
    weekdays?: number[];
    expression?: string;
    rrule?: string;
    createdAt?: string;
    resumeIntent?: 'active' | 'paused' | 'ended';
    migrationState?: 'expired';
}
/** Extension contract only: an embedding must supply an audited adapter for its goal dialect. */
export interface NativeGoalState {
    adapter: string;
    version: number;
    sessionId: string;
    state: unknown;
    sourceMode?: 'cold-log';
}
export interface NativeAutonomyBundle {
    schema: 1;
    rootId: string;
    children: NativeSnapshot[];
    queues: NativeQueue[];
    schedules: NativeSchedule[];
    goals?: NativeGoalState[];
    /** Historical tool identities -> current wire identities, including all prior roots. */
    agentAliases?: Record<string, string>;
}
export interface NativeAutonomySnapshot extends NativeSnapshot {
    autonomy?: NativeAutonomyBundle;
}
export interface NativeAutonomyPlan {
    bundle: NativeAutonomyBundle;
    ids: Record<string, string>;
    children: NativeSnapshot[];
    aliases: string;
    agentAliases: Record<string, string>;
    /** Fixed receiver runtime target; apply to each child's execution header, never to event strings. */
    placement?: NativeRuntimePlacement;
}
/** No activation API exists here. Imports create cold artifacts; each child gets receiver policy first. */
export interface NativeAutonomyHost {
    capture(sessionId: string, project: string): Promise<NativeAutonomyBundle | undefined>;
    /** Persist the packet before take/clear; CAS-pause schedules, archiveSession(root), then return drained logs. Idempotent by operationId. */
    freeze(sessionId: string, bundle: NativeAutonomyBundle, operationId: string): Promise<{
        snapshot: NativeSnapshot;
        bundle: NativeAutonomyBundle;
    }>;
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
    restoreSource?(sessionId: string, operationId: string, packet?: {
        snapshot: NativeSnapshot;
        bundle: NativeAutonomyBundle;
    }): Promise<void>;
    /** Exact admission evidence from the owning queue/goal service or a settled out-of-process schedule invocation. */
    queryWork?(request: NativeWorkRequest): Promise<{
        requestDigest: string;
        state: 'accepted' | 'absent' | 'unknown' | 'conflict';
        settled?: boolean;
        localId?: string;
    }>;
}
export interface NativeResumeOptions {
    queues?: boolean;
    schedules?: string[];
    goals?: boolean;
    activatePaused?: string[];
    onlyKeys?: string[];
}
export interface NativeWorkRequest {
    kind: 'schedule-create' | 'schedule-update' | 'queue' | 'goal';
    sessionId: string;
    payload: any;
    startedAt: string;
    settledAt?: string;
    requestDigest: string;
    baselineIds?: string[];
    runId: string;
}
/** Throw only when the owning service proves that no input/task was accepted. */
export declare class NativeWorkNotAccepted extends RemoteError {
    readonly code: string;
    readonly accepted = false;
    constructor(code: string, message: string);
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
    list(request: {
        limit: number;
        offset: number;
    }): Promise<{
        items: NativeSchedule[];
        total: number;
    }>;
    view(request: {
        id: string;
    }): Promise<NativeSchedule | {
        id: string;
        code: string;
    }>;
    edit(request: {
        id: string;
        action: 'update';
        patch: {
            active: boolean;
        };
        expectedUpdatedAt: string | null;
    }): Promise<NativeSchedule | {
        id: string;
        code: string;
    }>;
    create(request: {
        title: string;
        prompt: string;
        timing: Record<string, unknown>;
        target: {
            kind: 'session';
            sessionId: string;
        };
    }): Promise<NativeSchedule>;
}
/** Retains completed job facts without claiming to transfer their process-local registry or OS resources. */
export declare function assertNativeAutonomyIdle(snapshot: NativeSnapshot, runtime?: {
    status?: string;
    jobs?: {
        owner?: string;
        status: string;
    }[];
}): void;
/** Fold actual durable inbox splices, preserving order and identified messages verbatim. */
export declare function nativeParkedQueues(snapshot: NativeSnapshot): NativeQueue[];
export declare function validateNativeAutonomy(root: NativeSnapshot, bundle: NativeAutonomyBundle): void;
/** Remap only fields owned by the session/subagent schemas. Never recurse into arbitrary text/tool payloads. */
export declare function remapNativeStructure(snapshot: NativeSnapshot, ids: Record<string, string>): NativeSnapshot;
export declare function planNativeAutonomy(bundle: NativeAutonomyBundle, localRootId: string, ids?: Record<string, string>): NativeAutonomyPlan;
export declare function canonicalNativeStructure(snapshot: NativeSnapshot, plan: NativeAutonomyPlan): NativeSnapshot;
export declare function remapNativeAutonomy(bundle: NativeAutonomyBundle, mapping: Record<string, string>): NativeAutonomyBundle;
export declare function canonicalNativeAutonomy(bundle: NativeAutonomyBundle, plan: NativeAutonomyPlan): NativeAutonomyBundle;
/** Compare only after identity normalization. Existing child logs/attachments are immutable prefixes too. */
export declare function nativeCheckpointEvents(snapshot: NativeSnapshot, remote: NativeSnapshot): NativeSnapshot['events'];
/** Tool-argument alias adapter; no rewriting of messages, code, prompts or tool result strings. */
export declare function nativeAutonomyAgentId(plan: NativeAutonomyPlan, id: string): string;
export declare function captureNativeSchedules(api: NativeScheduleApi, rootId: string): Promise<NativeSchedule[]>;
export declare function pauseNativeSchedules(api: NativeScheduleApi, schedules: NativeSchedule[]): Promise<void>;
export interface Receipt {
    state: 'attempting' | 'done' | 'uncertain' | 'not-accepted' | 'absent' | 'expired';
    localId?: string;
    error?: string;
    code?: string;
    request?: NativeWorkRequest;
    retryApproved?: boolean;
    explicitEnable?: boolean;
}
interface SourceRecovery {
    operationId: string;
    hostId: string;
    phase: 'fenced' | 'restoring' | 'parked';
}
interface SourceCut {
    snapshot: NativeSnapshot;
    bundle: NativeAutonomyBundle;
    complete: boolean;
    original?: {
        snapshot: NativeSnapshot;
        bundle: NativeAutonomyBundle;
    };
}
export interface NativeAutonomySource {
    snapshot(sessionId: string): Promise<NativeSnapshot>;
    runtime(sessionId: string): {
        status?: string;
        jobs?: {
            owner?: string;
            status: string;
        }[];
    };
    /** Compare IDs/order with expected, take+clear durably; an already empty queue is an idempotent replay. */
    clearInbox(sessionId: string, expected: NativeQueue[]): Promise<void>;
    /** Native workspace archiveSession(root), with no stopActivity override; refuses live physical work. */
    archiveSession(sessionId: string): Promise<void>;
    schedule?: NativeScheduleApi;
    goals?: Record<string, NativeGoalAdapter>;
}
/** Intent is durable BEFORE acceptance. Unknown outcomes stop replay; they never silently duplicate execution. */
export declare class NativeAutonomyJournal {
    readonly path: string;
    private entries;
    private sources;
    private savedInput;
    private busy;
    private readonly runId;
    constructor(path: string);
    private save;
    stage(sessionId: string, bundle: NativeAutonomyBundle, ids?: Record<string, string>, placement?: NativeRuntimePlacement): NativeAutonomyPlan;
    plan(sessionId: string): NativeAutonomyPlan | undefined;
    rootFor(id: string): string | undefined;
    linkDescendant(rootId: string, parentId: string, childId: string): void;
    detach(sessionId: string): void;
    retainInput(sessionId: string, messages: unknown[]): void;
    retainedInput(sessionId: string): unknown[];
    /** Persist every new child's stable identity before constructing a remotely replayable operation. */
    prepareExport(sessionId: string, canonicalRootId: string, captured: NativeAutonomyBundle): NativeAutonomyPlan;
    /** Keep never-resumed input/tasks in the next handoff even though they have no live inbox/timer yet. */
    exportBundle(sessionId: string, captured: NativeAutonomyBundle): NativeAutonomyBundle;
    mergeFrozenWork(sessionId: string, operationId: string, captured: NativeAutonomyBundle): void;
    inspectWork(sessionId: string, key: string, host: NativeAutonomyHost): Promise<{
        state: "uncertain" | "done" | "expired" | "absent" | "attempting" | "not-accepted";
        localId: string | undefined;
        candidates: string[];
        canConfirmAbsent: boolean;
        request: NativeWorkRequest | undefined;
        reason?: undefined;
    } | {
        state: string;
        candidates: string[];
        canConfirmAbsent: boolean;
        reason: string;
        request: undefined;
        localId?: undefined;
    } | {
        state: string;
        localId: string | undefined;
        candidates: string[];
        canConfirmAbsent: boolean;
        request: NativeWorkRequest;
        reason?: undefined;
    } | {
        state: string;
        candidates: string[];
        canConfirmAbsent: boolean;
        request: NativeWorkRequest;
        localId?: undefined;
        reason?: undefined;
    } | {
        state: string;
        candidates: string[];
        canConfirmAbsent: boolean;
        reason: string;
        request: NativeWorkRequest;
        localId?: undefined;
    }>;
    reconcileWork(sessionId: string, key: string, host: NativeAutonomyHost, decision: {
        candidateId?: string;
        confirmAbsent?: boolean;
    }): Promise<{
        state: "uncertain" | "done" | "expired" | "absent" | "attempting" | "not-accepted";
        localId: string | undefined;
        candidates: string[];
        canConfirmAbsent: boolean;
        request: NativeWorkRequest | undefined;
        reason?: undefined;
    } | {
        state: string;
        candidates: string[];
        canConfirmAbsent: boolean;
        reason: string;
        request: undefined;
        localId?: undefined;
    } | {
        state: string;
        localId: string | undefined;
        candidates: string[];
        canConfirmAbsent: boolean;
        request: NativeWorkRequest;
        reason?: undefined;
    } | {
        state: string;
        candidates: string[];
        canConfirmAbsent: boolean;
        request: NativeWorkRequest;
        localId?: undefined;
        reason?: undefined;
    } | {
        state: string;
        candidates: string[];
        canConfirmAbsent: boolean;
        reason: string;
        request: NativeWorkRequest;
        localId?: undefined;
    }>;
    retryWork(sessionId: string, key: string, host: NativeAutonomyHost): Promise<void>;
    sourcePacket(operationId: string): SourceCut;
    rememberSource(operationId: string, snapshot: NativeSnapshot, bundle: NativeAutonomyBundle): void;
    rememberFrozen(operationId: string, frozen: {
        snapshot: NativeSnapshot;
        bundle: NativeAutonomyBundle;
    }): void;
    fenceSourceRecovery(sessionId: string, hostId: string, operationId: string): void;
    sourceRecoveries(): {
        imported: boolean;
        children: string[];
        aliases: Record<string, string>;
        goals: {
            sessionId: string;
            adapter: string;
            phase: any;
        }[];
        queues: number;
        schedules: {
            id: string;
            title: string;
            status: "active" | "paused" | "ended";
            resumeIntent: "active" | "paused" | "ended";
            migrationState: "expired" | undefined;
        }[];
        receipts: Record<string, Receipt>;
        retainedInput: number;
        operationId: string;
        hostId: string;
        phase: "fenced" | "restoring" | "parked";
        sessionId: string;
    }[];
    sourceRecovery(sessionId: string): SourceRecovery | undefined;
    restoringSource(sessionId: string): void;
    parkSourceRecovery(sessionId: string, current: NativeAutonomyBundle): void;
    freezeSource(snapshot: NativeSnapshot, bundle: NativeAutonomyBundle, source: NativeAutonomySource, operationId: string): Promise<{
        snapshot: NativeSnapshot;
        bundle: NativeAutonomyBundle;
    }>;
    status(sessionId: string): {
        imported: boolean;
        children: string[];
        aliases: Record<string, string>;
        goals: {
            sessionId: string;
            adapter: string;
            phase: any;
        }[];
        queues: number;
        schedules: {
            id: string;
            title: string;
            status: "active" | "paused" | "ended";
            resumeIntent: "active" | "paused" | "ended";
            migrationState: "expired" | undefined;
        }[];
        receipts: Record<string, Receipt>;
    };
    preflight(sessionId: string, host: NativeAutonomyHost): Promise<void>;
    importParked(sessionId: string, host: NativeAutonomyHost): Promise<void>;
    private attempt;
    resume(sessionId: string, host: NativeAutonomyHost, options: NativeResumeOptions): Promise<void>;
}
/** Public dsh-goal 0.2.2-rc.1 state. activation is process-local and excluded from every transfer. */
export interface NativeGoalView {
    id: string;
    revision: number;
    objective: string;
    phase: 'active' | 'paused' | 'blocked' | 'complete';
    maxGoalRounds: number;
    roundsStarted: number;
    createdAt: number;
    updatedAt: number;
    blockedReason?: {
        code: string;
        message: string;
    };
    activation: 'armed' | 'disarmed';
}
export type NativeDurableGoal = Omit<NativeGoalView, 'activation'>;
export interface NativeGoalsApi<Agent = unknown> {
    get(agent: Agent): NativeGoalView | undefined;
    pause(agent: Agent, ref: {
        id: string;
        revision: number;
    }): NativeGoalView;
    resume(agent: Agent, ref: {
        id: string;
        revision: number;
    }): NativeGoalView;
}
export declare const NATIVE_DSH_GOAL_ADAPTER = "dsh-goal-v1";
export declare function captureNativeGoal<Agent>(api: NativeGoalsApi<Agent>, agent: Agent, sessionId: string): NativeGoalState | undefined;
/** Uses audited public methods only. Cold-log reading is supplied by the host's real foldGoal/projection adapter. */
export declare function nativeDshGoalAdapter<Agent>(api: NativeGoalsApi<Agent>, options: {
    liveAgent(sessionId: string): Agent | undefined;
    readColdGoal(sessionId: string): Promise<NativeDurableGoal | undefined>;
}): NativeGoalAdapter;
export {};
