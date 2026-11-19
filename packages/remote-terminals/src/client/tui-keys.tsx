import React from 'react';
import { ui, useLocale } from './i18n.js';
import { findXterm } from './tui-render.js';

/** The Esc key as a terminal sends it: the byte alone, which a CLI reads as Esc once nothing follows it. */
export const ESC = '\x1b';

/** Touch screens only, left of the file button. A computer has the key. */
export const keyStyles = `.ra-tui-esc{display:none}
@media (pointer:coarse){.ra-tui-esc{display:block;position:absolute;right:84px;bottom:8px;z-index:2}
.ra-tui-esc-button{display:flex;align-items:center;justify-content:center;width:32px;height:32px;padding:0;border:none;border-radius:10px;background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.2));color:var(--dsw-alias-label-tertiary,#888);opacity:.85;font:600 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;cursor:pointer}}`;

/**
 * Esc for a phone, whose keyboard has none: it closes a CLI's dialog, such as Claude Code's /usage, or stops a turn, as
 * the key does. It types into the terminal as a key would, so a page that is not the one allowed to type sends nothing.
 * @param root - an element around the terminal.
 */
export function TuiEscKey({ root }: { root: React.RefObject<HTMLElement | null> }) {
  useLocale();
  const label = ui('Esc key');
  // Not taking focus: the keyboard stays as it is.
  return <div className="ra-tui-esc" data-remote-agents-tui-esc="" onMouseDown={event => event.preventDefault()}>
    <button type="button" className="ra-tui-esc-button" aria-label={label} title={label} onClick={() => {
      const xterm = root.current ? findXterm(root.current) : undefined;
      xterm?.input?.(ESC, true);
    }}>Esc</button>
  </div>;
}
