import type { Store } from '../core/store.js';
/** A line of the terminal's screen, as @xterm/headless gives it. */
export interface ScreenLine {
    readonly length: number;
    translateToString(trimRight?: boolean): string;
    getCell(x: number): {
        getChars(): string;
        isDim(): number;
        isInverse(): number;
    } | undefined;
}
/** The running terminal of a TUI conversation. */
export interface CaptainTerminal {
    /** The screen's visible lines, top to bottom. */
    lines(): readonly ScreenLine[];
    write(data: string): Promise<void>;
}
export interface TeamResult {
    kind: 'success' | 'error';
    text?: string;
}
/**
 * Whether the CLI is waiting at an empty prompt, the only time text can be typed into it safely. Both CLIs draw their
 * prompt with one mark, and a placeholder or a suggestion after it dim or with the cursor on its first letter, as text
 * being typed has it at the end. They also mark the highlighted choice of a dialog with it, so a question or a permission
 * prompt counts as text and is left alone: Enter there would answer it.
 */
export declare function promptIsEmpty(lines: readonly ScreenLine[]): boolean;
/** What the CLI needs to know beside the team's own message: it has none of DSH's system prompt. */
export declare const CAPTAIN_GUIDE = "This session is the team's captain. Members work on their own and report here: each report arrives as a message starting \"AgentTeams message from member\". Stop and wait for them rather than polling or doing their work yourself. When something needs changing, use the other tools on the dsh-agent-teams MCP server. When the reports are in, tell the user the outcome.";
/**
 * A TUI conversation as an AgentTeams captain. AgentTeams wakes its captain with a DSH turn; here the captain is a CLI in a
 * terminal, so that turn hands the team's message to the terminal instead of starting another CLI. Messages wait in the
 * saved state until the CLI is at an empty prompt, so nothing the user is typing is sent, nothing it is asking is answered,
 * and a restart loses none.
 */
export declare class TuiCaptain {
    private readonly store;
    private readonly terminal;
    private readonly delays;
    /** Runs what follows /team for a conversation; set once the team command's services are up. */
    startTeam?: (sessionId: string, line: string, signal: AbortSignal) => Promise<TeamResult>;
    private timer?;
    private running;
    private closed;
    /** Conversations whose prompt was empty at the last check. */
    private readonly empty;
    constructor(store: Pick<Store, 'snapshot' | 'update'>, terminal: (sessionId: string) => CaptainTerminal | undefined, delays?: {
        poll: number;
        submit: number;
    });
    isTui(sessionId: string): boolean;
    waiting(sessionId: string): number;
    /** Queue messages for the conversation's CLI. */
    deliver(sessionId: string, messages: readonly string[]): Promise<void>;
    /** The user typed /team in the terminal: start the team here, as DSH's composer would, and tell the CLI. */
    team(sessionId: string, line: string, signal: AbortSignal): Promise<string>;
    private schedule;
    private flush;
    close(): void;
}
