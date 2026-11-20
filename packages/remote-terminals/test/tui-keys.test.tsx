import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ESC, keySequence, KEYS_HEIGHT, keyStyles, REPEAT_DELAY_MS, REPEAT_INTERVAL_MS, TUI_KEYS, TuiKeys } from '../src/client/tui-keys.js';

const globals = ['window', 'document', 'HTMLElement', 'Event', 'MouseEvent', 'IS_REACT_ACT_ENVIRONMENT'] as const;
const originals = new Map<string, PropertyDescriptor | undefined>();
let root: Root | undefined, container: HTMLElement;
beforeEach(() => {
  const { window } = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/', pretendToBeVisual: true });
  for (const name of globals) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === 'window' ? window : name === 'IS_REACT_ACT_ENVIRONMENT' ? true : (window as unknown as Record<string, unknown>)[name] });
  }
  container = document.createElement('div'); document.body.append(container);
});
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined;
  window.close();
  for (const name of globals) {
    const descriptor = originals.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete (globalThis as Record<string, unknown>)[name];
  }
});

/** A terminal inside the TUI's root, as findXterm reaches it: in a ref of the component that rendered the element xterm opened in. */
function terminal(around: HTMLElement, applicationCursorKeysMode = false) {
  const sent: Array<[string, boolean | undefined]> = [];
  const opened = document.createElement('div'), screen = document.createElement('div');
  screen.className = 'xterm'; opened.append(screen); around.append(opened);
  const xterm = { loadAddon() {}, modes: { mouseTrackingMode: 'none', applicationCursorKeysMode }, input: (data: string, user?: boolean) => { sent.push([data, user]); } };
  (opened as unknown as Record<string, unknown>).__reactFiber$test = { memoizedState: { memoizedState: { current: xterm }, next: null }, return: null };
  return sent;
}
async function show(tui: HTMLElement) {
  const ref = createRef<HTMLElement>() as { current: HTMLElement | null };
  ref.current = tui;
  root = createRoot(container);
  await act(async () => root!.render(<TuiKeys root={ref} />));
  const button = (key: string) => container.querySelector<HTMLButtonElement>(`.ra-tui-key[data-key="${key}"]`)!;
  return { row: container.querySelector<HTMLElement>('.ra-tui-keys')!, button };
}
const pointer = (target: Element, type: 'pointerdown' | 'pointerup' | 'pointercancel') => act(() => { target.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0 })); });
/** The click a browser fires after a tap or a mouse press; a click from the keyboard or a screen reader has detail 0. */
const tapClick = (target: Element) => act(() => { target.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 })); });

test('each key types what xterm would send for it', () => {
  assert.equal(keySequence('esc'), ESC);
  assert.equal(ESC, '\x1b');
  assert.equal(keySequence('tab'), '\t');
  assert.equal(keySequence('backtab'), '\x1b[Z', 'Shift+Tab, which switches Claude Code\'s mode');
  assert.deepEqual(['up', 'down', 'right', 'left'].map(key => keySequence(key as 'up')), ['\x1b[A', '\x1b[B', '\x1b[C', '\x1b[D']);
  const application = { modes: { applicationCursorKeysMode: true } };
  assert.deepEqual(['up', 'down', 'right', 'left'].map(key => keySequence(key as 'up', application)), ['\x1bOA', '\x1bOB', '\x1bOC', '\x1bOD'], 'a CLI that asked for application cursor keys');
  assert.equal(keySequence('tab', application), '\t');
});

test('the row has Esc, Tab, Shift+Tab and the arrows, each named for a screen reader', async () => {
  const tui = document.createElement('div'); document.body.append(tui);
  terminal(tui);
  const { row, button } = await show(tui);
  assert.equal(row.getAttribute('role'), 'toolbar');
  assert.equal(row.getAttribute('aria-label'), 'Terminal keys');
  assert.deepEqual([...row.querySelectorAll('button')].map(item => item.dataset.key), [...TUI_KEYS]);
  assert.deepEqual(TUI_KEYS, ['esc', 'tab', 'backtab', 'up', 'down', 'left', 'right']);
  assert.deepEqual([...row.querySelectorAll('button')].map(item => item.getAttribute('aria-label')),
    ['Esc key', 'Tab key', 'Shift+Tab key', 'Up arrow key', 'Down arrow key', 'Left arrow key', 'Right arrow key']);
  assert.equal(button('esc').textContent, 'Esc');
  assert.equal(button('tab').textContent, 'Tab');
  assert.equal(button('backtab').textContent, 'Tab');
  assert.ok(button('backtab').querySelector('svg'), 'the shift arrow is drawn: a phone\'s fonts may have no ⇧');
  assert.ok(button('up').querySelector('svg'));
  assert.equal(button('up').type, 'button');
});

