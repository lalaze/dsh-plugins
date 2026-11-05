import { createHash } from 'node:crypto';
/**
 * How the launcher on DSH's machine and the terminal holder on the SSH host (terminal-holder.ts) understand each other.
 * A holder keeps running across plugin updates, so the frames may only ever be added to.
 */
export const FRAME = { hello: 1, input: 2, resize: 3, output: 4, exit: 5 };
/**
 * What `terminal-holder.mjs attach` exits with, other than the terminal's own code. The launcher takes these codes as
 * meaning the holder, so a terminal that exits with one of them reports 1. ssh itself exits with 255 when the connection is lost.
 */
export const ATTACH_EXIT = { noScript: 117, noRuntime: 118, noPty: 119, lost: 254, ssh: 255 };
const RESERVED = new Set(Object.values(ATTACH_EXIT));
export const attachExitCode = (code) => (code === null || code === undefined ? 1 : RESERVED.has(code) ? 1 : code);
/** The environment variable that tells the launcher which DSH terminal it is. See installWorkspaceTerminal. */
export const TERMINAL_ID_ENV = 'DSH_TERMINAL_ID';
const hashed = (kind, ...parts) => `${kind}-${createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32)}`;
/** A TUI conversation has one CLI whatever DSH terminal shows it. */
export const tuiHolder = (sessionId) => hashed('tui', sessionId);
/** A sidebar terminal is its tab: DSH gives it the same ID again when the tab comes back after a restart. */
export const tabHolder = (sessionId, terminalId) => hashed('tab', sessionId, terminalId);
/** Under `~` on the SSH host. */
export const HOLDER_FOLDER = '.dsh-remote-agents/terminal', HOLDERS_FOLDER = '.dsh-remote-agents/terminals-v1';
/**
 * Shell that ends a holder and what runs in it. The process is checked first, as a saved process ID may belong to something else after a reboot.
 * Written without the holder's script, so that it works on any holder an older version of the plugin started.
 */
export const endHolderScript = (holder) => `dsh_pid="$(cat "$HOME/${HOLDERS_FOLDER}/${holder}/pid" 2>/dev/null)" || exit 0
case "$(ps -o command= -p "$dsh_pid" 2>/dev/null)" in *" daemon "*"${holder}"*) kill "$dsh_pid" ;; esac`;
