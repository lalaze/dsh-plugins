/**
 * Rebuilding a terminal's scrollback at a new width. Claude Code's classic renderer (see TuiSessions.localScroll) breaks
 * its lines itself, so a terminal cannot re-wrap them, and when the width changes it repaints only the screen: everything
 * above keeps the old width, and the text where the two meet shows twice (measured 2026-11-15 with 2.1.325). A shared TUI
 * conversation changes width whenever the user turns from the computer to the phone or back.
 *
 * The holder runs a copy of the CLI that prints the conversation again at the new width (`--fork-session`, which saves
 * nothing until it is sent a message), finds where the live screen's rows are in what the copy printed, and replaces
 * everything above the screen with the copy's rows before that point. The screen itself stays as it is, row for row, with
 * the cursor where it was, as the CLI goes on drawing it with relative moves. Modes are not reset either: a terminal
 * answers a focus-report switch with its focus, which would take the screen for that terminal; see screenClaim.
 */

/** A row worth matching on: blank rows, rules and lone prompt marks are on every screen. */
const informative = (row: string) => row.trim().length >= 3 && /[\p{L}\p{N}]/u.test(row);

/**
 * Where the screen's first row is in what the copy printed, so that the rows before it are the scrollback; undefined if the
 * screen's rows are not there, as when the CLI printed more than a screen since the copy read the conversation, or the CLI
 * now runs another conversation. Anchored on the screen's top rows, which are what meets the scrollback; the bottom has the
 * prompt and whatever the CLI is doing now. The last place they match, as tool output repeats in a long conversation.
 */
export function alignScreen(printed: readonly string[], screen: readonly string[]): number | undefined {
  const rows = screen.flatMap((text, at) => (informative(text) ? [{ text, at }] : []));
  // The first rows may be the end of a message drawn before the width changed; then the next ones decide.
  for (let skip = 0; skip + 3 <= Math.min(rows.length, 7); skip++) {
    const anchor = rows.slice(skip, skip + 4), last = anchor.at(-1)!.at;
    for (let start = printed.length - 1 - last; start >= 0; start--) {
      if (anchor.every(row => printed[start + row.at] === row.text)) return start;
    }
  }
  return alignLoosely(printed, rows);
}

/** Rows of the screen in order that must be found in the copy, when some of the screen's rows are not there. */
const LOOSE_MATCHES = 4;
/** Screen rows passed over while looking for those, and rows the copy may have between two of them that the screen lacks. */
const LOOSE_SKIPS = 3, LOOSE_EXTRA = 2;
/** How far down the screen the first of them may be. */
const LOOSE_FIRST = 8;

/**
 * The screen of a live CLI can have rows that a copy printing the same conversation lacks, which no fixed offsets match.
 * Claude Code 2.1.326 shows "⎿  Allowed by auto mode" and "⎿  (timeout 2m)" under a tool call only in the session that ran
 * it, and after a change of width it may repaint a tool call's header as first drawn, at the old width (both seen
 * 2026-11-17 on a phone's conversation in auto mode, whose every rebuild at the computer's width failed). Here the screen's
 * rows are followed in order, each found a little below the one before in the copy, passing over the ones it lacks. The
 * rows above the first match are taken to be in the copy one for one; when some were not, the scrollback ends a row or two
 * short, which still beats a scrollback at the old width.
 */
function alignLoosely(printed: readonly string[], rows: readonly { text: string; at: number }[]): number | undefined {
  const places = new Map<string, number[]>();
  printed.forEach((text, at) => {
    if (!informative(text)) return;
    const list = places.get(text);
    if (list) list.push(at); else places.set(text, [at]);
  });
  for (let first = 0; first < Math.min(rows.length, LOOSE_FIRST); first++) {
    const head = rows[first]!, found = places.get(head.text) ?? [];
    for (let k = found.length - 1; k >= 0; k--) {
      let matched = 1, skipped = 0, copyAt = found[k]!, screenAt = head.at;
      for (let next = first + 1; next < rows.length && matched < LOOSE_MATCHES && skipped <= LOOSE_SKIPS; next++) {
        const row = rows[next]!, most = Math.min(printed.length - 1, copyAt + (row.at - screenAt) + LOOSE_EXTRA);
        let hit = -1;
        for (let at = copyAt + 1; at <= most && hit < 0; at++) if (printed[at] === row.text) hit = at;
        if (hit < 0) { skipped++; continue; }
        matched++; copyAt = hit; screenAt = row.at;
      }
      if (matched >= LOOSE_MATCHES) return Math.max(0, found[k]! - head.at);
    }
  }
  return undefined;
}

/**
 * What turns a terminal of `rows` rows into the rebuilt one, whatever it showed: empty it, scrollback included, write the
 * history, push it all above the screen, then draw the screen from its top. `history` ends without a line break and with
 * no cursor move of its own; `screen` is drawn from the top-left of an empty screen and ends with the cursor in place.
 */
export function reflowText(history: string, historyRows: number, rows: number, screen: string): string {
  const reset = '\x1b[0m';
  return `\x1b[H\x1b[2J\x1b[3J${reset}${historyRows > 0 ? `${history}${reset}\r\n` : ''}${'\r\n'.repeat(Math.max(0, rows - 1))}\x1b[H${screen}${reset}`;
}
