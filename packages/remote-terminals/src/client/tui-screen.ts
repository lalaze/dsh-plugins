import { useEffect } from 'react';
import { findXterm, type Xterm } from './tui-render.js';

/** How long after a TUI comes into view to look whether its terminal took focus by itself, which DSH asks for at once. */
const SETTLE_MS = 300;

/**
 * Tells the host that this page is the one being looked at, so that a TUI open on two devices takes this one's size (see
 * `screenClaim` on the host). A focus-in is how a terminal says it, and xterm sends one by itself whenever it gains focus,
 * if the CLI asked for focus reports. This covers a terminal shown without gaining it: on a phone, where a plugin refuses
 * focus the finger did not give, or after a click elsewhere on the page; and a CLI that never asks, as Antigravity, whose
 * terminal says nothing even with focus. Focus-out follows at once. The host keeps both from a CLI that did not ask (see
 * `FocusReports`), and one that did hears the truth: the terminal has no focus.
 * Not before the host has drawn anything: see `drawn`.
 * @param focused - whether the terminal has focus, and so said it by itself if the CLI asked.
 * @returns whether it told the host.
 */
export function claimScreen(xterm: Xterm, focused: boolean): boolean {
  if (focused && xterm.modes.sendFocusMode || typeof xterm.input !== 'function' || !drawn(xterm)) return false;
  xterm.input('\x1b[I', false);
  xterm.input('\x1b[O', false);
  return true;
}

/**
 * Whether the host has drawn anything in the terminal: DSH writes nothing else there, and a new one starts with its cursor
 * home. Until then the launcher is starting, in a terminal that still echoes what it is sent, so a claim would show as
 * `^[[I^[[O` above the CLI (measured: a TUI starting a new holder echoed for 0.6 s, and the claim goes 0.3 s after the TUI
 * comes into view).
 * Nothing is lost: a client joining the holder takes the screen anyway. An xterm that does not say counts as drawn.
 */
function drawn(xterm: Xterm): boolean {
  const { cursorX, cursorY, baseY } = xterm.buffer.active;
  return typeof cursorX !== 'number' || cursorX > 0 || !!cursorY || !!baseY;
}

/**
 * Claims the screen when the TUI comes into view, when the window or the tab comes back while it is shown, and when its
 * terminal gains focus, which xterm reports only to a CLI that asked. A page that is not the one allowed to type has its
 * terminal's input switched off, and sends nothing.
 */
export function useScreenClaim(host: HTMLElement, visible: boolean): void {
  useEffect(() => {
    if (!visible) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const claim = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (document.visibilityState !== 'visible') return;
        const xterm = findXterm(host);
        if (xterm) claimScreen(xterm, document.hasFocus() && xterm.textarea !== undefined && document.activeElement === xterm.textarea);
      }, SETTLE_MS);
    };
    const shown = () => { if (document.visibilityState === 'visible') claim(); };
    claim();
    window.addEventListener('focus', claim);
    document.addEventListener('visibilitychange', shown);
    host.addEventListener('focusin', claim);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('focus', claim);
      document.removeEventListener('visibilitychange', shown);
      host.removeEventListener('focusin', claim);
    };
  }, [host, visible]);
}
