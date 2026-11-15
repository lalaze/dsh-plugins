import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { JSDOM } from 'jsdom';
import { installTouchFocus, touchFocusStyles, TouchScroller, type FrameClock, type TouchXterm } from '../src/client/terminal-touch.js';

let dispose = () => {};
let window: JSDOM['window'];
beforeEach(() => {
  ({ window } = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' }));
  Object.defineProperty(globalThis, 'document', { configurable: true, value: window.document });
});
afterEach(() => { dispose(); dispose = () => {}; delete (globalThis as Record<string, unknown>).document; });

/** A terminal's screen as xterm 6 builds it inside DSH's terminal, read from a real page: the input sits in the helpers, beside the layers a tap lands on. */
const screen = (inside = true) => {
  const root = document.createElement('section');
  if (inside) root.setAttribute('data-sidebar-terminal', '');
  root.innerHTML = '<div class="holder"><div class="terminal xterm"><div class="xterm-viewport"></div><div class="xterm-scrollable-element"><div class="xterm-screen"><div class="xterm-helpers"><textarea class="xterm-helper-textarea"></textarea></div><style></style><div class="xterm-decoration-container"></div><canvas class="xterm-link-layer"></canvas><canvas></canvas><div class="xterm-rows"><div><span>x</span></div></div></div></div></div></div>';
  document.body.append(root);
  return root;
};
type Rule = { selectorText?: string; cssText: string; media?: { mediaText: string }; conditionText?: string; cssRules?: Rule[] };
const rules = () => [...(document.querySelector<HTMLStyleElement>('style[data-remote-terminal-touch]')!.sheet!.cssRules as unknown as Rule[])];
const tapRule = () => {
  const media = rules().filter(rule => rule.cssRules);
  assert.equal(media.length, 1);
  return { condition: media[0].media?.mediaText ?? media[0].conditionText, inner: media[0].cssRules![0] };
};

test('on a touch device a tap lands on the terminal\'s screen, which contains its input, instead of on a layer beside it', () => {
  dispose = installTouchFocus();
  const { condition, inner } = tapRule();
  assert.equal(condition, '(pointer: coarse)', 'a mouse is left alone');
  assert.match(inner.cssText, /pointer-events:\s*none/);
  const root = screen(), target = root.querySelector('.xterm-screen')!, input = root.querySelector('.xterm-helper-textarea')!;
  // Every layer a finger could hit, in both renderers: the two canvases, the DOM renderer's rows, the decorations.
  for (const layer of ['canvas.xterm-link-layer', 'canvas:not(.xterm-link-layer)', '.xterm-rows', '.xterm-decoration-container']) assert.equal(root.querySelector(layer)!.matches(inner.selectorText!), true, layer);
  // What is left to take the tap contains the input: that is what a phone layout's focus guard asks for.
  assert.equal(target.matches(inner.selectorText!), false);
  assert.equal(target.contains(input), true);
  // The input and what holds it stay reachable, as a long press on it is how a phone pastes.
  assert.equal(root.querySelector('.xterm-helpers')!.matches(inner.selectorText!), false);
  assert.equal(input.matches(inner.selectorText!), false);
  // The scrollbar and anything outside a DSH terminal are not touched.
  assert.equal(root.querySelector('.xterm-viewport')!.matches(inner.selectorText!), false);
  assert.equal(screen(false).querySelector('canvas')!.matches(inner.selectorText!), false);
});

test('the page does not pan under a finger on a terminal, whatever the main pointer, and nowhere else', () => {
  dispose = installTouchFocus();
  const pan = rules().find(rule => rule.selectorText === '[data-sidebar-terminal] .xterm');
  assert.ok(pan, 'a rule of its own, outside the media query, as touch-action means nothing to a mouse');
  assert.match(pan.cssText, /touch-action:\s*none/);
  assert.equal(screen().querySelector('.xterm')!.matches(pan.selectorText!), true);
  assert.equal(screen(false).querySelector('.xterm')!.matches(pan.selectorText!), false);
  // The padding's rule uses :has, which a browser without it drops: alone, so that it cannot take the others with it.
  const lines = touchFocusStyles.split('\n');
  assert.equal(lines.filter(line => line.includes(':has(')).length, 1);
  assert.equal(lines.filter(line => line.includes(':has(')).every(line => !line.includes('pointer-events')), true);
});

test('the styles go when the plugin does, and so does the listening', () => {
  dispose = installTouchFocus();
  assert.equal(document.querySelectorAll('style[data-remote-terminal-touch]').length, 1);
  dispose(); dispose = () => {};
  assert.equal(document.querySelectorAll('style[data-remote-terminal-touch]').length, 0);
});

/** A terminal of `rows` rows of 20 pixels, at the top left of the page, with `history` lines above its screen. */
function terminal({ rows = 10, history = 100, type = 'normal', mouse = 'none', at = undefined as number | undefined } = {}) {
  const top = at ?? history;
  const root = screen();
  const element = root.querySelector<HTMLElement>('.xterm')!;
  const screenElement = root.querySelector<HTMLElement>('.xterm-screen')!;
  screenElement.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: rows * 20, right: 300, bottom: rows * 20, x: 0, y: 0, toJSON() {} }) as DOMRect;
  const scrolled: number[] = [], wheels: Array<{ deltaY: number; deltaMode: number; clientX: number; clientY: number }> = [];
  element.addEventListener('wheel', event => { const wheel = event as WheelEvent; wheels.push({ deltaY: wheel.deltaY, deltaMode: wheel.deltaMode, clientX: wheel.clientX, clientY: wheel.clientY }); });
  const xterm: TouchXterm = {
    element, rows,
    modes: { mouseTrackingMode: mouse },
    buffer: { active: { type, viewportY: top, baseY: history } },
    scrollLines(amount) { scrolled.push(amount); xterm.buffer.active.viewportY = Math.max(0, Math.min(history, xterm.buffer.active.viewportY + amount)); },
  };
  return { root, element, xterm, scrolled, wheels };
}
/** Time that moves only when told, and frames that run only when told. */
function clock() {
  let time = 1000, next = 1;
  const frames = new Map<number, () => void>();
  const value: FrameClock & { advance(ms: number): void; runFrames(count?: number): number; pending(): number } = {
    now: () => time,
    frame: run => { const id = next++; frames.set(id, run); return id; },
    cancel: id => { frames.delete(id); },
    advance: ms => { time += ms; },
    /** Runs frames 16 ms apart until none is left or `count` ran; returns how many ran. */
    runFrames: (count = 1000) => {
      let ran = 0;
      while (frames.size && ran < count) { const [id, run] = frames.entries().next().value!; frames.delete(id); time += 16; run(); ran += 1; }
      return ran;
    },
    pending: () => frames.size,
  };
  return value;
}
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
/** A finger dragged from `from` to `to` in `steps` moves `ms` apart, then lifted after resting `rest` ms. */
function drag(scroller: TouchScroller, time: ReturnType<typeof clock>, target: Element, from: [number, number], to: [number, number], { steps = 10, ms = 16, rest = 0 } = {}) {
  scroller.start(target, from[0], from[1], 1);
  for (let step = 1; step <= steps; step += 1) {
    time.advance(ms);
    scroller.move(from[0] + (to[0] - from[0]) * step / steps, from[1] + (to[1] - from[1]) * step / steps);
  }
  time.advance(rest);
  scroller.end();
}

