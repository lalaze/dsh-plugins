import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TuiFilePicker, TuiUploads } from '../src/client/tui-files.js';

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

/** Picks files as the device's picker does: the input's list changes, then a change event. */
function pick(input: HTMLInputElement, files: File[]) {
  Object.defineProperty(input, 'files', { configurable: true, value: files });
  Object.defineProperty(input, 'value', { configurable: true, writable: true, value: files.length ? `C:\\fakepath\\${files[0].name}` : '' });
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

test('the file button opens the picker, and what is picked uploads to that conversation as a drop would', async () => {
  const sent: [string, string][] = [];
  const uploads = new TuiUploads(async (sessionId, file) => { sent.push([sessionId, file.name]); return `/srv/app/${file.name}`; });
  root = createRoot(container);
  await act(async () => root!.render(<TuiFilePicker sessionId="tui" uploads={uploads} cli="Claude Code" />));
  const button = container.querySelector<HTMLButtonElement>('.ra-tui-pick-button')!, input = container.querySelector<HTMLInputElement>('input[type=file]')!;
  assert.equal(button.getAttribute('aria-label'), 'Add files to Claude Code');
  assert.equal(input.multiple, true);
  assert.equal(input.accept, '', 'any file: a CLI reads more than pictures');
  let opened = 0;
  input.click = () => { opened += 1; };
  await act(async () => button.click());
  assert.equal(opened, 1);
  // Pressing the button must leave the focus in the terminal.
  const press = new window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
  button.dispatchEvent(press);
  assert.equal(press.defaultPrevented, true);
  await act(async () => pick(input, [new File(['a'], 'photo.jpg', { type: 'image/jpeg' }), new File(['b'], 'notes.txt')]));
  await act(async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); });
  assert.deepEqual(sent, [['tui', 'photo.jpg'], ['tui', 'notes.txt']]);
  assert.deepEqual(uploads.take('tui'), ['/srv/app/photo.jpg', '/srv/app/notes.txt']);
  assert.equal(input.value, '', 'the same file can be picked again');
  // A picker closed without a choice changes nothing.
  await act(async () => pick(input, []));
  assert.equal(sent.length, 2);
});
