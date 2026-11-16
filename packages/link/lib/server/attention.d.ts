/**
 * What needs the user on this machine: approvals and questions waiting, turns that finished or failed, turns that run.
 * Folded from the `session/event` feed of every Session, including ones no page has open. Event shapes follow DSH
 * 0.2.2 (`@deepseek-ai/dsh-session`, `-user-approval`, `-user-questions`).
 */
/** `approval`, `question`: waiting. `done`, `failed`: news. `resolved`: a wait ended. `running`, `idle`: turn state. */
export type AttentionKind = 'approval' | 'question' | 'done' | 'failed' | 'resolved' | 'running' | 'idle';
export interface AttentionFrame {
    /** Increasing within one {@link AttentionTracker.epoch}. */
    id: number;
    kind: AttentionKind;
    sessionId: string;
    title: string;
    /** The approval id or question call id; `turn:<n>` for turn frames. A `resolved` frame repeats the wait's key. */
    key: string;
    /** The approval reason or tool, the question, or the failure. */
    detail: string;
    time: number;
}
/** What a subscriber gets first: everything still waiting and every turn still running. */
export interface AttentionSnapshot {
    epoch: string;
    waiting: AttentionFrame[];
    running: AttentionFrame[];
}
/**
 * How long a run that only DSH's running status reports waits for a turn of DSH's own before it counts by itself. DSH
 * logs its own turns right as they start; a TUI conversation's turns run in a terminal and are never logged.
 */
export declare const STATUS_GRACE_MS = 1500;
/** The first question of logged `ask_user_question` arguments. */
export declare function firstQuestion(argumentsText: string): string;
export declare class AttentionTracker {
    private readonly titleOf;
    private readonly statusGraceMs;
    readonly epoch: string;
    private readonly sessions;
    private readonly listeners;
    private next;
    private statusRuns;
    /**
     * @param titleOf - the title of a Session joined mid-log (its `session/title` events came before this plugin).
     * @param statusGraceMs - see {@link STATUS_GRACE_MS}.
     */
    constructor(titleOf?: (session: {
        readonly id: string;
    }) => string | undefined, statusGraceMs?: number);
    snapshot(): AttentionSnapshot;
    subscribe(listener: (frame: AttentionFrame) => void): () => void;
    /** A Session left the store: what it waited for and ran is over. */
    forget(sessionId: string): void;
    observe(session: {
        readonly id: string;
    }, event: {
        type: string;
        time: number;
        data: unknown;
    }): void;
    /**
     * DSH's running status of a conversation (`api-session/status`). DSH sends it for its own turns, which the log tells
     * better, and remote-terminals sends it for TUI conversations, whose turns run in a terminal and never reach the log.
     * So a run counts here only when no logged turn starts within {@link STATUS_GRACE_MS}, and only such a run ends here,
     * as finished: a terminal does not say whether its turn failed or was stopped.
     */
    status(session: {
        readonly id: string;
    }, running: boolean, time?: number): void;
    private state;
    private emit;
}
