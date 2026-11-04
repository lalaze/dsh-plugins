import type { Store } from '../core/store.js';
/** The part of a DSH session this needs. */
interface TuiSession {
    append(type: string, data: unknown): unknown;
}
interface SessionRow {
    sessionId: string;
    blank?: boolean;
}
/**
 * Conversations whose main view is the interactive Claude Code instead of DSH's chat. Each stays a real DSH session, so
 * it is a row in the workspace list. DSH shows no views in a session until its log has a turn, so starting one records
 * an empty turn. The conversation itself lives in the remote Claude Code; see the Remote Claude launcher in terminal.ts.
 */
export declare class TuiSessions {
    private readonly store;
    private readonly dsh;
    constructor(store: Store, dsh: {
        /** Rejects a conversation that is not a verified remote workspace. */
        verify(sessionId: string, signal: AbortSignal): Promise<unknown>;
        session(sessionId: string): TuiSession | undefined;
        list(): Promise<readonly SessionRow[]>;
        rename(sessionId: string, title: string): Promise<void>;
    });
    list(): string[];
    start(sessionId: string, signal: AbortSignal): Promise<void>;
}
export {};
