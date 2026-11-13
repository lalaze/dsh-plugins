import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { JSDOM } from 'jsdom';
import { installTouchFocus, touchFocusStyles } from '../src/client/terminal-touch.js';

let dispose = () => {};
beforeEach(() => {
  const { window } = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: window.document });
});
afterEach(() => { dispose(); dispose = () => {}; delete (globalThis as Record<string, unknown>).document; });

/** A terminal's screen as xterm 6 builds it inside DSH's terminal, read from a real page: the input sits in the helpers, beside the layers a tap lands on. */
const screen = (inside = true) => {
  const root = document.createElement('section');
  if (inside) root.setAttribute('data-sidebar-terminal', '');
  root.innerHTML = '<div class="terminal xterm"><div class="xterm-viewport"></div><div class="xterm-scrollable-element"><div class="xterm-screen"><div class="xterm-helpers"><textarea class="xterm-helper-textarea"></textarea></div><style></style><div class="xterm-decoration-container"></div><canvas class="xterm-link-layer"></canvas><canvas></canvas><div class="xterm-rows"><div><span>x</span></div></div></div></div></div>';
  document.body.append(root);
  return root;
};
const rule = () => {
  const media = [...(document.querySelector<HTMLStyleElement>('style[data-remote-terminal-touch]')!.sheet!.cssRules as unknown as { conditionText?: string; media?: { mediaText: string }; cssRules: { selectorText: string; cssText: string }[] }[])];
  assert.equal(media.length, 1);
  return { condition: media[0].media?.mediaText ?? media[0].conditionText, inner: media[0].cssRules[0] };
};

test('on a touch device a tap lands on the terminal\'s screen, which contains its input, instead of on a layer beside it', () => {
  dispose = installTouchFocus();
  const { condition, inner } = rule();
  assert.equal(condition, '(pointer: coarse)', 'a mouse is left alone');
  assert.match(inner.cssText, /pointer-events:\s*none/);
  const root = screen(), target = root.querySelector('.xterm-screen')!, input = root.querySelector('.xterm-helper-textarea')!;
  // Every layer a finger could hit, in both renderers: the two canvases, the DOM renderer's rows, the decorations.
  for (const layer of ['canvas.xterm-link-layer', 'canvas:not(.xterm-link-layer)', '.xterm-rows', '.xterm-decoration-container']) assert.equal(root.querySelector(layer)!.matches(inner.selectorText), true, layer);
  // What is left to take the tap contains the input: that is what a phone layout's focus guard asks for.
  assert.equal(target.matches(inner.selectorText), false);
  assert.equal(target.contains(input), true);
  // The input and what holds it stay reachable, as a long press on it is how a phone pastes.
  assert.equal(root.querySelector('.xterm-helpers')!.matches(inner.selectorText), false);
  assert.equal(input.matches(inner.selectorText), false);
  // The scrollbar and anything outside a DSH terminal are not touched.
  assert.equal(root.querySelector('.xterm-viewport')!.matches(inner.selectorText), false);
  assert.equal(screen(false).querySelector('canvas')!.matches(inner.selectorText), false);
});

test('the styles are one rule a browser keeps, and go when the plugin does', () => {
  assert.doesNotMatch(touchFocusStyles, /:has\(/, 'nothing a browser would drop the rule for');
  dispose = installTouchFocus();
  assert.equal(document.querySelectorAll('style[data-remote-terminal-touch]').length, 1);
  dispose(); dispose = () => {};
  assert.equal(document.querySelectorAll('style[data-remote-terminal-touch]').length, 0);
});
