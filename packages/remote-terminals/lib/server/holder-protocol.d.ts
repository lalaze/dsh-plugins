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
 * size takes the screen back when its user types. What a terminal sends by itself — answers to the CLI's questions,
 * focus and mouse reports, arrow keys — starts with ESC and takes nothing, or two terminals would fight over the size
 * every time the CLI asked them something.
 */
export declare const claimsScreen: (input: Uint8Array) => boolean;
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
/** A TUI conversation has one CLI whatever DSH terminal shows it, and whichever DSH: `key` is its `tuiKey`. */
export declare const tuiHolder: (key: string) => string;
/** A sidebar terminal is its tab: DSH gives it the same ID again when the tab comes back after a restart. */
export declare const tabHolder: (sessionId: string, terminalId: string) => string;
/** Under `~` on the SSH host. */
export declare const HOLDER_FOLDER = ".dsh-remote-agents/terminal", HOLDERS_FOLDER = ".dsh-remote-agents/terminals-v1";
/** Under `~` on the SSH host: the TUI conversations every DSH using this account shows, one file each. See tui-shared.ts. */
export declare const SHARED_TUI_FOLDER = ".dsh-remote-agents/tui-v1";
/**
 * Shell that ends a holder and what runs in it. The process is checked first, as a saved process ID may belong to something else after a reboot.
 * Written without the holder's script, so that it works on any holder an older version of the plugin started.
 * It waits for the holder to tidy up, a few seconds at most: until its folder is gone a new terminal would join it and end with it.
 */
export declare const endHolderScript: (holder: string) => string;
