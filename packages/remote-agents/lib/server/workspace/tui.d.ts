import type { Store } from '../core/store.js';
/** The part of a DSH session this needs. */
interface TuiSession {
    append(type: string, data: unknown): unknown;
}
interface SessionRow {
    sessionId: string;
    blank?: boolean;
}
/** The Claude session of a TUI conversation: the same every launch, so that reopening it resumes. */
export declare function tuiClaudeSession(sessionId: string): string;
/** A title Claude Code recorded in its session file; one the user set with /rename wins over its own. */
export declare function claudeTitle(records: string): string | undefined;
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
        /** The title records of a Claude session on the conversation's machine. */
        titleRecords(sessionId: string, claudeSession: string, signal: AbortSignal): Promise<string>;
    });
    list(): string[];
    /** @param selection - the composer's model route and effort, which the first launch of Claude Code uses. */
    start(sessionId: string, selection: {
        model?: unknown;
        effort?: unknown;
    }, signal: AbortSignal): Promise<void>;
    /**
     * Follow Claude Code's title, until the conversation is renamed in DSH.
     * @param current - the conversation's title in DSH.
     * @returns the new title, if it changed.
     */
    syncTitle(sessionId: string, current: unknown, signal: AbortSignal): Promise<string | undefined>;
}
export {};
