import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ESC, keyStyles, TuiEscKey } from '../src/client/tui-keys.js';

const globals = ['window', 'document', 'HTMLElement', 'Event', 'IS_REACT_ACT_ENVIRONMENT'] as const;
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
function terminal(around: HTMLElement) {
  const sent: Array<[string, boolean | undefined]> = [];
  const opened = document.createElement('div'), screen = document.createElement('div');
  screen.className = 'xterm'; opened.append(screen); around.append(opened);
  const xterm = { loadAddon() {}, modes: { mouseTrackingMode: 'none' }, input: (data: string, user?: boolean) => { sent.push([data, user]); } };
  (opened as unknown as Record<string, unknown>).__reactFiber$test = { memoizedState: { memoizedState: { current: xterm }, next: null }, return: null };
  return sent;
}
async function show(tui: HTMLElement) {
  const ref = createRef<HTMLElement>() as { current: HTMLElement | null };
  ref.current = tui;
  root = createRoot(container);
  await act(async () => root!.render(<TuiEscKey root={ref} />));
  return container.querySelector<HTMLButtonElement>('.ra-tui-esc-button')!;
}

test('the Esc button types Esc into the terminal, as the key would, without taking the focus', async () => {
  const tui = document.createElement('div'); document.body.append(tui);
  const sent = terminal(tui);
  const button = await show(tui);
  assert.equal(button.getAttribute('aria-label'), 'Esc key');
  assert.equal(button.textContent, 'Esc');
  await act(async () => button.click());
  await act(async () => button.click());
  assert.deepEqual(sent, [[ESC, true], [ESC, true]], 'as user input, so the terminal scrolls back down to the prompt');
  assert.equal(ESC, '\x1b');
  const press = new window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
  button.dispatchEvent(press);
  assert.equal(press.defaultPrevented, true, 'the phone keyboard stays as it is');
});

test('without a terminal yet the Esc button does nothing', async () => {
  const button = await show(document.createElement('div'));
  await act(async () => button.click());
});

test('the Esc button is only on touch screens', () => {
  assert.match(keyStyles, /^\.ra-tui-esc\{display:none\}/);
  assert.match(keyStyles, /@media \(pointer:coarse\)\{\.ra-tui-esc\{display:block;/);
});
