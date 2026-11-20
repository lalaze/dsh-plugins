/**
 * What `terminal-holder.mjs attach` exits with, other than the terminal's own code. The launcher takes these codes as
 * meaning the holder, so a terminal that exits with one of them reports 1. ssh itself exits with 255 when the connection is lost.
 * `idle` is a TUI conversation that went unused for a day: it reaches DSH as the terminal's exit code, and opening the
 * conversation again starts its CLI again (see TuiTerminal). Apart from the rest, as the page reads it too.
 */
export declare const ATTACH_EXIT: {
    readonly idle: 116;
    readonly noScript: 117;
    readonly noRuntime: 118;
    readonly noPty: 119;
    readonly lost: 254;
    readonly ssh: 255;
};
export declare const attachExitCode: (code: number | null | undefined) => number;
