import type { Context } from '@deepseek-ai/cordis';
import type { TuiStore } from './tui-state.js';
/** What a TUI conversation's CLI is doing. Approval and question are the kinds DSH's sidebar shows as waiting on the user. */
export type TuiActivity = 'idle' | 'running' | 'approval' | 'question';
/** The part of DSH's terminal screen (@xterm/headless) this reads. */
interface WatchedScreen {
    readonly rows: number;
    buffer: {
        active: {
            viewportY: number;
            getLine(y: number): {
                translateToString(trimRight?: boolean): string;
            } | undefined;
        };
    };
    onTitleChange(listener: (title: string) => void): {
        dispose(): void;
    };
    parser: {
        registerOscHandler(code: number, handler: (data: string) => boolean): {
            dispose(): void;
        };
    };
}
export interface WatchedTerminal {
    info: {
        state?: string;
        shell?: {
            name?: string;
        };
    };
    screen: WatchedScreen;
}
/**
 * What a CLI's terminal title says, the one signal both keep up without any setup or extra connection. Measured on Claude
 * Code 2.1.318 (`✳ title` at rest, `◐ title` at work) and Codex 0.166 (`folder`, `⠙ folder`, `[ ! ] Action Required | …`).
 */
export declare function titleActivity(title: string): 'idle' | 'running' | 'approval';
/**
 * What a status report such as `state=blocked:app=codex:kind=permission` says, if it says anything. Codex 0.166 sends idle,
 * working, blocked and, for a finished turn, done. Any other state counts as rest: a stale running row never clears, while
 * a wrong rest clears at its next report.
 */
export declare function reportActivity(report: string): TuiActivity | undefined;
/**
 * The dialog on Claude Code's screen, whose title reads at rest while one waits. The prompt mark sits on the highlighted
 * choice then and the prompt itself is gone, so the last mark on the screen tells them apart: on a numbered choice, or
 * above a line offering to cancel (the folder trust dialog numbers nothing).
 */
export declare function dialogOnScreen(rows: readonly string[]): 'approval' | 'question' | undefined;
/**
 * Whether Claude Code's spinner, right above its prompt, says it is compacting. Left idle for about 55 minutes it compacts by
 * itself before its prompt cache expires, for a minute or more. Its title and footer then read exactly as in a turn (measured
 * on 2.1.319), and this line is the one difference.
 */
export declare function compactingOnScreen(rows: readonly string[]): boolean;
/**
 * Watches TUI conversations' CLIs, so that they show as running, waiting and finished like every other conversation. DSH
 * runs no turn for these: their work happens in a terminal it knows nothing about, and it would list them as idle for good.
 */
export declare class TuiActivityWatcher {
    private readonly deps;
    private readonly watches;
    constructor(deps: {
        /** The TUI conversations. */
        sessions(): readonly string[];
        /** A conversation's open terminals. */
        terminals(sessionId: string): Iterable<WatchedTerminal>;
        /** Tell DSH's clients a conversation started or stopped running. */
        emit(sessionId: string, running: boolean): void;
        now?(): number;
    });
    /** Whether the conversation counts as running: DSH's own approvals count too, so a finish is only reported after them. */
    isBusy(sessionId: string): boolean;
    /** The conversations waiting on the user, by what they wait for. */
    waiting(): Record<string, 'approval' | 'question'>;
    check(): void;
    close(): void;
    /** The conversation's running terminal started from its CLI's launcher, as it may have others open. */
    private cliTerminal;
    private start;
    private stop;
    private update;
}
/**
 * Report TUI conversations' activity: running through DSH's own status event and list, waiting over a route of its own.
 * @param finished - told when a conversation stops running.
 */
export declare function installTuiActivity(ctx: Context, store: Pick<TuiStore, 'snapshot'>, finished?: (sessionId: string) => void): void;
export {};
