import React, { useEffect, useRef } from 'react';
import { ui, useLocale } from './i18n.js';
import { findXterm, type Xterm } from './tui-render.js';

/** The Esc key as a terminal sends it: the byte alone, which a CLI reads as Esc once nothing follows it. */
export const ESC = '\x1b';

type Arrow = 'up' | 'down' | 'right' | 'left';
const ARROW_CODES: Record<Arrow, string> = { up: 'A', down: 'B', right: 'C', left: 'D' };

/**
 * What a key types into the terminal, as xterm's own keyboard handling sends it. An arrow depends on the mode the CLI set:
 * a CLI that asked for application cursor keys reads `ESC O A`, the others `ESC [ A`.
 */
export function keySequence(key: TuiKey, xterm?: { modes?: Partial<Xterm['modes']> }): string {
  if (key === 'esc') return ESC;
  if (key === 'tab') return '\t';
  if (key === 'backtab') return '\x1b[Z';
  return `${xterm?.modes?.applicationCursorKeysMode ? '\x1bO' : '\x1b['}${ARROW_CODES[key]}`;
}

export type TuiKey = 'esc' | 'tab' | 'backtab' | Arrow;
/** In the order of the row. */
export const TUI_KEYS: readonly TuiKey[] = ['esc', 'tab', 'backtab', 'up', 'down', 'left', 'right'];
const LABELS: Record<TuiKey, string> = {
  esc: 'Esc key', tab: 'Tab key', backtab: 'Shift+Tab key', up: 'Up arrow key', down: 'Down arrow key', left: 'Left arrow key', right: 'Right arrow key',
};
/** Held down, an arrow repeats as a keyboard's does: after this long, then this often. */
export const REPEAT_DELAY_MS = 400, REPEAT_INTERVAL_MS = 70;
/** What the row holds back on its right for the file and display buttons, which stay where they are. */
const BUTTONS_WIDTH = 84;
/** The row's height. The terminal is that much shorter on a touch screen, so nothing covers its last line. */
export const KEYS_HEIGHT = 48;

/**
 * Touch screens only: a row under the terminal, as wide as the TUI, with the same see-through background as the terminal.
 * The file and display buttons keep their places at its right end, and look the same: a grey that shows on a light row
 * as on a dark one. A computer has the keys.
 */
export const keyStyles = `.ra-tui-keys{display:none}
@media (pointer:coarse){.ra-tui-keys{display:flex;flex:none;align-items:center;gap:4px;box-sizing:border-box;height:${KEYS_HEIGHT}px;padding:0 ${BUTTONS_WIDTH}px 0 8px;background:rgba(255,255,255,.92);touch-action:none;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}
body[data-ds-dark-theme] .ra-tui-keys{background:rgba(21,21,23,.92)}
.ra-tui-key{display:flex;flex:1 1 0;align-items:center;justify-content:center;gap:1px;min-width:0;max-width:48px;height:32px;padding:0;border:none;border-radius:10px;background:rgba(127,127,127,.16);color:var(--dsw-alias-label-secondary,#888);opacity:.85;font:600 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:-.02em;white-space:nowrap;cursor:pointer;touch-action:none;-webkit-tap-highlight-color:transparent}
.ra-tui-key:active{background:var(--dsw-alias-interactive-bg-pressed,rgba(127,127,127,.4));opacity:1}
.ra-tui-key svg{flex:none}}`;

/** Drawn rather than typed: a phone's fonts may have no ⇧ or ⇥. */
function KeyFace({ name }: { name: TuiKey }) {
  if (name === 'esc') return <>Esc</>;
  if (name === 'tab') return <>Tab</>;
  const svg = (size: number, path: string) => <svg viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={path} /></svg>;
  if (name === 'backtab') return <>{svg(10, 'M8 2.5 2.5 8.5h3V13.5h5V8.5h3z')}Tab</>;
  const rotate: Record<Arrow, number> = { up: 0, right: 90, down: 180, left: 270 };
  return <span style={{ display: 'flex', transform: `rotate(${rotate[name]}deg)` }}>{svg(16, 'M8 13V3M3.5 7.5 8 3l4.5 4.5')}</span>;
}

/**
 * The keys a phone's keyboard lacks and the CLIs need: Esc closes a dialog or stops a turn, Shift+Tab switches Claude Code's
 * mode, the arrows move through its menus, its history and the prompt, Tab completes. They type into the terminal as a key
 * would, so a page that is not the one allowed to type sends nothing, and none takes the focus, so the keyboard stays as
 * it is: open, or closed while choosing from a menu.
 * @param root - an element around the terminal.
 */
export function TuiKeys({ root }: { root: React.RefObject<HTMLElement | null> }) {
  useLocale();
  const repeat = useRef<{ timer?: ReturnType<typeof setTimeout> }>({});
  const stop = () => { clearTimeout(repeat.current.timer); clearInterval(repeat.current.timer); repeat.current.timer = undefined; };
  useEffect(() => stop, []);
  const send = (key: TuiKey) => {
    const xterm = root.current ? findXterm(root.current) : undefined;
    xterm?.input?.(keySequence(key, xterm), true);
  };
  const held = (key: TuiKey) => key !== 'esc' && key !== 'tab' && key !== 'backtab';
  return <div className="ra-tui-keys" role="toolbar" aria-label={ui('Terminal keys')} data-remote-agents-tui-keys=""
    onMouseDown={event => event.preventDefault()} onContextMenu={event => event.preventDefault()}>
    {TUI_KEYS.map(key => <button key={key} type="button" className="ra-tui-key" data-key={key} aria-label={ui(LABELS[key])} title={ui(LABELS[key])}
      // An arrow types as the finger lands, and again while it stays.
      onPointerDown={held(key) ? event => {
        if (event.button !== 0) return;
        stop(); send(key);
        try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch { /* the pointer may be gone already */ }
        repeat.current.timer = setTimeout(() => { repeat.current.timer = setInterval(() => send(key), REPEAT_INTERVAL_MS); }, REPEAT_DELAY_MS);
      } : undefined}
      onPointerUp={held(key) ? stop : undefined} onPointerCancel={held(key) ? stop : undefined} onLostPointerCapture={held(key) ? stop : undefined}
      // A click from a pointer was typed when it landed; one from the keyboard or a screen reader has no pointer before it.
      onClick={event => { if (!held(key) || event.detail === 0) send(key); }}>
      <KeyFace name={key} />
    </button>)}
  </div>;
}
