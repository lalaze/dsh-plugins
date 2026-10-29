import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { sessionFileAddress, workspaceFileAddress } from '../src/client/workspace/sidebar.js';

test('file tab addresses are built as DSH builds them and read back unchanged', () => {
  for (const path of ['src/a b#c?.ts', 'docs/中文 100%.md', '/srv/app/a.ts', 'C:/work/a.ts', 'a']) {
    assert.deepEqual(workspaceFileAddress(sessionFileAddress('session:1', path)), { sessionId: 'session:1', path }, path);
  }
  assert.equal(sessionFileAddress('s1', 'src/a b.ts'), 'dsh-resource://file/session/s1/src/a%20b.ts');
});

let root: Root | undefined, container: HTMLElement, requests: Record<string, unknown>[];
const globals = ['window', 'document', 'navigator', 'MutationObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle', 'Node', 'Element', 'HTMLElement', 'HTMLInputElement', 'Text', 'Range', 'Selection', 'KeyboardEvent', 'Event', 'DOMRect', 'Window', 'fetch'] as const;
beforeEach(() => {
  const { window } = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/', pretendToBeVisual: true });
  window.Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
  window.Range.prototype.getBoundingClientRect = () => new window.DOMRect();
  requests = [];
  // The remote agents API, as far as the files tool uses it.
  const fetch = async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body); requests.push(body);
    if (body.action === 'workspaceTarget') return Response.json({ hostId: 'host-test', label: 'Box', cwd: '/srv/app' });
    const operation = body.operation;
    if (operation.op === 'list') return Response.json({ entries: [{ name: 'main.ts', path: 'main.ts', kind: 'file', size: 12, modified: '' }] });
    if (operation.op === 'read') return Response.json({ path: operation.path, content: 'one\ntwo\nthree\n', revision: 'a'.repeat(64), size: 14 });
    return Response.json({ error: 'unexpected' }, { status: 400 });
  };
  for (const name of globals) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === 'window' ? window : name === 'fetch' ? fetch : (window as unknown as Record<string, unknown>)[name] });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.append(container);
});
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined;
  for (const name of globals) delete (globalThis as Record<string, unknown>)[name];
});
const settle = () => act(async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); });
async function render(element: React.ReactElement) {
  const { createRoot } = await import('react-dom/client');
  root = createRoot(container);
  await act(async () => root!.render(element)); await settle();
}

test('in the sidebar, the files tool is a list and a chosen file opens in its own tab', async () => {
  const { WorkspacePanel } = await import('../src/client/workspace/panel.js');
  const opened: string[] = [];
  await render(<WorkspacePanel sessionId="s1" tools={['files']} openFile={path => opened.push(path)} />);
  const entry = [...container.querySelectorAll<HTMLButtonElement>('.ra-ws-entries button')].find(b => b.textContent?.includes('main.ts'))!;
  await act(async () => entry.click()); await settle();
  assert.deepEqual(opened, ['main.ts']);
  assert.equal(container.querySelector('.ra-ws-viewer'), null, 'no viewer opens under the list');
  assert.equal(requests.some(r => (r.operation as { op?: string } | undefined)?.op === 'read'), false, 'the list does not read the file itself');
});

test('a file tab shows only that file, at the line it was opened at, without the list or its own close button', async () => {
  const [{ WorkspacePanel }, { editorOf }] = await Promise.all([import('../src/client/workspace/panel.js'), import('@dsh-plugins/file-view')]);
  await render(<WorkspacePanel sessionId="s1" tools={['files']} initialPath="main.ts" fileOnly line={3} />);
  assert.equal(container.querySelector('.ra-ws-browser'), null);
  const view = editorOf(container.querySelector('.cm-editor')!)!;
  assert.equal(view.state.sliceDoc(), 'one\ntwo\nthree\n');
  assert.equal(view.state.doc.lineAt(view.state.selection.main.head).number, 3);
  assert.equal(container.querySelector('[aria-label="Close file"]'), null, 'the tab has its own close button');
});
