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
const informative = (row) => row.trim().length >= 3 && /[\p{L}\p{N}]/u.test(row);
/**
 * Where the screen's first row is in what the copy printed, so that the rows before it are the scrollback; undefined if the
 * screen's rows are not there, as when the CLI printed more than a screen since the copy read the conversation, or the CLI
 * now runs another conversation. Anchored on the screen's top rows, which are what meets the scrollback; the bottom has the
 * prompt and whatever the CLI is doing now. The last place they match, as tool output repeats in a long conversation.
 */
export function alignScreen(printed, screen) {
    const rows = screen.flatMap((text, at) => (informative(text) ? [{ text, at }] : []));
    // The first rows may be the end of a message drawn before the width changed; then the next ones decide.
    for (let skip = 0; skip + 3 <= Math.min(rows.length, 7); skip++) {
        const anchor = rows.slice(skip, skip + 4), last = anchor.at(-1).at;
        for (let start = printed.length - 1 - last; start >= 0; start--) {
            if (anchor.every(row => printed[start + row.at] === row.text))
                return start;
        }
    }
    return undefined;
}
/**
 * What turns a terminal of `rows` rows into the rebuilt one, whatever it showed: empty it, scrollback included, write the
 * history, push it all above the screen, then draw the screen from its top. `history` ends without a line break and with
 * no cursor move of its own; `screen` is drawn from the top-left of an empty screen and ends with the cursor in place.
 */
export function reflowText(history, historyRows, rows, screen) {
    const reset = '\x1b[0m';
    return `\x1b[H\x1b[2J\x1b[3J${reset}${historyRows > 0 ? `${history}${reset}\r\n` : ''}${'\r\n'.repeat(Math.max(0, rows - 1))}\x1b[H${screen}${reset}`;
}
