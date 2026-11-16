import { createHash } from 'node:crypto';
/**
 * How the launcher on DSH's machine and the terminal holder on the SSH host (terminal-holder.ts) understand each other.
 * A holder keeps running across plugin updates, so the frames may only ever be added to.
 */
export const FRAME = { hello: 1, input: 2, resize: 3, output: 4, exit: 5, size: 6 };
/**
 * A terminal may have several clients, as when one TUI conversation is open in two DSHes, and its screen has one size:
 * that of the client that came or resized last. The holder tells its clients the size (`size`), and a client of another
 * size takes the screen back when its user types or pastes (`typed`), or when its terminal gains focus (`focus`): coming
 * back to a computer, or opening the conversation on a phone. Other things a terminal sends by itself — answers to the
 * CLI's questions, focus-out, mouse reports, arrow keys — start with ESC and take nothing, or two terminals would fight
 * over the size every time the CLI asked them something.
 * A terminal also reports focus by itself whenever the CLI turns focus reports on, so a focus-in right after the size
 * changed hands may be that answer: see FOCUS_SETTLE_MS.
 */
export function screenClaim(input) {
    if (input.length === 0)
        return undefined;
    if (input[0] !== 0x1b)
        return 'typed';
    const starts = (sequence) => input.length >= sequence.length && [...sequence].every((char, at) => input[at] === char.charCodeAt(0));
    if (starts(FOCUS_IN))
        return 'focus';
    return starts(PASTE_START) ? 'typed' : undefined;
}
const FOCUS_IN = '\x1b[I', PASTE_START = '\x1b[200~';
/**
 * How long after the holder said the size changed a focus-in takes nothing. Neither Claude Code nor Codex turns focus
 * reports on again after a resize (measured 2026-11-15 with 2.1.325 and 0.166), but a CLI that did would have every
 * focused terminal answer at once, and each answer would take the screen again.
 */
export const FOCUS_SETTLE_MS = 1000;
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
/** A TUI conversation has one CLI whatever DSH terminal shows it, and whichever DSH: `key` is its `tuiKey`. */
export const tuiHolder = (key) => hashed('tui', key);
/** A sidebar terminal is its tab: DSH gives it the same ID again when the tab comes back after a restart. */
export const tabHolder = (sessionId, terminalId) => hashed('tab', sessionId, terminalId);
/** Under `~` on the SSH host. */
export const HOLDER_FOLDER = '.dsh-remote-agents/terminal', HOLDERS_FOLDER = '.dsh-remote-agents/terminals-v1';
/** Under `~` on the SSH host: the TUI conversations every DSH using this account shows, one file each. See tui-shared.ts. */
export const SHARED_TUI_FOLDER = '.dsh-remote-agents/tui-v1';
/**
 * Shell that ends a holder and what runs in it. The process is checked first, as a saved process ID may belong to something else after a reboot.
 * Written without the holder's script, so that it works on any holder an older version of the plugin started.
 * It waits for the holder to tidy up, a few seconds at most: until its folder is gone a new terminal would join it and end with it.
 */
export const endHolderScript = (holder) => `dsh_pid="$(cat "$HOME/${HOLDERS_FOLDER}/${holder}/pid" 2>/dev/null)" || exit 0
case "$(ps -o command= -p "$dsh_pid" 2>/dev/null)" in *" daemon "*"${holder}"*) kill "$dsh_pid" ;; *) exit 0 ;; esac
dsh_tries=0
while [ -d "$HOME/${HOLDERS_FOLDER}/${holder}" ] && [ "$dsh_tries" -lt 50 ]; do sleep 0.1; dsh_tries=$((dsh_tries + 1)); done`;
