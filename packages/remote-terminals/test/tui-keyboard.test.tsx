import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { coveredBottom, useKeyboardFit, type VisibleViewport } from '../src/client/tui-keyboard.js';

test('what the keyboard covers is what lies below the part of the page on screen', () => {
  assert.equal(coveredBottom(839, { height: 839, offsetTop: 0 }), 0);
  assert.equal(coveredBottom(839, { height: 480, offsetTop: 0 }), 359);
  // A page the browser has already moved up shows more of its bottom.
  assert.equal(coveredBottom(839, { height: 480, offsetTop: 100 }), 259);
  assert.equal(coveredBottom(600, { height: 839, offsetTop: 0 }), 0, 'an element above the keyboard is not covered');
  assert.equal(coveredBottom(839.4, { height: 480.2, offsetTop: 0 }), 359);
});

const globals = ['window', 'document', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT', 'requestAnimationFrame', 'cancelAnimationFrame'] as const;
const originals = new Map<string, PropertyDescriptor | undefined>();
let root: Root | undefined, scrolls: [number, number][];
beforeEach(() => {
  const { window } = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/', pretendToBeVisual: true });
  scrolls = [];
  // The page as a phone's browser leaves it after moving it up for the keyboard.
  Object.defineProperty(window, 'scrollY', { configurable: true, writable: true, value: 0 });
  window.scrollTo = ((x: number, y: number) => { scrolls.push([x, y]); (window as unknown as { scrollY: number }).scrollY = y; }) as typeof window.scrollTo;
  const values: Record<string, unknown> = {
    window, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0), cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  };
  for (const name of globals) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name in values ? values[name] : (window as unknown as Record<string, unknown>)[name] });
  }
});
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined;
  window.close();
  for (const name of globals) {
    const descriptor = originals.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete (globalThis as Record<string, unknown>)[name];
  }
});

/** A phone's visible viewport whose keyboard opens and closes. */
function phone(full: number) {
  const viewport = Object.assign(new EventTarget(), { height: full, offsetTop: 0 }) as EventTarget & { height: number; offsetTop: number };
  return { viewport: viewport as VisibleViewport, keyboard: (height: number) => { viewport.height = full - height; viewport.dispatchEvent(new Event('resize')); } };
}
function View({ touch, viewport, bottom }: { touch: boolean; viewport: VisibleViewport; bottom: number }) {
  const node = useRef<HTMLDivElement>(null);
  useKeyboardFit(node, touch, viewport);
  return <div ref={element => {
    (node as React.MutableRefObject<HTMLDivElement | null>).current = element;
    // The TUI fills the page below the conversation's header, whatever its own max-height.
    if (element) element.getBoundingClientRect = () => ({ top: 76, bottom, height: bottom - 76, left: 0, right: 412, width: 412, x: 0, y: 76, toJSON() {} });
  }} data-testid="tui" />;
}
const frame = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
const tui = () => document.querySelector<HTMLElement>('[data-testid=tui]')!;

test('on a touch screen the TUI shrinks to what the keyboard leaves on screen, and grows back when it closes', async () => {
  const { viewport, keyboard } = phone(839);
  root = createRoot(document.body.appendChild(document.createElement('div')));
  await act(async () => root!.render(<View touch viewport={viewport} bottom={839} />));
  assert.equal(tui().style.maxHeight, '');
  keyboard(359);
  await frame();
  assert.equal(tui().style.maxHeight, 'calc(100% - 359px)');
  // A taller keyboard (an emoji panel) takes more.
  keyboard(420);
  await frame();
  assert.equal(tui().style.maxHeight, 'calc(100% - 420px)');
  keyboard(0);
  await frame();
  assert.equal(tui().style.maxHeight, '');
});

test('the page is kept where it is rather than moved up for the keyboard', async () => {
  const { viewport, keyboard } = phone(839);
  (window as unknown as { scrollY: number }).scrollY = 339;
  root = createRoot(document.body.appendChild(document.createElement('div')));
  await act(async () => root!.render(<View touch viewport={viewport} bottom={839} />));
  assert.deepEqual(scrolls, [[0, 0]], 'a page left moved up is put back at once');
  (window as unknown as { scrollY: number }).scrollY = 200;
  window.dispatchEvent(new window.Event('scroll'));
  assert.deepEqual(scrolls.at(-1), [0, 0]);
  keyboard(359);
  await frame();
  assert.equal(scrolls.length, 2, 'nothing to undo when the page did not move');
});

test('nothing changes off a touch screen, and leaving the TUI gives its height back', async () => {
  const { viewport, keyboard } = phone(839);
  root = createRoot(document.body.appendChild(document.createElement('div')));
  await act(async () => root!.render(<View touch={false} viewport={viewport} bottom={839} />));
  keyboard(359);
  await frame();
  assert.equal(tui().style.maxHeight, '');
  await act(async () => root!.render(<View touch viewport={viewport} bottom={839} />));
  await frame();
  assert.equal(tui().style.maxHeight, 'calc(100% - 359px)');
  const node = tui();
  await act(async () => root!.render(<div />));
  assert.equal(node.style.maxHeight, '');
  (window as unknown as { scrollY: number }).scrollY = 100;
  window.dispatchEvent(new window.Event('scroll'));
  assert.equal(scrolls.filter(([, y]) => y === 0).length, 0, 'no longer holds the page once the TUI is gone');
});
