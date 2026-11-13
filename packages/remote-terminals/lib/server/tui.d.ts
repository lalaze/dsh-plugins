import { type TuiStore } from './tui-state.js';
import type { SharedTui } from './tui-shared.js';
import type { TuiCli } from './core/workspace.js';
/** The part of a DSH session this needs. */
interface TuiSession {
    append(type: string, data: unknown): unknown;
}
interface SessionRow {
    sessionId: string;
    blank?: boolean;
}
/** What a conversation shows until its CLI has titled it. */
export declare const FIRST_TITLES: Record<TuiCli, string>;
export declare const MAX_TITLE = 120;
/** The title 0.2.81 gave every TUI conversation, which is replaced like the plugin's own. */
export declare const OLD_TITLE: RegExp;
/** Model and effort reach the remote command line inside double quotes. */
export declare const COMMAND_VALUE: RegExp;
/**
 * Codex saves a new thread only once it has a message or a name, and `codex resume` needs it saved, so a TUI conversation's
 * thread starts with this name. It keeps Codex from titling the thread by itself, so `/rename` is the only title it can have.
 */
export declare const CODEX_THREAD_NAME = "DSH TUI";
/**
 * The Claude session of a TUI conversation: the same every launch, so that reopening it resumes.
 * @param key - the conversation's `tuiKey`, which is its DSH session unless another DSH started it.
 */
export declare function tuiClaudeSession(key: string): string;
/**
 * A conversation's title from Claude Code's session file: the user's /rename, then Claude's own title, then the first
 * prompt. Claude often writes no title, for a short greeting especially, and DSH titles its other conversations by their
 * first prompt too. The first `last-prompt` record holds the first prompt; a later one may have no text.
 */
export declare function claudeTitle(records: string): string | undefined;
/**
 * A conversation's title from its Codex thread: the user's /rename, then the first prompt.
 * @param records - the thread's newest line of Codex's name index and the first of its user messages.
 */
export declare function codexTitle(records: string): string | undefined;
/**
 * Conversations whose main view is the interactive Claude Code or Codex instead of DSH's chat. Each stays a real DSH
 * session, so it is a row in the workspace list. DSH shows no views in a session until its log has a turn, so starting one
 * records an empty turn. The conversation itself lives in the remote CLI; see the launchers in terminal.ts.
 */
export declare class TuiSessions {
    private readonly store;
    private readonly dsh;
    constructor(store: TuiStore, dsh: {
        /** Rejects a conversation that is not a verified remote workspace. */
        verify(sessionId: string, signal: AbortSignal): Promise<{
            hostId: string;
        }>;
        session(sessionId: string): TuiSession | undefined;
        agent?(sessionId: string): unknown;
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
        /** Starts a saved Codex thread with CODEX_THREAD_NAME on the conversation's machine, and returns its ID. */
        codexThread(sessionId: string, signal: AbortSignal): Promise<string>;
        /** The title records of a Codex thread on the conversation's machine. */
        codexTitleRecords(sessionId: string, thread: string, signal: AbortSignal): Promise<string>;
        /** Ends a terminal's holder on the conversation's machine. */
        endHolder?(sessionId: string, holder: string, signal: AbortSignal): Promise<void>;
    });
    list(): string[];
    /**
     * Whether Claude Code is started with its classic renderer, which leaves the conversation in the terminal's own
     * scrollback. Its fullscreen one draws the scrolling itself: every wheel step is a trip to the host and a repaint of the
     * whole screen (about 3.5 KB at 126x47), so on a slow or lossy connection scrolling stutters while the page is idle.
     * Measured over a path of 77 ms with 2% loss: 120 ms a step and pauses of 200 ms, against 17 ms and none this way.
     * The launchers in terminal.ts read it, so it applies to a CLI when it next starts.
     */
    localScroll(): boolean;
    setLocalScroll(local: boolean): Promise<void>;
    /** Those of `list` that run Codex. */
    codex(): string[];
    /**
     * Tell DSH the conversation's model, once. A session shows its model in the workspace list only if a selection or a
     * request recorded it: a TUI conversation sends no requests, and the composer may only be showing a remembered default.
     * The icon is all that depends on this, so a failure is retried by the next title check rather than reported.
     * @param route - the composer's model route; a conversation started by an earlier version has none, so its is rebuilt.
     */
    private recordModel;
    /** @param selection - the CLI, and the composer's model route and effort, which its first launch uses. */
    start(sessionId: string, selection: {
        cli?: unknown;
        model?: unknown;
        effort?: unknown;
    }, signal: AbortSignal): Promise<void>;
    /** DSH shows no views in a conversation until its log has a turn, so an empty one is recorded. */
    private firstTurn;
    /**
     * Shows a TUI conversation another DSH started, in a conversation of this DSH made for it. Nothing is started on the
     * machine: its CLI runs there already, or resumes when the conversation is opened here.
     * @param sessionId - this DSH's conversation, in the remote workspace of the conversation's directory.
     * @param blank - whether that conversation is new, and so needs the turn that makes DSH show it.
     */
    adopt(sessionId: string, hostId: string, shared: SharedTui, blank: boolean, now?: Date): Promise<void>;
    /**
     * Gives a conversation the title another DSH read from its CLI.
     * @param rename - false for a conversation renamed in DSH, which keeps its name and only notes the CLI's title.
     */
    retitle(sessionId: string, title: string, rename?: boolean): Promise<void>;
    /** Ends the conversation's CLI, which otherwise keeps running with no DSH around. Reopening the conversation resumes it. */
    end(sessionId: string, signal: AbortSignal): Promise<void>;
    /**
     * Follow the CLI's title, until the conversation is renamed in DSH.
     * @param current - the conversation's title in DSH.
     * @returns the new title, if it changed.
     */
    syncTitle(sessionId: string, current: unknown, signal: AbortSignal): Promise<string | undefined>;
}
export {};