test('a slow swipe scrolls a terminal\'s history by the lines the finger moved, and stops where the finger does', () => {
  const time = clock(), { root, xterm, scrolled, wheels } = terminal({ at: 50 });
  const scroller = new TouchScroller(() => xterm, time);
  const target = root.querySelector('.xterm-screen')!;
  // Down by 8 lines' worth after the slop: older lines come into view, as a list on a phone does.
  drag(scroller, time, target, [100, 20], [100, 20 + 8 + 160], { steps: 21, ms: 40, rest: 200 });
  assert.equal(sum(scrolled), -8);
  assert.equal(xterm.buffer.active.viewportY, 42);
  assert.equal(time.pending(), 0, 'a finger that rested before lifting does not fling');
  // And back up.
  scrolled.length = 0;
  drag(scroller, time, target, [100, 190], [100, 190 - 8 - 100], { steps: 27, ms: 40, rest: 200 });
  assert.equal(sum(scrolled), 5);
  assert.deepEqual(wheels, [], 'nothing reaches the program');
});

test('a tap, a sideways swipe, two fingers and a finger outside a terminal scroll nothing', () => {
  const time = clock(), { root, xterm, scrolled } = terminal({ at: 50 });
  const scroller = new TouchScroller(() => xterm, time);
  const target = root.querySelector('.xterm-screen')!;
  drag(scroller, time, target, [100, 100], [102, 105], { steps: 3 });
  drag(scroller, time, target, [100, 100], [160, 140], { steps: 6 });
  scroller.start(target, 100, 100, 2); scroller.move(100, 200); scroller.end();
  const outside = screen(false);
  drag(new TouchScroller(() => xterm, time), time, outside.querySelector('.xterm-screen')!, [100, 20], [100, 200]);
  drag(scroller, time, document.body, [100, 20], [100, 200]);
  assert.deepEqual(scrolled, []);
  assert.equal(time.pending(), 0);
});

test('the padding around a terminal counts as the terminal', () => {
  const time = clock(), { root, xterm, scrolled } = terminal({ at: 50 });
  let asked: Element | undefined;
  const scroller = new TouchScroller(element => { asked = element; return xterm; }, time);
  drag(scroller, time, root.querySelector('.holder')!, [100, 20], [100, 108], { steps: 11, ms: 50, rest: 100 });
  assert.equal(asked, root.querySelector('.xterm'));
  assert.equal(sum(scrolled), -4);
});

