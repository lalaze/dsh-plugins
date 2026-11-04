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
/**
 * A conversation's title from Claude Code's session file: the user's /rename, then Claude's own title, then the first
 * prompt. Claude often writes no title, for a short greeting especially, and DSH titles its other conversations by their
 * first prompt too. The first `last-prompt` record holds the first prompt; a later one may have no text.
 */
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
        verify(sessionId: string, signal: AbortSignal): Promise<{
            hostId: string;
        }>;
        session(sessionId: string): TuiSession | undefined;
        list(): Promise<readonly SessionRow[]>;
        rename(sessionId: string, title: string): Promise<void>;
        selectModel(selection: {
            sessionId: string;
            provider: string;
            model: string;
            reasoningEffort?: string;
        }): Promise<void>;
        /** The title records of a Claude session on the conversation's machine. */
        titleRecords(sessionId: string, claudeSession: string, signal: AbortSignal): Promise<string>;
    });
    list(): string[];
    /**
     * Tell DSH the conversation's model, once. A session shows its model in the workspace list only if a selection or a
     * request recorded it: a TUI conversation sends no requests, and the composer may only be showing a remembered default.
     * The icon is all that depends on this, so a failure is retried by the next title check rather than reported.
     * @param route - the composer's model route; a conversation started by an earlier version has none, so its is rebuilt.
     */
    private recordModel;
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
