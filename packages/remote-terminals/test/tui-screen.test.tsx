import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { claimScreen, useScreenClaim } from '../src/client/tui-screen.js';
import type { Xterm } from '../src/client/tui-render.js';

const globals = ['window', 'document', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT'] as const;
const originals = new Map<string, PropertyDescriptor | undefined>();
let root: Root | undefined;
beforeEach(() => {
  const { window } = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/', pretendToBeVisual: true });
  for (const name of globals) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === 'window' ? window : name === 'IS_REACT_ACT_ENVIRONMENT' ? true : (window as unknown as Record<string, unknown>)[name] });
  }
  mock.timers.enable({ apis: ['setTimeout'] });
});
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined;
  mock.timers.reset();
  window.close();
  for (const name of globals) {
    const descriptor = originals.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete (globalThis as Record<string, unknown>)[name];
  }
});

/** A terminal as findXterm reaches it: in a ref of the component that rendered the element xterm opened in. */
function terminal(focusReports = true) {
  const sent: Array<[string, boolean | undefined]> = [];
  const xterm = { loadAddon() {}, modes: { mouseTrackingMode: 'none', sendFocusMode: focusReports }, input: (data: string, user?: boolean) => { sent.push([data, user]); } } as unknown as Xterm;
  const host = document.createElement('div'), opened = document.createElement('div'), screen = document.createElement('div');
  screen.className = 'xterm'; opened.append(screen); host.append(opened); document.body.append(host);
  (opened as unknown as Record<string, unknown>).__reactFiber$test = { memoizedState: { memoizedState: { current: xterm }, next: null }, return: null };
  return { xterm, host, sent };
}
function Claim({ host, visible }: { host: HTMLElement; visible: boolean }) { useScreenClaim(host, visible); return null; }
const show = (host: HTMLElement, visible: boolean) => act(async () => {
  root ??= createRoot(document.createElement('div'));
  root.render(<Claim host={host} visible={visible} />);
});
const tick = (ms: number) => act(async () => { mock.timers.tick(ms); });
const CLAIM = [['\x1b[I', false], ['\x1b[O', false]];

test('a terminal without focus reports focus in and out, and one with focus or without focus reports sends nothing', () => {
  const { xterm, sent } = terminal();
  assert.equal(claimScreen(xterm, false), true);
  assert.deepEqual(sent, CLAIM);
  assert.equal(claimScreen(xterm, true), false, 'xterm said it by itself');
  assert.equal(claimScreen(terminal(false).xterm, false), false, 'the CLI would read the reports as keys');
  assert.equal(claimScreen({ ...xterm, input: undefined }, false), false);
  assert.equal(sent.length, 2);
});

test('coming into view, and the window or tab coming back, claim the screen; out of view nothing does', async () => {
  const { host, sent } = terminal();
  await show(host, false);
  await tick(1000);
  assert.deepEqual(sent, [], 'out of view');
  await show(host, true);
  await tick(299);
  assert.deepEqual(sent, [], 'DSH may still be giving it focus');
  await tick(1);
  assert.deepEqual(sent, CLAIM);
  await act(async () => { window.dispatchEvent(new window.Event('focus')); });
  await tick(300);
  assert.equal(sent.length, 4, 'the window came back');
  await act(async () => { document.dispatchEvent(new window.Event('visibilitychange')); });
  await tick(300);
  assert.equal(sent.length, 6, 'the tab came back');
  await show(host, false);
  await act(async () => { window.dispatchEvent(new window.Event('focus')); });
  await tick(1000);
  assert.equal(sent.length, 6, 'no longer shown');
});

test('a terminal that has focus said it by itself, and a hidden tab claims nothing', async () => {
  const { xterm, host, sent } = terminal();
  const textarea = document.createElement('textarea'); host.append(textarea); textarea.focus();
  Object.assign(xterm, { textarea });
  document.hasFocus = () => true;
  await show(host, true);
  await tick(300);
  assert.deepEqual(sent, []);
  textarea.blur();
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  await act(async () => { window.dispatchEvent(new window.Event('focus')); });
  await tick(300);
  assert.deepEqual(sent, []);
});