test('a quick swipe carries on, slows down and stops; a finger going down stops it at once', () => {
  const time = clock(), { root, xterm, scrolled } = terminal({ history: 10_000, at: 10_000 });
  const scroller = new TouchScroller(() => xterm, time);
  const target = root.querySelector('.xterm-screen')!;
  // 200 pixels in 80 ms: 2.5 pixels a millisecond, a flick.
  drag(scroller, time, target, [100, 20], [100, 228], { steps: 5, ms: 16 });
  const byFinger = sum(scrolled);
  const frames = time.runFrames();
  const carried = sum(scrolled) - byFinger;
  assert.ok(frames > 20, `it slows over several frames (${frames})`);
  // Speed times the friction time: about 2.5 × 325 pixels, 20 to a line.
  assert.ok(carried <= -30 && carried >= -45, `about 40 more lines (${carried})`);
  // Again, then a finger stops it.
  drag(scroller, time, target, [100, 20], [100, 228], { steps: 5, ms: 16 });
  time.runFrames(3);
  const before = scrolled.length;
  scroller.start(target, 100, 300, 1);
  assert.equal(time.runFrames(), 0);
  assert.equal(scrolled.length, before);
});

test('a fling stops at the oldest line, and when the terminal goes', () => {
  const time = clock(), { root, xterm, scrolled } = terminal({ history: 30, at: 30 });
  const scroller = new TouchScroller(() => xterm, time);
  const target = root.querySelector('.xterm-screen')!;
  drag(scroller, time, target, [100, 20], [100, 228], { steps: 5, ms: 16 });
  time.runFrames();
  assert.equal(xterm.buffer.active.viewportY, 0);
  assert.equal(sum(scrolled), -30);
  const late = terminal({ history: 1000, at: 1000 });
  const gone = new TouchScroller(() => late.xterm, time);
  drag(gone, time, late.root.querySelector('.xterm-screen')!, [100, 20], [100, 228], { steps: 5, ms: 16 });
  const moved = late.scrolled.length;
  late.root.remove();
  time.runFrames();
  assert.equal(late.scrolled.length, moved);
  assert.equal(time.pending(), 0);
});

test('a program drawing the whole screen gets a wheel line for each line moved, where the finger is', () => {
  const time = clock(), { root, xterm, scrolled, wheels } = terminal({ type: 'alternate', mouse: 'any', history: 0, at: 0 });
  const scroller = new TouchScroller(() => xterm, time);
  // Up by 3 lines: newer content, as a wheel turned down would ask for.
  drag(scroller, time, root.querySelector('.xterm-screen')!, [120, 150], [120, 150 - 8 - 60], { steps: 17, ms: 40, rest: 100 });
  assert.deepEqual(scrolled, []);
  assert.equal(wheels.length, 3);
  for (const wheel of wheels) {
    assert.equal(wheel.deltaY, 1);
    assert.equal(wheel.deltaMode, 1, 'in lines, which xterm passes on one report per event');
    assert.equal(wheel.clientX, 120);
    assert.ok(wheel.clientY > 0 && wheel.clientY < 200, 'inside the screen, where xterm finds the cell');
  }
  // Down, with the finger dragged off the screen: the wheel stays inside it.
  wheels.length = 0;
  drag(scroller, time, root.querySelector('.xterm-screen')!, [120, 150], [120, 150 + 8 + 400], { steps: 2, ms: 400, rest: 100 });
  assert.equal(wheels.length, 20);
  assert.equal(wheels.every(wheel => wheel.deltaY === -1 && wheel.clientY === 199), true);
  // The classic buffer with mouse reports on goes the same way, as only the program knows what a wheel means to it.
  const reporting = terminal({ mouse: 'vt200', at: 50 });
  drag(new TouchScroller(() => reporting.xterm, time), time, reporting.root.querySelector('.xterm-screen')!, [100, 100], [100, 148], { steps: 6, ms: 40, rest: 100 });
  assert.deepEqual(reporting.scrolled, []);
  assert.equal(reporting.wheels.length, 2);
});

test('installed, real touch events on a terminal in the page scroll it', () => {
  const { root, xterm, scrolled } = terminal({ at: 50 });
  // What React leaves on the element xterm opened in, as findXterm reads it.
  const found = Object.assign(xterm, { loadAddon() {} });
  Object.assign(root.querySelector('.holder')!, { __reactFiber$test: { memoizedState: null, return: { memoizedState: { memoizedState: { current: found }, next: null } } } });
  // A quick swipe flings in animation frames, which Node has none of: one that never runs.
  Object.assign(globalThis, { requestAnimationFrame: () => 1, cancelAnimationFrame: () => {} });
  dispose = installTouchFocus();
  const target = root.querySelector('.xterm-rows')!;
  const touch = (type: string, y: number | undefined) => {
    const event = new window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'touches', { value: y === undefined ? [] : [{ clientX: 100, clientY: y }] });
    target.dispatchEvent(event);
  };
  touch('touchstart', 20);
  for (const y of [40, 60, 80, 100]) touch('touchmove', y);
  touch('touchend', undefined);
  assert.ok(sum(scrolled) <= -3, `scrolled ${sum(scrolled)}`);
  dispose(); dispose = () => {};
  scrolled.length = 0;
  touch('touchstart', 20); touch('touchmove', 200); touch('touchend', undefined);
  assert.deepEqual(scrolled, [], 'nothing listens once removed');
  delete (globalThis as Record<string, unknown>).requestAnimationFrame; delete (globalThis as Record<string, unknown>).cancelAnimationFrame;
});
