/**
 * What `terminal-holder.mjs attach` exits with, other than the terminal's own code. The launcher takes these codes as
 * meaning the holder, so a terminal that exits with one of them reports 1. ssh itself exits with 255 when the connection is lost.
 * `idle` is a TUI conversation that went unused for a day: it reaches DSH as the terminal's exit code, and opening the
 * conversation again starts its CLI again (see TuiTerminal). Apart from the rest, as the page reads it too.
 */
export const ATTACH_EXIT = { idle: 116, noScript: 117, noRuntime: 118, noPty: 119, lost: 254, ssh: 255 };
const RESERVED = new Set(Object.values(ATTACH_EXIT));
export const attachExitCode = (code) => (code === null || code === undefined ? 1 : RESERVED.has(code) ? 1 : code);
