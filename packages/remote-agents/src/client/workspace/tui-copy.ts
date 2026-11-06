import { useEffect, useRef } from 'react';
import { lookForXterm, type Xterm } from './tui-render.js';

/** The sequence a program sends to set the clipboard of the computer the user sits at, its only way there over SSH. */
const OSC_CLIPBOARD = 52;

/**
 * The text a terminal program asks to put on the clipboard.
 * @param data - the sequence's content: which clipboards, a semicolon, then base64.
 * @returns undefined for anything else: another clipboard, damaged data, or a request to read, which is never answered as
 * that would show the clipboard to whatever prints to the terminal.
 */
export function clipboardRequest(data: string): string | undefined {
  const split = data.indexOf(';');
  if (split < 0) return undefined;
  const targets = data.slice(0, split), payload = data.slice(split + 1);
  if (targets && !targets.includes('c') || !payload || payload === '?') return undefined;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(payload), char => char.charCodeAt(0)));
  } catch {
    return undefined;
  }
}

/** The browser's old way, as a page it does not consider secure has no clipboard API. The copy event supplies the text, so focus stays in the terminal. */
function copyByCommand(text: string): boolean {
  const fill = (event: ClipboardEvent) => { event.clipboardData?.setData('text/plain', text); event.preventDefault(); };
  document.addEventListener('copy', fill, true);
  try { return document.execCommand('copy'); } finally { document.removeEventListener('copy', fill, true); }
}

/** @returns whether the text reached the clipboard. */
export async function writeClipboard(text: string, clipboard: Pick<Clipboard, 'writeText'> | undefined = navigator.clipboard, command: (text: string) => boolean = copyByCommand): Promise<boolean> {
  try {
    if (clipboard) { await clipboard.writeText(text); return true; }
  } catch { /* refused: the old way may still be allowed */ }
  return command(text);
}

/** The terminal modes that turn on mouse reports, each replacing the one before. */
const MOUSE_MODES = new Set([1000, 1002, 1003]);

/**
 * Keeps a drag going when a program repeats the mouse modes it already set, as Claude Code does on the first input after some
 * seconds of quiet. On its way back to the same mode xterm passes through lesser ones, and that drops its drag listener
 * until the next press. A press on text just read then selects only what was dragged over before the repeat came back.
 * @param page - where a release is heard, as it may come outside the terminal.
 * @returns ends this.
 */
export function holdMouseModesDuringDrag(xterm: Xterm, page: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> = window): { dispose(): void } {
  let held = false;
  const press = () => { held = true; }, release = () => { held = false; };
  xterm.element?.addEventListener('mousedown', press, true);
  page.addEventListener('mouseup', release, true);
  const handler = xterm.parser.registerCsiHandler({ prefix: '?', final: 'h' }, params => held && xterm.modes.mouseTrackingMode !== 'none' && params.every(mode => MOUSE_MODES.has(mode as number)));
  return { dispose() {
    handler.dispose();
    xterm.element?.removeEventListener('mousedown', press, true);
    page.removeEventListener('mouseup', release, true);
  } };
}

/**
 * Makes Claude Code's copying work in DSH's terminal. Claude Code takes the mouse and draws its own selection, so to xterm
 * nothing is ever selected, and it copies by asking the terminal to set the clipboard, which DSH's terminal ignores.
 * @param host - the element around the terminal.
 * @param visible - whether the terminal is on screen. One out of view, or in another window on the same CLI, must not replace what the user just copied.
 */
export function useTerminalCopy(host: HTMLElement, visible: boolean): void {
  const shown = useRef(visible);
  shown.current = visible;
  const active = useRef<Array<{ dispose(): void }>>();
  useEffect(() => {
    if (!visible || active.current) return;
    return lookForXterm(host, xterm => {
      active.current = [holdMouseModesDuringDrag(xterm), xterm.parser.registerOscHandler(OSC_CLIPBOARD, data => {
        const text = clipboardRequest(data);
        if (text !== undefined && shown.current && document.hasFocus()) {
          void writeClipboard(text).then(written => { if (!written) console.warn('[remote-agents] The browser refused to copy from the terminal'); });
        }
        return true;
      })];
    });
  }, [visible, host]);
  useEffect(() => () => { for (const part of active.current ?? []) part.dispose(); active.current = undefined; }, []);
}
