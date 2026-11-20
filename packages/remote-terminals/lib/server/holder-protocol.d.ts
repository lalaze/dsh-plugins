/**
 * How the launcher on DSH's machine and the terminal holder on the SSH host (terminal-holder.ts) understand each other.
 * A holder keeps running across plugin updates, so the frames may only ever be added to.
 */
export declare const FRAME: {
    readonly hello: 1;
    readonly input: 2;
    readonly resize: 3;
    readonly output: 4;
    readonly exit: 5;
    readonly size: 6;
};
/**
 * A terminal may have several clients, as when one TUI conversation is open in two DSHes, and its screen has one size:
 * that of the client that came or resized last. The holder tells its clients the size (`size`), and a client of another
 * size takes the screen back when its user types or pastes (`typed`), or when its terminal gains focus (`focus`): coming
 * back to a computer, or opening the conversation on a phone. Other things a terminal sends by itself — answers to the
 * CLI's questions, focus-out, mouse reports, arrow keys — start with ESC and take nothing, or two terminals would fight
 * over the size every time the CLI asked them something.
 * A terminal also reports focus by itself whenever the CLI turns focus reports on, so a focus-in right after the size
 * changed hands may be that answer: see FOCUS_SETTLE_MS. A CLI that never turns them on still sees none: see FocusReports.
 */
export declare function screenClaim(input: Uint8Array): 'typed' | 'focus' | undefined;
/**
 * Whether the CLI asked for focus reports (`CSI ? 1004 h`), followed through what it prints. A page claims the screen with
 * a focus-in whether it did or not, as Antigravity never does (measured with 1.5.12), and a CLI that did not ask must not
 * be sent them: it may read them as keys, as a shell does. A client that joins hears the mode in the holder's snapshot,
 * which starts with a reset.
 */
export declare class FocusReports {
    on: boolean;
    /** The end of the last output, in case a sequence was split between two. */
    private tail;
    read(output: Uint8Array): void;
}
/** Whether a terminal's input is nothing but focus reports: a focus change, or a page claiming the screen. */
export declare const onlyFocusReports: (input: Uint8Array) => boolean;
/**
 * How long after the holder said the size changed a focus-in takes nothing. Neither Claude Code nor Codex turns focus
 * reports on again after a resize (measured 2026-11-15 with 2.1.325 and 0.166), but a CLI that did would have every
 * focused terminal answer at once, and each answer would take the screen again.
 */
export declare const FOCUS_SETTLE_MS = 1000;
export { ATTACH_EXIT, attachExitCode } from './holder-exit.js';
/** The environment variable that tells the launcher which DSH terminal it is. See installWorkspaceTerminal. */
export declare const TERMINAL_ID_ENV = "DSH_TERMINAL_ID";
/** A TUI conversation has one CLI whatever DSH terminal shows it, and whichever DSH: `key` is its `tuiKey`. */
export declare const tuiHolder: (key: string) => string;
/** A sidebar terminal is its tab: DSH gives it the same ID again when the tab comes back after a restart. */
export declare const tabHolder: (sessionId: string, terminalId: string) => string;
/** Under `~` on the SSH host. */
export declare const HOLDER_FOLDER = ".dsh-remote-agents/terminal", HOLDERS_FOLDER = ".dsh-remote-agents/terminals-v1";
/**
 * Shell that ends a holder and what runs in it. The process is checked first, as a saved process ID may belong to something else after a reboot.
 * Written without the holder's script, so that it works on any holder an older version of the plugin started.
 * It waits for the holder to tidy up, a few seconds at most: until its folder is gone a new terminal would join it and end with it.
 */
export declare const endHolderScript: (holder: string) => string;
