import { symbolsFontRanges, symbolsFontWoff2 } from './terminal-symbols-font.js';
import { findXterm } from './tui-render.js';

/**
 * A family in DSH's terminal font list ("ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", after the user's own)
 * that a touch device does not have. The symbols are added to it, so that a browser finds them in the list, as it does
 * before it falls back to the colour emoji or to nothing; a real SF Mono stays under the same name for everything else.
 * Should DSH drop the name, the symbols would only go unused.
 */
export const SYMBOLS_FAMILY = 'SFMono-Regular';

export interface SymbolsEnvironment {
  touch(): boolean;
  /** Adds a face to the page's fonts; returns its loading and how to take it out again. */
  add(family: string, source: string | Uint8Array, descriptors: { unicodeRange?: string }): { loaded: Promise<unknown>; remove(): void } | undefined;
  /** Terminals already on the page, which drew without the symbols. */
  redraw(): void;
}

const browser: SymbolsEnvironment = {
  touch: () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches,
  add(family, source, descriptors) {
    if (typeof FontFace !== 'function' || !document.fonts) return undefined;
    // From bytes, not a URL: nothing for the page's content security policy to refuse.
    const face = new FontFace(family, typeof source === 'string' ? source : source as unknown as BufferSource, descriptors);
    document.fonts.add(face);
    return { loaded: face.load(), remove: () => { document.fonts.delete(face); } };
  },
  redraw() {
    // WebGL keeps every glyph it drew; xterm draws them again once its atlas is cleared.
    for (const element of document.querySelectorAll('[data-sidebar-terminal] .xterm')) {
      (findXterm(element) as { clearTextureAtlas?(): void } | undefined)?.clearTextureAtlas?.();
    }
  },
};

const decode = (base64: string) => Uint8Array.from(atob(base64), character => character.charCodeAt(0));

/**
 * Symbols CLIs draw their interface with, such as Claude Code's ⏺ before each step and ⏵⏵ before its mode, that a phone
 * has in no text font: ⏺ came out as an orange emoji tile and ⏵ as an empty box. See scripts/build-symbols-font.py.
 * Touch devices only: a desktop has fonts with them, and DSH's terminals look as they did there.
 */
export function installTerminalSymbols(environment: SymbolsEnvironment = browser): () => void {
  if (typeof document === 'undefined' || !environment.touch()) return () => {};
  // Faces whose ranges overlap are tried last added first: the symbols before an installed SF Mono.
  const faces = [
    environment.add(SYMBOLS_FAMILY, `local("${SYMBOLS_FAMILY}")`, {}),
    environment.add(SYMBOLS_FAMILY, decode(symbolsFontWoff2), { unicodeRange: symbolsFontRanges }),
  ];
  let live = true;
  faces[1]?.loaded.then(() => { if (live) environment.redraw(); }, () => { /* no symbols: the terminal looks as it did */ });
  // A device without SF Mono fails that face, which only means there is nothing of it to use.
  faces[0]?.loaded.catch(() => {});
  return () => {
    live = false;
    for (const face of faces) face?.remove();
  };
}