test('Esc, Tab and Shift+Tab type once per tap, as user input, without taking the focus', async () => {
  const tui = document.createElement('div'); document.body.append(tui);
  const sent = terminal(tui);
  const { row, button } = await show(tui);
  await tapClick(button('esc'));
  await act(async () => button('esc').click());
  await tapClick(button('tab'));
  await tapClick(button('backtab'));
  assert.deepEqual(sent, [[ESC, true], [ESC, true], ['\t', true], ['\x1b[Z', true]], 'as user input, so the terminal scrolls back down to the prompt');
  const press = new window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
  button('tab').dispatchEvent(press);
  assert.equal(press.defaultPrevented, true, 'the phone keyboard stays as it is');
  const hold = new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  row.dispatchEvent(hold);
  assert.equal(hold.defaultPrevented, true, 'a long press brings up no menu');
});

test('an arrow types as the finger lands, repeats while it stays, and stops when it lifts', async () => {
  const tui = document.createElement('div'); document.body.append(tui);
  const sent = terminal(tui);
  const { button } = await show(tui);
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  // Node's mock clock starts a timer made during a tick at that tick's end, so the clock moves a millisecond at a time.
  const wait = (ms: number) => { for (let left = ms; left > 0; left -= 1) mock.timers.tick(1); };
  try {
    await pointer(button('down'), 'pointerdown');
    assert.deepEqual(sent, [['\x1b[B', true]]);
    wait(REPEAT_DELAY_MS - 1);
    assert.equal(sent.length, 1, 'a tap is a single press');
    wait(1 + REPEAT_INTERVAL_MS * 3);
    assert.equal(sent.length, 4);
    await pointer(button('down'), 'pointerup');
    await tapClick(button('down'));
    wait(REPEAT_INTERVAL_MS * 5);
    assert.equal(sent.length, 4, 'the click after the press types nothing more, and the repeat has stopped');
    await pointer(button('left'), 'pointerdown');
    wait(REPEAT_DELAY_MS + REPEAT_INTERVAL_MS);
    await pointer(button('left'), 'pointercancel');
    wait(REPEAT_INTERVAL_MS * 5);
    assert.deepEqual(sent.slice(4), [['\x1b[D', true], ['\x1b[D', true]], 'a cancelled touch stops the repeat too');
    await act(async () => button('up').click());
    assert.deepEqual(sent.at(-1), ['\x1b[A', true], 'a click from the keyboard, with no press before it, types');
    await pointer(button('right'), 'pointerdown');
    await act(async () => root!.unmount()); root = undefined;
    wait(REPEAT_DELAY_MS + REPEAT_INTERVAL_MS * 3);
    assert.deepEqual(sent.at(-1), ['\x1b[C', true]);
    assert.equal(sent.length, 8, 'leaving the conversation stops a held arrow');
  } finally { mock.timers.reset(); }
});

test('arrows follow the cursor key mode the CLI set', async () => {
  const tui = document.createElement('div'); document.body.append(tui);
  const sent = terminal(tui, true);
  const { button } = await show(tui);
  await pointer(button('up'), 'pointerdown');
  await pointer(button('up'), 'pointerup');
  assert.deepEqual(sent, [['\x1bOA', true]]);
});

test('without a terminal yet the keys do nothing', async () => {
  const { button } = await show(document.createElement('div'));
  await act(async () => button('esc').click());
  await pointer(button('up'), 'pointerdown');
  await pointer(button('up'), 'pointerup');
});

test('the row is only on touch screens, under the terminal rather than over it', () => {
  assert.match(keyStyles, /^\.ra-tui-keys\{display:none\}/);
  assert.match(keyStyles, /@media \(pointer:coarse\)\{\.ra-tui-keys\{display:flex;flex:none;/);
  assert.doesNotMatch(keyStyles, /\.ra-tui-keys\{[^}]*position:absolute/, 'in the flow of the TUI, so the terminal gets shorter');
  assert.match(keyStyles, new RegExp(`height:${KEYS_HEIGHT}px`));
  assert.match(keyStyles, /padding:0 84px 0 8px/, 'room on the right for the file and display buttons');
});
