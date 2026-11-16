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
/** The first question of logged `ask_user_question` arguments. */
export declare function firstQuestion(argumentsText: string): string;
export declare class AttentionTracker {
    private readonly titleOf;
    readonly epoch: string;
    private readonly sessions;
    private readonly listeners;
    private next;
    /** @param titleOf - the title of a Session joined mid-log (its `session/title` events came before this plugin). */
    constructor(titleOf?: (session: {
        readonly id: string;
    }) => string | undefined);
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
    private state;
    private emit;
}
