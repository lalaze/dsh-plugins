import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findXterm, TuiRenderChoices, withoutPaint } from '../src/client/tui-render.js';

/** An element xterm opened in, carrying the fibers React would put on it. */
function opened(fiber: unknown) {
  const parent = { __reactFiber$abc: fiber };
  const terminal = { parentElement: parent, matches: (selector: string) => selector === '.xterm', querySelector: () => null };
  const container = { matches: () => false, querySelector: (selector: string) => (selector === '.xterm' ? terminal : null) };
  return { terminal: terminal as unknown as Element, container: container as unknown as Element };
}
const hooks = (...values: unknown[]) => values.reduceRight<unknown>((next, memoizedState) => ({ memoizedState, next }), null);
const xterm = { loadAddon() {}, rows: 1 };

test('the terminal is found in the ref of the component above its element', () => {
  const screen = { memoizedState: hooks(null, { current: {} }, { current: xterm }, 'not a ref') };
  const { container, terminal } = opened({ memoizedState: null, return: screen });
  assert.equal(findXterm(container), xterm);
  assert.equal(findXterm(terminal), xterm);
});

test('no terminal, and an element whose state is not a list of hooks, find nothing without throwing', () => {
  const none = { matches: () => false, querySelector: () => null } as unknown as Element;
  assert.equal(findXterm(none), undefined);
  assert.equal(findXterm(opened({ memoizedState: { element: 'not hooks' }, return: { memoizedState: hooks({ current: null }), return: null } }).container), undefined);
  const noFiber = { matches: () => true, parentElement: {}, querySelector: () => null } as unknown as Element;
  assert.equal(findXterm(noFiber), undefined);
});

test('a terminal far above is not taken for this one', () => {
  let fiber: unknown = { memoizedState: hooks({ current: xterm }), return: null };
  for (let level = 0; level < 6; level += 1) fiber = { memoizedState: null, return: fiber };
  assert.equal(findXterm(opened(fiber).container), undefined);
});

test('the background keeps its color with nothing to paint', () => {
  assert.equal(withoutPaint('rgba(21, 21, 23, 0.92)'), 'rgba(21, 21, 23, 0)');
  assert.equal(withoutPaint('rgba(255,255,255,.92)'), 'rgba(255, 255, 255, 0)');
  assert.equal(withoutPaint('rgba(21, 21, 23, 0)'), 'rgba(21, 21, 23, 0)');
  // Nothing translucent to double: DSH's own opaque color stays.
  assert.equal(withoutPaint('rgb(21, 21, 23)'), undefined);
  assert.equal(withoutPaint(undefined), undefined);
});

const memory = (value?: string) => {
  const saved = new Map<string, string>(value === undefined ? [] : [['remote-agents.tui.render', value]]);
  return { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, text: string) => { saved.set(key, text); } };
};

test('the switches start with WebGL and blur on, and are remembered', () => {
  const storage = memory();
  const choices = new TuiRenderChoices(storage);
  assert.deepEqual(choices.snapshot(), { webgl: true, blur: true });
  let changes = 0;
  const off = choices.subscribe(() => { changes += 1; });
  choices.set({ webgl: false });
  choices.set({ blur: false });
  assert.equal(changes, 2);
  off();
  choices.set({ blur: false });
  assert.equal(changes, 2);
  assert.deepEqual(new TuiRenderChoices(storage).snapshot(), { webgl: false, blur: false });
});

test('WebGL switched off stays off, while an "off" saved before it was the default gives way to it', () => {
  // Saved by turning the blur off in an older version, which wrote WebGL's old default beside it.
  const older = memory('{"webgl":false,"blur":false}');
  assert.deepEqual(new TuiRenderChoices(older).snapshot(), { webgl: true, blur: false });
  assert.deepEqual(new TuiRenderChoices(memory('{"webgl":true,"blur":false}')).snapshot(), { webgl: true, blur: false });
  // Switched off since: a choice, kept through the blur switch and a reload.
  const chosen = new TuiRenderChoices(older);
  chosen.set({ webgl: false });
  chosen.set({ blur: true });
  assert.deepEqual(new TuiRenderChoices(older).snapshot(), { webgl: false, blur: true });
  assert.deepEqual(new TuiRenderChoices(memory('{"blur":false,"version":2}')).snapshot(), { webgl: true, blur: false });
});

test('a damaged or partial saved value falls back to the defaults, and a storage that throws is survived', () => {
  const damaged = { getItem: () => 'not json', setItem() {} };
  assert.deepEqual(new TuiRenderChoices(damaged).snapshot(), { webgl: true, blur: true });
  assert.deepEqual(new TuiRenderChoices({ getItem: () => '{"webgl":true}', setItem() {} }).snapshot(), { webgl: true, blur: true });
  const full = new TuiRenderChoices({ getItem: () => null, setItem() { throw new Error('quota'); } });
  full.set({ blur: false });
  assert.equal(full.snapshot().blur, false);
});

test('a problem is reported once, and changing the switch clears it', () => {
  const choices = new TuiRenderChoices({ getItem: () => null, setItem() {} });
  let changes = 0;
  choices.subscribe(() => { changes += 1; });
  choices.report('lost');
  choices.report('lost');
  assert.equal(changes, 1);
  assert.equal(choices.issue(), 'lost');
  choices.set({ blur: false });
  assert.equal(choices.issue(), 'lost');
  choices.set({ webgl: false });
  assert.equal(choices.issue(), undefined);
});
