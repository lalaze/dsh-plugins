import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';

let root: Root | undefined, container: HTMLElement;
const globals = ['window', 'document', 'navigator', 'MutationObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle', 'Node', 'Element', 'HTMLElement', 'Text', 'Range', 'Selection', 'KeyboardEvent', 'Event', 'DOMRect', 'Window'] as const;
beforeEach(() => {
  const { window } = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/', pretendToBeVisual: true });
  // CodeMirror measures layout, which jsdom does not compute.
  window.Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
  window.Range.prototype.getBoundingClientRect = () => new window.DOMRect();
  for (const name of globals) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === 'window' ? window : (window as unknown as Record<string, unknown>)[name] });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.append(container);
});
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined;
  for (const name of globals) delete (globalThis as Record<string, unknown>)[name];
});

async function mount(element: React.ReactElement) {
  const { createRoot } = await import('react-dom/client');
  root = createRoot(container);
  await act(async () => root!.render(element));
  const { EditorView } = await import('@codemirror/view');
  return () => EditorView.findFromDOM(container.querySelector<HTMLElement>('.cm-editor')!)!;
}

test('edits report the new text, while a value from outside replaces the document without echoing back', async () => {
  const { CodeEditor } = await import('../src/editor.js');
  const changes: string[] = [];
  const view = await mount(<CodeEditor value={'const a = 1;\n'} onChange={value => changes.push(value)} path="a.ts" label="Contents" />);
  assert.equal(view().state.sliceDoc(), 'const a = 1;\n');
  assert.equal(container.querySelector('.cm-content')!.getAttribute('aria-label'), 'Contents');
  assert.ok(container.querySelector('.tok-keyword'), 'TypeScript is highlighted');
  await act(async () => view().dispatch({ changes: { from: 0, insert: '// x\n' } }));
  assert.deepEqual(changes, ['// x\nconst a = 1;\n']);
  await act(async () => root!.render(<CodeEditor value="reloaded" onChange={value => changes.push(value)} path="a.ts" label="Contents" />));
  assert.equal(view().state.sliceDoc(), 'reloaded');
  assert.equal(changes.length, 1, 'the parent is not told about its own value');
});

test('CRLF files stay CRLF, including after a reload brings other line endings', async () => {
  const { CodeEditor } = await import('../src/editor.js');
  let latest = '';
  const view = await mount(<CodeEditor value={'a\r\nb\r\n'} onChange={value => { latest = value; }} path="a.txt" label="Contents" />);
  await act(async () => view().dispatch({ changes: { from: view().state.doc.length, insert: 'c' } }));
  assert.equal(latest, 'a\r\nb\r\nc');
  await act(async () => root!.render(<CodeEditor value={'x\ny\n'} onChange={value => { latest = value; }} path="a.txt" label="Contents" />));
  assert.equal(view().state.sliceDoc(), 'x\ny\n');
});

test('Mod-S saves, and a read-only editor refuses edits', async () => {
  const { CodeEditor } = await import('../src/editor.js');
  let saves = 0;
  const view = await mount(<CodeEditor value="text" onChange={() => {}} onSave={() => saves++} path="a.md" label="Contents" readOnly />);
  const content = container.querySelector<HTMLElement>('.cm-content')!;
  await act(async () => { content.dispatchEvent(new window.KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true })); });
  assert.equal(saves, 1);
  assert.equal(view().state.readOnly, true);
});

test('a line from a link is selected and shown', async () => {
  const { CodeEditor } = await import('../src/editor.js');
  const view = await mount(<CodeEditor value={'one\ntwo\nthree\n'} onChange={() => {}} path="a.txt" label="Contents" line={3} />);
  assert.equal(view().state.doc.lineAt(view().state.selection.main.head).number, 3);
});
