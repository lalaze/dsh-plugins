import type { TurnUsage } from '../core/domain.js';
import type { Store } from '../core/store.js';
import { type RemoteUsageRecord } from '../agents/usage.js';
import type { TuiCli } from './domain.js';
/**
 * Usage of TUI conversations. Their CLI runs in a terminal, so no turn passes through the relay that counts a chat's
 * usage; each CLI logs what every request used, and that log is read instead. Claude Code writes the API's usage on each
 * reply line (several lines per request, one per part of the reply) and `system/turn_duration` when a turn ends, or,
 * for a turn stopped with Esc during a reply or a tool, a user line `[Request interrupted by user…]` naming the
 * interrupted request in `interruptedMessageId` (a reply cut off keeps only the usage it started with); its
 * subagents log to `<session>/subagents/agent-*.jsonl`. Codex reports its running totals in `token_count` events and
 * ends a turn with `task_complete` or `turn_aborted`; its subagents, such as the reviewer of approval requests, run in
 * threads of their own that name their parent in their first line, each with its own totals and turns. Subagents' usage
 * counts toward the conversation's turn running at the time, under their own model. Each finished turn becomes one
 * record per model, as a chat's does.
 */
/** Bytes of one file read in one go; the rest follows straight after. */
export declare const TUI_USAGE_CAP: number;
/** Claude Code's subagent logs, which share the conversation's turns. */
export declare const TUI_SUBAGENT_FILE: RegExp;
/** A Codex subagent's thread, by its ID, as the cursor and the reads name it. */
export declare const TUI_CODEX_CHILD: RegExp;
/**
 * A CLI's log to read: its Claude session or Codex thread, and the bytes of each file already read. A Codex thread's
 * subagent threads are looked for among the files changed in the last `since` minutes, or among all when it is absent.
 */
export interface TuiUsageEntry {
    cli: TuiCli;
    id: string;
    read: Record<string, number>;
    since?: number;
}
/**
 * A turn that ends without any marker, as when its CLI is killed, counts once its log has been quiet this long. A later
 * prompt would otherwise take its usage into the next turn, or nothing would ever count it.
 */
export declare const QUIET_MS: number;
/** Where reading a conversation's log got to, so that every turn is counted once. Kept in `TuiDetails.usage`. */
export interface TuiUsageCursor {
    /** Bytes read of each file: `main` and, for Claude Code, its subagents' files by name. */
    read: Record<string, number>;
    /** Claude Code: the request last read in each file and what of it is counted, as its lines may come in two reads. */
    requests?: Record<string, {
        id: string;
        usage: TurnUsage;
    }>;
    /** The turn that was still running at the last read, by model; `seen` is when its log last said anything. */
    open?: {
        startedAt: string;
        seen: string;
        models: Record<string, TurnUsage>;
    };
    /** Codex: its running totals when its last turn ended and as last reported, and the model of the running turn. */
    codexEnded?: Record<string, number>;
    codexLatest?: Record<string, number>;
    model?: string;
    /** Codex: the same for each subagent thread, by ID. */
    codexChildren?: Record<string, {
        ended?: Record<string, number>;
        latest?: Record<string, number>;
        model?: string;
    }>;
    /** Codex: when subagent threads were last looked for. */
    scannedAt?: string;
}
/** A finished turn: when it started, how long it ran and what each model used. */
export interface TuiTurn {
    startedAt: string;
    durationMs: number;
    models: {
        model: string;
        usage: TurnUsage;
    }[];
}
/** What one read returned for a file. */
export interface TuiUsageChunk {
    file: string;
    from: number;
    end: number;
    capped: boolean;
    lines: string[];
}
/** Splits a read into its files, per entry; `more` says a file has more than one read gave. */
export declare function tuiUsageChunks(output: string): {
    entries: Map<number, TuiUsageChunk[]>;
    more: boolean;
};
/** Claude Code's finished turns in what was read, and where reading got to. */
export declare function readClaudeUsage(previous: TuiUsageCursor | undefined, chunks: readonly TuiUsageChunk[], now?: number): {
    cursor: TuiUsageCursor;
    turns: TuiTurn[];
};
/**
 * Codex's finished turns in what was read, and where reading got to. The conversation's thread and its subagents' are
 * read in time order, so that a subagent's turn falls in the conversation's turn running then.
 */
export declare function readCodexUsage(previous: TuiUsageCursor | undefined, chunks: readonly TuiUsageChunk[], fallbackModel: string, now?: number): {
    cursor: TuiUsageCursor;
    turns: TuiTurn[];
};
/** A turn's records in dsh-usage-stats' shape: a conversation's, on the machine and in the directory it ran in. */
export declare function tuiUsageRecords(turn: TuiTurn, context: {
    cli: TuiCli;
    sessionId: string;
    host?: string;
    workspace: string;
}): RemoteUsageRecord[];
interface Target {
    hostId: string;
    label: string;
    cwd: string;
}
/**
 * Reads TUI conversations' logs: every few minutes, and soon after the activity watcher sees a turn end. Reads of one
 * machine go together over its connection. Where reading got to is saved before the records are sent, so a failure can
 * lose a turn but never count one twice.
 */
export declare class TuiUsage {
    private readonly store;
    private readonly deps;
    private chain;
    private readonly due;
    private timers;
    private soon?;
    private closed;
    private readonly abort;
    constructor(store: Pick<Store, 'snapshot' | 'update'>, deps: {
        /** The conversation's verified machine and remote directory. */
        target(sessionId: string, signal: AbortSignal): Promise<Target>;
        /** Runs one read on a machine, once every conversation in it is verified again. */
        read(hostId: string, sessions: readonly {
            sessionId: string;
            target: Target;
        }[], entries: readonly TuiUsageEntry[], signal: AbortSignal): Promise<Buffer | string>;
        emit(record: RemoteUsageRecord): void;
        warn?(message: string): void;
        now?(): number;
    });
    start(): void;
    close(): void;
    /** A TUI conversation's turn ended. */
    finished(sessionId: string): void;
    /** Reads the given TUI conversations, or all of them. One read runs at a time. */
    sweep(only?: readonly string[]): Promise<void>;
    private read;
    /** @returns whether a log has more to read. */
    private readMachine;
}
export {};
