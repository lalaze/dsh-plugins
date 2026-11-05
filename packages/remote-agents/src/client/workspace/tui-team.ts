import React, { useEffect, useRef } from 'react';
import { localizeError } from '../i18n.js';
import { pressControl } from './tui-files.js';
import { bufferRows, findXterm } from './tui-render.js';

const PROMPT = /^\s*[❯›]\s?/;
/** Where the prompt's text ends: an empty row, the rule under Claude Code's prompt, or the status line under Codex's. */
const PROMPT_END = /^\s*$|^\s*─{3,}| · [~/]/;
/** Text a CLI wraps with no space to lose: Codex breaks after these and between CJK characters. */
const WRAPS_AFTER = /[-/\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff00-\uffef]$/u;
const WRAPS_BEFORE = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff00-\uffef]/u;
/**
 * The text at the CLI's prompt, read from its screen, as the terminal keeps no such thing. A wrapped row lost the space it
 * was wrapped at, if it had one. A word too long for a row gains a space where it was cut, which a /team line can bear.
 * @param rows - the screen's rows, top to bottom.
 */
export function promptText(rows: readonly string[]): string {
  const start = rows.findLastIndex(row => PROMPT.test(row));
  if (start < 0) return '';
  let text = rows[start].replace(PROMPT, '').trim();
  for (const row of rows.slice(start + 1)) {
    if (PROMPT_END.test(row)) break;
    const line = row.trim();
    text += (WRAPS_AFTER.test(text) || WRAPS_BEFORE.test(line) ? '' : ' ') + line;
  }
  return text.trim();
}
/** What follows /team in a line, or undefined for any other line. */
export function teamLine(text: string): string | undefined {
  const match = /^\/team(?:\s+(.*))?$/s.exec(text);
  return match ? (match[1] ?? '').trim() : undefined;
}
const CLEAR_PRESSES = 30;
/** With WebGL drawing, the rows are not in the page; it is only ever on where the terminal itself can be reached. */
const screenRows = (root: HTMLElement) => {
  const xterm = findXterm(root);
  return xterm ? bufferRows(xterm) : Array.from(root.querySelectorAll('.xterm-rows > div'), row => (row.textContent ?? '').replace(/ /g, ' ').trimEnd());
};

/**
 * Takes a /team line when Enter is pressed at the CLI's prompt, as neither CLI has such a command. The line stays there if
 * it fails, for the user to fix; once it works it is cleared, and the team's start reaches the CLI as a message.
 * @param start - starts the team from what follows /team.
 * @param failed - shows why it did not.
 */
export function useTeamLine(root: React.RefObject<HTMLElement | null>, start: (line: string) => Promise<void>, failed: (message: string) => void): void {
  const latest = useRef({ start, failed });
  latest.current = { start, failed };
  useEffect(() => {
    const node = root.current;
    if (!node) return;
    const key = (event: KeyboardEvent) => {
      if (!event.isTrusted || event.key !== 'Enter' || event.isComposing || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
      const line = teamLine(promptText(screenRows(node)));
      if (line === undefined) return;
      event.preventDefault(); event.stopPropagation();
      const { target } = event;
      latest.current.start(line).then(
        // Ctrl+U clears one wrapped row in Claude Code, and the team's panel opening has just narrowed the terminal. A few
        // too many do nothing.
        () => { for (let press = 0; press < CLEAR_PRESSES; press++) pressControl(target, 'u'); },
        cause => latest.current.failed(localizeError(cause)),
      );
    };
    node.addEventListener('keydown', key, true);
    return () => node.removeEventListener('keydown', key, true);
  }, [root]);
}
