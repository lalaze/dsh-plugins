import type { Command, CommandResult, LiveFrame, ModelSelection, PendingInteraction, SessionEntry, SyncedEvent, WorkspaceEntry } from '../../shared/protocol.js';
import type { ApprovalAsk, HostApi, HostAttachmentRef } from './host.js';
export declare class CommandError extends Error {
    readonly status: number;
    name: string;
    constructor(message: string, status?: number);
}
/** What survives a restart: the last inspected position of each session, and handled request IDs. */
export interface ExecutorData {
    /** What the cached session facts were derived with; see {@link EXECUTOR_DATA_VERSION}. */
    version?: number;
    sessions: Record<string, {
        updatedAt: number;
        running: boolean;
        lastSeq: number;
        title?: string;
        preview?: string;
        forkOf?: string;
        approvals?: PendingInteraction[];
        model?: ModelSelection;
    }>;
    handled: Record<string, {
        at: number;
        result: CommandResult;
    }>;
}
/** Raise when the facts read from a session log change, so every session is read again. */
export declare const EXECUTOR_DATA_VERSION = 2;
export declare const emptyExecutorData: () => ExecutorData;
export interface ExecutorOptions {
    host: HostApi;
    data: ExecutorData;
    save(): void;
    /** Something a peer would fetch changed. */
    changed(): void;
    /** Whether any paired phone could answer an approval now. */
    approvalPeers(): boolean;
    /** Whether a phone is connected, so running sessions are worth reading often. */
    watched?(): boolean;
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
    private readonly anyEntryListeners;
    private refreshing?;
    /** Sessions DSH reported as changed since they were last read. */
    private readonly dirty;
    private again;
    private readonly controller;
    constructor(options: ExecutorOptions);
    /** Follow DSH's session and workspace state until {@link close}. */
    start(): void;
    close(): void;
    private rereadMs;
    /** Every entry change, with the entry before it; for notifications. */
    onEntry(listener: (entry: SessionEntry, previous: SessionEntry | undefined) => void): () => void;
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
    /** The cursor {@link changes} would return now. */
    cursor(): string;
    workspaceEntries(): WorkspaceEntry[];
    entry(sessionId: string): SessionEntry | undefined;
    /**
     * A page of shared events, in order. With `after`, the events following it (`hasMore` when the page filled up);
     * otherwise the latest events before `before` (or the end), for reading a long conversation from its end
     * (`hasEarlier` when older ones remain).
     */
    events(sessionId: string, page: {
        after?: number;
        before?: number;
        limit: number;
    }, signal: AbortSignal): Promise<{
        events: SyncedEvent[];
        lastSeq: number;
        hasMore: boolean;
        hasEarlier: boolean;
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
