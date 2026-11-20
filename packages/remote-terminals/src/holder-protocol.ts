import { createHash } from 'node:crypto';

/**
 * How the launcher on DSH's machine and the terminal holder on the SSH host (terminal-holder.ts) understand each other.
 * A holder keeps running across plugin updates, so the frames may only ever be added to.
 */
export const FRAME = { hello: 1, input: 2, resize: 3, output: 4, exit: 5, size: 6 } as const;
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
export function screenClaim(input: Uint8Array): 'typed' | 'focus' | undefined {
  if (input.length === 0) return undefined;
  if (input[0] !== 0x1b) return 'typed';
  const starts = (sequence: string) => input.length >= sequence.length && [...sequence].every((char, at) => input[at] === char.charCodeAt(0));
  if (starts(FOCUS_IN)) return 'focus';
  return starts(PASTE_START) ? 'typed' : undefined;
}
const FOCUS_IN = '\x1b[I', PASTE_START = '\x1b[200~';
/**
 * Whether the CLI asked for focus reports (`CSI ? 1004 h`), followed through what it prints. A page claims the screen with
 * a focus-in whether it did or not, as Antigravity never does (measured with 1.5.12), and a CLI that did not ask must not
 * be sent them: it may read them as keys, as a shell does. A client that joins hears the mode in the holder's snapshot,
 * which starts with a reset.
 */
export class FocusReports {
  on = false;
  /** The end of the last output, in case a sequence was split between two. */
  private tail = '';
  read(output: Uint8Array): void {
    const text = this.tail + Buffer.from(output.buffer, output.byteOffset, output.byteLength).toString('latin1');
    this.tail = text.slice(-32);
    // Matches already read in the tail are read again, in order, so the last of them still decides.
    for (const [sequence, params, final] of text.matchAll(/\x1bc|\x1b\[\?([\d;]*)([hl])/g)) {
      if (sequence === '\x1bc') this.on = false;
      else if (params!.split(';').includes('1004')) this.on = final === 'h';
    }
  }
}
/** Whether a terminal's input is nothing but focus reports: a focus change, or a page claiming the screen. */
export const onlyFocusReports = (input: Uint8Array) => input.length > 0 && /^(?:\x1b\[[IO])+$/.test(Buffer.from(input.buffer, input.byteOffset, input.byteLength).toString('latin1'));
/**
 * How long after the holder said the size changed a focus-in takes nothing. Neither Claude Code nor Codex turns focus
 * reports on again after a resize (measured 2026-11-15 with 2.1.325 and 0.166), but a CLI that did would have every
 * focused terminal answer at once, and each answer would take the screen again.
 */
export const FOCUS_SETTLE_MS = 1000;
export { ATTACH_EXIT, attachExitCode } from './holder-exit.js';

/** The environment variable that tells the launcher which DSH terminal it is. See installWorkspaceTerminal. */
export const TERMINAL_ID_ENV = 'DSH_TERMINAL_ID';
const hashed = (kind: string, ...parts: string[]) => `${kind}-${createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32)}`;
/** A TUI conversation has one CLI whatever DSH terminal shows it, and whichever DSH: `key` is its `tuiKey`. */
export const tuiHolder = (key: string) => hashed('tui', key);
/** A sidebar terminal is its tab: DSH gives it the same ID again when the tab comes back after a restart. */
export const tabHolder = (sessionId: string, terminalId: string) => hashed('tab', sessionId, terminalId);

/** Under `~` on the SSH host. */
export const HOLDER_FOLDER = '.dsh-remote-agents/terminal', HOLDERS_FOLDER = '.dsh-remote-agents/terminals-v1';
/**
 * Shell that ends a holder and what runs in it. The process is checked first, as a saved process ID may belong to something else after a reboot.
 * Written without the holder's script, so that it works on any holder an older version of the plugin started.
 * It waits for the holder to tidy up, a few seconds at most: until its folder is gone a new terminal would join it and end with it.
 */
export const endHolderScript = (holder: string) => `dsh_pid="$(cat "$HOME/${HOLDERS_FOLDER}/${holder}/pid" 2>/dev/null)" || exit 0
case "$(ps -o command= -p "$dsh_pid" 2>/dev/null)" in *" daemon "*"${holder}"*) kill "$dsh_pid" ;; *) exit 0 ;; esac
dsh_tries=0
while [ -d "$HOME/${HOLDERS_FOLDER}/${holder}" ] && [ "$dsh_tries" -lt 50 ]; do sleep 0.1; dsh_tries=$((dsh_tries + 1)); done`;
