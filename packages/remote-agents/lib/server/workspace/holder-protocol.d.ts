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
};
/**
 * What `terminal-holder.mjs attach` exits with, other than the terminal's own code. The launcher takes these codes as
 * meaning the holder, so a terminal that exits with one of them reports 1. ssh itself exits with 255 when the connection is lost.
 */
export declare const ATTACH_EXIT: {
    readonly noScript: 117;
    readonly noRuntime: 118;
    readonly noPty: 119;
    readonly lost: 254;
    readonly ssh: 255;
};
export declare const attachExitCode: (code: number | null | undefined) => number;
/** The environment variable that tells the launcher which DSH terminal it is. See installWorkspaceTerminal. */
export declare const TERMINAL_ID_ENV = "DSH_TERMINAL_ID";
/** A TUI conversation has one CLI whatever DSH terminal shows it. */
export declare const tuiHolder: (sessionId: string) => string;
/** A sidebar terminal is its tab: DSH gives it the same ID again when the tab comes back after a restart. */
export declare const tabHolder: (sessionId: string, terminalId: string) => string;
/** Under `~` on the SSH host. */
export declare const HOLDER_FOLDER = ".dsh-remote-agents/terminal", HOLDERS_FOLDER = ".dsh-remote-agents/terminals-v1";
/**
 * Shell that ends a holder and what runs in it. The process is checked first, as a saved process ID may belong to something else after a reboot.
 * Written without the holder's script, so that it works on any holder an older version of the plugin started.
 */
export declare const endHolderScript: (holder: string) => string;
