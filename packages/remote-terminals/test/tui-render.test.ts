import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emulatedScale, findXterm, GlyphAtlases, TuiRenderChoices, withoutPaint, type AtlasDrawer } from '../src/client/tui-render.js';

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

test('an emulated screen scale is told apart from real ones, snapped to whole pixels', () => {
  // Real: 1x, 2x, a phone's 2.625x and 3x, off by a pixel of snapping.
  for (const [width, device, ratio] of [[800, 800, 1], [343.5, 687, 2], [393, 1031, 2.625], [390, 1171, 3], [33, 67, 2]] as const) assert.equal(emulatedScale(width, device, ratio), false, `${width}@${ratio}`);
  // Chrome's device mode: an iPhone SE at 2x on a 1x display, zoomed to 92%; a 3x phone on a 2x display.
  assert.equal(emulatedScale(343, 316, 2), true);
  assert.equal(emulatedScale(358, 716, 3), true);
  // Out of view or too narrow to tell.
  for (const [width, device, ratio] of [[0, 0, 2], [20, 10, 2], [300, 0, 2], [300, 600, 0], [Number.NaN, 600, 2]] as const) assert.equal(emulatedScale(width, device, ratio), undefined);
});

/** A WebGL addon as GlyphAtlases sees it: its atlas canvas, and how often its atlas was cleared. */
function drawer() {
  const atlasChanged = new Set<(canvas: EventTarget) => void>();
  const addon = {
    cleared: 0,
    textureAtlas: new EventTarget() as EventTarget | undefined,
    clearTextureAtlas() { addon.cleared += 1; },
    onChangeTextureAtlas(listener: (canvas: EventTarget) => void) { atlasChanged.add(listener); return { dispose: () => { atlasChanged.delete(listener); } }; },
    changeAtlas(canvas: EventTarget) { addon.textureAtlas = canvas; for (const listener of atlasChanged) listener(canvas); },
    listening: () => atlasChanged.size,
  };
  return addon satisfies AtlasDrawer;
}
const fire = (target: EventTarget | undefined, type: string) => target!.dispatchEvent(new Event(type));

test('a WebGL context coming back draws the glyphs of every terminal again, as they share the atlas it lost', () => {
  const atlases = new GlyphAtlases();
  const a = drawer(), b = drawer(), canvasA = new EventTarget(), canvasB = new EventTarget();
  atlases.add(a, [canvasA]);
  atlases.add(b, [canvasB]);
  assert.deepEqual([a.cleared, b.cleared], [0, 0]);
  fire(canvasA, 'webglcontextlost');
  fire(canvasB, 'webglcontextlost');
  assert.deepEqual([a.cleared, b.cleared], [0, 0]);
  // Each terminal's context comes back on its own; each time all of them draw again.
  fire(canvasA, 'webglcontextrestored');
  assert.deepEqual([a.cleared, b.cleared], [1, 1]);
  fire(canvasB, 'webglcontextrestored');
  assert.deepEqual([a.cleared, b.cleared], [2, 2]);
});

test('the atlas canvas coming back on its own draws the glyphs again, also on an atlas taken after loading', () => {
  const atlases = new GlyphAtlases();
  const a = drawer(), b = drawer();
  const first = a.textureAtlas;
  b.textureAtlas = first;
  atlases.add(a, []);
  atlases.add(b, []);
  fire(first, 'contextlost');
  fire(first, 'contextrestored');
  // Both terminals watch the shared canvas: each of its events draws both again.
  assert.deepEqual([a.cleared, b.cleared], [2, 2]);
  const next = new EventTarget();
  a.changeAtlas(next);
  fire(next, 'contextrestored');
  assert.deepEqual([a.cleared, b.cleared], [3, 3]);
});

test('a terminal taking WebGL up again after a loss draws the shared atlas again; one with no loss before does not', () => {
  const atlases = new GlyphAtlases();
  const a = drawer(), b = drawer(), canvasA = new EventTarget();
  const stopA = atlases.add(a, [canvasA]);
  atlases.add(b, []);
  assert.equal(b.cleared, 0);
  // A's context stays away: it goes back to the page's own drawing, and later loads WebGL again.
  fire(canvasA, 'webglcontextlost');
  stopA();
  const again = drawer();
  atlases.add(again, []);
  assert.deepEqual([again.cleared, b.cleared, a.cleared], [1, 1, 0]);
  // That drew everything again; the next terminal finds a sound atlas.
  atlases.add(drawer(), []);
  assert.equal(b.cleared, 1);
});

test('a terminal no longer drawn with WebGL is left alone and stops listening', () => {
  const atlases = new GlyphAtlases();
  const a = drawer(), b = drawer(), canvasA = new EventTarget(), canvasB = new EventTarget();
  const stopA = atlases.add(a, [canvasA]);
  atlases.add(b, [canvasB]);
  stopA();
  assert.equal(a.listening(), 0);
  fire(canvasA, 'webglcontextrestored');
  fire(a.textureAtlas, 'contextrestored');
  assert.deepEqual([a.cleared, b.cleared], [0, 0]);
  fire(canvasB, 'webglcontextrestored');
  assert.deepEqual([a.cleared, b.cleared], [0, 1]);
});

test('a terminal that throws while clearing does not keep the others from drawing again', () => {
  const atlases = new GlyphAtlases();
  const broken = { ...drawer(), clearTextureAtlas() { throw new Error('disposed'); } };
  const b = drawer(), canvas = new EventTarget();
  atlases.add(broken, [canvas]);
  atlases.add(b, []);
  fire(canvas, 'webglcontextrestored');
  assert.equal(b.cleared, 1);
});
