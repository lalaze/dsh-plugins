import { type NativeSnapshot } from './native-protocol.js';
import type { NativeRpc } from './native-registry.js';
import { NativePlacements, type NativeRuntimePlacement, type NativeProjectSnapshot } from './native-placement.js';
import { NativeAutonomyJournal, type NativeAutonomyHost, type NativeResumeOptions } from './native-autonomy.js';
export interface NativeReplica {
    sessionId: string;
    sharedId: string;
    hostId: string;
    version: number;
    digest: string;
    phase: 'sealed' | 'mirror' | 'active' | 'importing';
    token?: string;
    pending?: Record<string, unknown>;
    error?: string;
    rejected?: unknown[];
    originalSelection?: {
        provider: string;
        model: string;
        reasoningEffort?: string;
    };
    cancelOp?: string;
    placement?: NativeRuntimePlacement;
    autonomySource?: boolean;
    enrollmentCancelled?: boolean;
    pendingFreeze?: {
        operationId: string;
        action: 'release' | 'archive' | 'delete' | 'withdraw';
        stage: 'freezing' | 'frozen' | 'published';
        selection?: NativeReplica['originalSelection'];
    };
    retiredClosures?: number[];
}
export interface NativeHost {
    autonomy?: NativeAutonomyHost;
    available(): boolean;
    placement(sessionId: string, hostId: string): Promise<string>;
    /** Optional local source metadata, never a scan of private history. */
    sourceDirectory?(sessionId: string): Promise<string | undefined>;
    /** Legacy hosts may omit this. Real adapters must resolve remote placement or require explicit local mapping. */
    resolvePlacement?(hostId: string, project: string): Promise<NativeRuntimePlacement>;
    snapshot(sessionId: string, project: string): Promise<NativeProjectSnapshot>;
    idle<T>(sessionId: string, operation: () => Promise<T>): Promise<T>;
    validate(snapshot: NativeSnapshot): Promise<void>;
    import(sessionId: string, hostId: string, snapshot: NativeSnapshot, mirror?: boolean, placement?: NativeRuntimePlacement): Promise<void>;
    activate(sessionId: string): Promise<void>;
    seal(sessionId: string): Promise<void>;
    unseal?(sessionId: string, selection: NonNullable<NativeReplica['originalSelection']>): Promise<void>;
    archive?(sessionId: string): Promise<void>;
}
/** One durable journal for opt-in, closed originals, pending CAS operations and rejected input. */
export declare class NativeSharing {
    readonly path: string;
    readonly instance: string;
    private readonly rpc;
    readonly host: NativeHost;
    private state;
    private readonly queues;
    private readonly serialContext;
    private stopping;
    readonly restoring: Set<string>;
    readonly activated: Set<string>;
    readonly errors: Record<string, string>;
    readonly placements: NativePlacements;
    readonly autonomy: NativeAutonomyJournal;
    constructor(path: string, instance: string, rpc: NativeRpc, host: NativeHost);
    private save;
    private serial;
    private key;
    replica(id: string): NativeReplica | undefined;
    enrollDescendant(parentId: string, childId: string): void;
    autonomyOwner(id: string): {
        rootSessionId: string;
        replica: NativeReplica;
        ids: Record<string, string>;
        agentAliases: Record<string, string>;
        context: string | undefined;
    } | undefined;
    status(): {
        available: boolean;
        enabled: boolean;
        hosts: string[];
        errors: {
            [x: string]: string;
        };
        sourceRecoveries: {
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
            receipts: Record<string, import("./native-autonomy.js").Receipt>;
            retainedInput: number;
            operationId: string;
            hostId: string;
            phase: "fenced" | "restoring" | "parked";
            sessionId: string;
        }[];
        replicas: {
            autonomy: {
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
                receipts: Record<string, import("./native-autonomy.js").Receipt>;
            };
            live: boolean;
            pending: boolean;
            rejected: number;
            sessionId: string;
            sharedId: string;
            hostId: string;
            version: number;
            digest: string;
            phase: "sealed" | "mirror" | "active" | "importing";
            error?: string;
            originalSelection?: {
                provider: string;
                model: string;
                reasoningEffort?: string;
            };
            cancelOp?: string;
            placement?: NativeRuntimePlacement;
            autonomySource?: boolean;
            enrollmentCancelled?: boolean;
            pendingFreeze?: {
                operationId: string;
                action: "release" | "archive" | "delete" | "withdraw";
                stage: "freezing" | "frozen" | "published";
                selection?: NativeReplica["originalSelection"];
            };
            retiredClosures?: number[];
        }[];
    };
    recoveryInput(id: string): unknown[];
    failure(id: string, error: unknown): void;
    sync(): Promise<void>;
    private enabled;
    close(): Promise<void>;
    private call;
    private mutate;
    configure(hostId: string, enabled: boolean): Promise<unknown>;
    list(hostId: string): Promise<any[]>;
    mappings(hostId: string): import("./native-placement.js").NativeProjectMapping[];
    sourceProject(sessionId: string, hostId: string): Promise<{
        projectKey: string;
        localDirectory?: undefined;
        mappingRequired?: undefined;
    } | {
        projectKey: string;
        localDirectory: string;
        mappingRequired: boolean;
    }>;
    inspectMapping(hostId: string, localDirectory: string): {
        localDirectory: string;
    };
    setMapping(hostId: string, projectKey: string, localDirectory: string, confirmedDirectory: string): Promise<import("./native-placement.js").NativeProjectMapping>;
    diagnoseLock(hostId: string, sharedId: string): Promise<unknown>;
    restore(hostId: string, sharedId: string): Promise<void>;
    /** No permanent ownership transfer until the local original is durably closed. */
    share(sessionId: string, hostId: string): Promise<NativeReplica>;
    /** Import a read-only view or acquire the single writer and create a new linked native continuation. */
    open(hostId: string, sharedId: string, writing: boolean): Promise<{
        sessionId: string;
    }>;
    /** Every model attempt, including retry, and every tool dispatch checks remote ownership/version. */
    guard(sessionId: string): Promise<void>;
    resumeAutonomy(sessionId: string, options: NativeResumeOptions): Promise<void>;
    /** Hook rejection happens after inbox claim: retain the exact messages synchronously before returning. */
    rejected(sessionId: string, messages: unknown[]): void;
    checkpoint(sessionId: string): Promise<void>;
    private checkpointInside;
    handoff(sessionId: string, action?: 'release' | 'archive' | 'delete' | 'withdraw'): Promise<void>;
    rollbackFreeze(sessionId: string): Promise<void>;
    private workHost;
    inspectWork(sessionId: string, key: string): Promise<{
        state: "uncertain" | "done" | "expired" | "absent" | "attempting" | "not-accepted";
        localId: string | undefined;
        candidates: string[];
        canConfirmAbsent: boolean;
        request: import("./native-autonomy.js").NativeWorkRequest | undefined;
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
        request: import("./native-autonomy.js").NativeWorkRequest;
        reason?: undefined;
    } | {
        state: string;
        candidates: string[];
        canConfirmAbsent: boolean;
        request: import("./native-autonomy.js").NativeWorkRequest;
        localId?: undefined;
        reason?: undefined;
    } | {
        state: string;
        candidates: string[];
        canConfirmAbsent: boolean;
        reason: string;
        request: import("./native-autonomy.js").NativeWorkRequest;
        localId?: undefined;
    }>;
    reconcileWork(sessionId: string, key: string, decision: {
        candidateId?: string;
        confirmAbsent?: boolean;
    }): Promise<{
        state: "uncertain" | "done" | "expired" | "absent" | "attempting" | "not-accepted";
        localId: string | undefined;
        candidates: string[];
        canConfirmAbsent: boolean;
        request: import("./native-autonomy.js").NativeWorkRequest | undefined;
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
        request: import("./native-autonomy.js").NativeWorkRequest;
        reason?: undefined;
    } | {
        state: string;
        candidates: string[];
        canConfirmAbsent: boolean;
        request: import("./native-autonomy.js").NativeWorkRequest;
        localId?: undefined;
        reason?: undefined;
    } | {
        state: string;
        candidates: string[];
        canConfirmAbsent: boolean;
        reason: string;
        request: import("./native-autonomy.js").NativeWorkRequest;
        localId?: undefined;
    }>;
    retryWork(sessionId: string, key: string): Promise<void>;
    /** Resume a failed publication/claim/release with its saved operation ID, never force claim. */
    recover(sessionId: string): Promise<void>;
    /** Atomically fence a never-published/never-claimed enrollment before restoring its original local route. */
    cancelEnrollment(sessionId: string): Promise<void>;
    restoreCancelledSource(sessionId: string): Promise<void>;
    resumeSourceWork(sessionId: string, options: NativeResumeOptions): Promise<void>;
    reconcileEnrollment(sessionId: string): Promise<void>;
}
