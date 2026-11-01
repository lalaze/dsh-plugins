import type { Command, CommandResult, LiveFrame, PendingInteraction, SessionEntry, SyncedEvent, WorkspaceEntry } from '../shared/protocol.js';
import type { ApprovalAsk, HostApi, HostAttachmentRef } from './host.js';
export declare class CommandError extends Error {
    readonly status: number;
    name: string;
    constructor(message: string, status?: number);
}
/** What survives a restart: the last inspected position of each session, and handled request IDs. */
export interface ExecutorData {
    sessions: Record<string, {
        updatedAt: number;
        running: boolean;
        lastSeq: number;
        title?: string;
        forkOf?: string;
        approvals?: PendingInteraction[];
    }>;
    handled: Record<string, {
        at: number;
        result: CommandResult;
    }>;
    continued: Record<string, {
        deviceId: string;
        sessionId: string;
    }>;
}
export declare const emptyExecutorData: () => ExecutorData;
export interface ExecutorOptions {
    host: HostApi;
    data: ExecutorData;
    save(): void;
    /** Something a peer would fetch changed. */
    changed(): void;
    /** Whether any paired machine could answer an approval now. */
    approvalPeers(): boolean;
    log?(message: string): void;
}
export declare class Executor {
    private readonly options;
    private readonly host;
    private readonly entries;
    private workspaceState;
    private workspaceRev;
    private rev;
    /** Identifies this process's change counter; a peer holding another epoch's cursor gets everything again. */
    readonly epoch: string;
    private readonly approvals;
    private readonly questions;
    private readonly inspected;
    private readonly inflight;
    private readonly entryListeners;
    private refreshing?;
    /** Sessions DSH reported as changed since they were last read. */
    private readonly dirty;
    private again;
    private readonly controller;
    constructor(options: ExecutorOptions);
    /** Follow DSH's session and workspace state until {@link close}. */
    start(): void;
    close(): void;
    private loop;
    /** Read the session list again soon. */
    schedule(): void;
    /** Bring every entry up to date with DSH. Concurrent calls share one pass, plus one more if asked during it. */
    refresh(): Promise<void>;
    private pass;
    private update;
    /** Store an entry; bump its revision when it differs. */
    private put;
    private remember;
    private read;
    /** The revision a cursor stands for; -1 for a cursor from another process or none. */
    afterOf(since: string | undefined): number;
    /** Changes since a cursor from {@link changes}; an unknown cursor means everything. */
    changes(since: string | undefined): {
        cursor: string;
        workspaces?: WorkspaceEntry[];
        sessions: SessionEntry[];
    };
    /** Something outside the executor (groups) changed: move the cursor so peers fetch again. */
    bump(): number;
    revision(): number;
    workspaceEntries(): WorkspaceEntry[];
    entry(sessionId: string): SessionEntry | undefined;
    /**
     * Shared events after `after`, in order. `through` is the last event examined, shared or not: a mirror holding
     * everything through it needs nothing before it again.
     */
    events(sessionId: string, after: number, limit: number, signal: AbortSignal, atLeast?: number): Promise<{
        events: SyncedEvent[];
        through: number;
        lastSeq: number;
        hasMore: boolean;
    }>;
    /** Whether an attachment appears in what this session shares; others are never served. */
    sharesAttachment(sessionId: string, attachmentId: string, signal: AbortSignal): Promise<HostAttachmentRef | undefined>;
    /**
     * Follow one session live. The first frame is `open`; each `event` frame says which event came before it, so a
     * mirror can tell whether it missed one in between.
     */
    live(sessionId: string, signal: AbortSignal): AsyncIterable<LiveFrame>;
    /**
     * Run a request from a paired machine, or from this one. A request ID that already succeeded returns the same
     * result without running again, so a retry after a lost response is harmless.
     */
    command(command: Command): Promise<CommandResult>;
    private run;
    /** The approval bridge: offer each question to paired machines that may answer it. */
    readonly approvalBridge: (ask: ApprovalAsk, signal: AbortSignal) => {
        answer: Promise<"allowed-once" | "rejected">;
        wait: boolean;
    } | undefined;
}
