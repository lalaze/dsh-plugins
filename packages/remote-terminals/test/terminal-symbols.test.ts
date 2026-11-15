import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { JSDOM } from 'jsdom';
import { installTerminalSymbols, SYMBOLS_FAMILY, type SymbolsEnvironment } from '../src/client/terminal-symbols.js';
import { symbolsFontRanges, symbolsFontWoff2 } from '../src/client/terminal-symbols-font.js';

beforeEach(() => {
  const { window } = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: window.document });
});
afterEach(() => { delete (globalThis as Record<string, unknown>).document; });

/** A page whose fonts are a list, loading when told. */
function page(touch: boolean) {
  const faces: Array<{ family: string; source: string | Uint8Array; range?: string; removed: boolean; settle(ok: boolean): void }> = [];
  let redrawn = 0;
  const environment: SymbolsEnvironment = {
    touch: () => touch,
    add(family, source, descriptors) {
      let settle!: (ok: boolean) => void;
      const loaded = new Promise((resolve, reject) => { settle = ok => (ok ? resolve(undefined) : reject(new Error('no such font'))); });
      const face = { family, source, range: descriptors.unicodeRange, removed: false, settle };
      faces.push(face);
      return { loaded, remove: () => { face.removed = true; } };
    },
    redraw: () => { redrawn += 1; },
  };
  return { environment, faces, redrawn: () => redrawn };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('a touch device gets the symbols in a family of the terminal\'s list, tried before what that name already is', async () => {
  const { environment, faces, redrawn } = page(true);
  const dispose = installTerminalSymbols(environment);
  assert.equal(faces.length, 2);
  assert.equal(faces.every(face => face.family === SYMBOLS_FAMILY), true);
  // Added last, so tried first for its own characters; an installed SF Mono keeps everything else.
  assert.equal(faces[0].source, `local("${SYMBOLS_FAMILY}")`);
  assert.equal(faces[0].range, undefined);
  assert.ok(faces[1].source instanceof Uint8Array);
  assert.equal(faces[1].range, symbolsFontRanges);
  // Terminals already drawn draw again once the symbols are there, not before.
  assert.equal(redrawn(), 0);
  faces[0].settle(false); faces[1].settle(true); await tick();
  assert.equal(redrawn(), 1);
  dispose();
  assert.equal(faces.every(face => face.removed), true);
});

test('a desktop is left as it was', () => {
  const { environment, faces } = page(false);
  installTerminalSymbols(environment)();
  assert.equal(faces.length, 0);
});

test('a font that fails, or loads after the plugin went, changes nothing', async () => {
  const failing = page(true);
  installTerminalSymbols(failing.environment);
  failing.faces[1].settle(false); await tick();
  assert.equal(failing.redrawn(), 0);
  const late = page(true);
  const dispose = installTerminalSymbols(late.environment);
  dispose();
  late.faces[1].settle(true); await tick();
  assert.equal(late.redrawn(), 0);
});

test('the font is a woff2 covering the symbols named, among them Claude Code\'s step and mode marks', () => {
  const bytes = Buffer.from(symbolsFontWoff2, 'base64');
  assert.equal(bytes.subarray(0, 4).toString('latin1'), 'wOF2');
  assert.ok(bytes.length < 16_000, `small enough to carry in the page (${bytes.length} bytes)`);
  const covered = new Set<number>();
  for (const item of symbolsFontRanges.split(',')) {
    assert.match(item, /^U\+[0-9A-F]{4}(-[0-9A-F]{4})?$/);
    const [first, last = first] = item.slice(2).split('-');
    for (let point = parseInt(first, 16); point <= parseInt(last, 16); point += 1) covered.add(point);
  }
  for (const symbol of '⏺⏵⏸⏹') assert.equal(covered.has(symbol.codePointAt(0)!), true, symbol);
  // What a phone already draws as text stays its own: the tool output corner, the spinner, the prompt.
  for (const symbol of '⎿✻✶❯✔·') assert.equal(covered.has(symbol.codePointAt(0)!), false, symbol);
});
