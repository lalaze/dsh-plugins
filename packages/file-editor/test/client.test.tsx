import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { claims, fileAddress } from '../src/client/address.js';

test('file addresses carry the session, a relative or absolute path and an optional line', () => {
  assert.deepEqual(fileAddress('dsh-resource://file/session/s1/src/a%20b.ts'), { sessionId: 's1', path: 'src/a b.ts' });
  assert.deepEqual(fileAddress('dsh-resource://file/session/s1//home/me/project/main.py#L12'), { sessionId: 's1', path: '/home/me/project/main.py', line: 12 });
  for (const address of ['https://example.com/a.ts', 'dsh-resource://file/session/s1', 'dsh-resource://browser/session/s1/a.ts', 'not a url']) assert.equal(fileAddress(address), undefined, address);
});

test('text and code files of known local conversations are claimed; images, remote workspaces and unknown sessions are not', () => {
  const cwds: Record<string, string> = { local: '/home/me/project', remote: '/home/me/.dsh/remote-workspaces/box/app' };
  const cwdOf = (id: string) => cwds[id];
  assert.equal(claims('dsh-resource://file/session/local/src/app.tsx', cwdOf), true);
  assert.equal(claims('dsh-resource://file/session/local/README.md', cwdOf), true);
  assert.equal(claims('dsh-resource://file/session/local/Makefile', cwdOf), true);
  assert.equal(claims('dsh-resource://file/session/local/logo.png', cwdOf), false);
  assert.equal(claims('dsh-resource://file/session/local/report.pdf', cwdOf), false);
  assert.equal(claims('dsh-resource://file/session/remote/src/app.tsx', cwdOf), false);
  assert.equal(claims('dsh-resource://file/session/other/src/app.tsx', cwdOf), false);
});

// The editor tab, mounted with a simulated file route.
let root: Root | undefined, container: HTMLElement;
const globals = ['window', 'document', 'navigator', 'MutationObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle', 'Node', 'Element', 'HTMLElement', 'Text', 'Range', 'Selection', 'KeyboardEvent', 'Event', 'DOMRect', 'Window', 'fetch'] as const;
let disk: { content: string; mtimeMs: number }, requests: Record<string, unknown>[];
const sha = async (text: string) => (await import('node:crypto')).createHash('sha256').update(text).digest('hex');
beforeEach(() => {
  const { window } = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/', pretendToBeVisual: true });
  window.Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
  window.Range.prototype.getBoundingClientRect = () => new window.DOMRect();
  disk = { content: '# Title\n', mtimeMs: 1 }; requests = [];
  const fetch = async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body); requests.push(body);
    const state = { path: 'README.md', size: Buffer.byteLength(disk.content), mtimeMs: disk.mtimeMs };
    if (body.action === 'stat') return Response.json(state);
    if (body.action === 'read') return Response.json({ ...state, kind: 'text', content: disk.content, revision: await sha(disk.content) });
    if (body.revision !== await sha(disk.content)) return Response.json({ error: 'The file changed on disk. Reload it before saving.' }, { status: 409 });
    disk = { content: body.content, mtimeMs: disk.mtimeMs + 1 };
    return Response.json({ ...state, size: Buffer.byteLength(disk.content), mtimeMs: disk.mtimeMs, revision: await sha(disk.content) });
  };
  for (const name of globals) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === 'window' ? window : name === 'fetch' ? fetch : (window as unknown as Record<string, unknown>)[name] });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.append(container);
});
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined;
  mock.timers.reset();
  for (const name of globals) delete (globalThis as Record<string, unknown>)[name];
});
const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); });
async function open() {
  const [{ createRoot }, { FileTab }, { editorOf }] = await Promise.all([import('react-dom/client'), import('../src/client/file-tab.js'), import('@dsh-plugins/file-view')]);
  root = createRoot(container);
  await act(async () => root!.render(<FileTab sessionId="s1" path="README.md" />));
  await settle();
  return () => editorOf(container.querySelector('.cm-editor')!)!;
}
const button = (label: string) => [...container.querySelectorAll('button')].find(b => b.textContent === label)!;

test('a file loads, edits are saved with their revision, and a stale save reports the change on disk', async () => {
  const view = await open();
  assert.equal(view().state.sliceDoc(), '# Title\n');
  assert.ok(button('Save').disabled);
  await act(async () => view().dispatch({ changes: { from: view().state.doc.length, insert: 'more\n' } }));
  assert.ok(container.querySelector('.fe-dirty'));
  await act(async () => button('Save').click()); await settle();
  assert.equal(disk.content, '# Title\nmore\n');
  assert.equal(requests.at(-1)!.revision, await sha('# Title\n'));
  assert.equal(container.querySelector('.fe-dirty'), null);
  // Someone else saves; this tab's next save is refused instead of overwriting it.
  disk = { content: 'theirs\n', mtimeMs: 99 };
  await act(async () => view().dispatch({ changes: { from: 0, insert: 'mine ' } }));
  await act(async () => button('Save').click()); await settle();
  assert.equal(disk.content, 'theirs\n');
  assert.match(container.querySelector('[data-tone=warn]')!.textContent!, /changed on disk/);
  assert.match(container.querySelector('[role=alert]')!.textContent!, /Reload it before saving/);
});

test('changes made elsewhere reload a clean file by themselves and are only reported over unsaved edits', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const view = await open();
  disk = { content: '# Agent edit\n', mtimeMs: 2 };
  await act(async () => mock.timers.tick(2000)); await settle();
  assert.equal(view().state.sliceDoc(), '# Agent edit\n');
  await act(async () => view().dispatch({ changes: { from: 0, insert: 'draft ' } }));
  disk = { content: '# Second edit\n', mtimeMs: 3 };
  await act(async () => mock.timers.tick(2000)); await settle();
  assert.equal(view().state.sliceDoc(), 'draft # Agent edit\n', 'unsaved edits are kept');
  assert.ok(container.querySelector('[data-tone=warn]'));
  assert.equal(button('Reload').disabled, false, 'reloading is offered');
});

for (const action of ['stat', 'read'] as const) {
  test(`edits made during a pending background ${action} survive automatic refresh`, async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const view = await open();
    const originalFetch = globalThis.fetch;
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    let intercepted = false;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      const body = JSON.parse(String(args[1]?.body));
      if (body.action === action) { intercepted = true; await pending; }
      return originalFetch(...args);
    }) as typeof fetch;
    disk = { content: '# Agent edit\n', mtimeMs: 2 };
    await act(async () => mock.timers.tick(2000)); await settle();
    assert.ok(intercepted, 'the background request is in flight');
    await act(async () => view().dispatch({ changes: { from: 0, insert: 'my draft ' } }));
    await act(async () => release()); await settle();
    assert.equal(view().state.sliceDoc(), 'my draft # Title\n');
    assert.ok(container.querySelector('.fe-dirty'));
    assert.ok(container.querySelector('[data-tone=warn]'), 'the disk change is reported without replacing the draft');
    if (action === 'stat') assert.equal(requests.filter(r => r.action === 'read').length, 1, 'no refresh read starts over a new draft');
  });
}

test('the file loads under React StrictMode effect replay', async () => {
  const [{ createRoot }, { FileTab }] = await Promise.all([import('react-dom/client'), import('../src/client/file-tab.js')]);
  root = createRoot(container);
  await act(async () => root!.render(<React.StrictMode><FileTab sessionId="s1" path="README.md" /></React.StrictMode>));
  await settle();
  assert.ok(container.querySelector('.cm-editor'), 'a replayed mount still accepts the loaded file');
});

test('Markdown can be previewed, rendered without raw HTML', async () => {
  disk = { content: '# Heading\n\n<script>alert(1)</script>\n\n| a | b |\n| - | - |\n| 1 | 2 |\n', mtimeMs: 1 };
  await open();
  await act(async () => button('Preview').click());
  assert.equal(container.querySelector('.fv-markdown h1')!.textContent, 'Heading');
  assert.ok(container.querySelector('.fv-markdown table'), 'GitHub tables render');
  assert.equal(container.querySelector('.fv-markdown script'), null);
});

test('the plugin registers a file viewer for local text files and its sidebar pane', async () => {
  const { apply, KIND } = await import('../src/client/index.js');
  const registered: Record<string, unknown>[] = [], panes: Record<string, unknown>[] = [];
  const services: Record<string, unknown> = {
    sidebarRightTabs: { register: (spec: Record<string, unknown>) => { registered.push(spec); return () => registered.splice(registered.indexOf(spec), 1); } },
    sessions: { list: { getSnapshot: () => ({ byId: { s1: { cwd: '/home/me/project' } } }) } },
  };
  const cleanups: (() => void)[] = [];
  type Ctx = { get(name: string): unknown; effect(factory: () => () => void): void; inject(names: string[], factory: (scoped: Ctx) => void): void; slots: { inject(name: string, factory: () => unknown): unknown; register(spec: Record<string, unknown>): () => void } };
  const ctx: Ctx = {
    get: (name: string) => services[name],
    effect: (factory: () => () => void) => { cleanups.push(factory()); },
    inject: (_names: string[], factory: (scoped: typeof ctx) => void) => factory(ctx),
    slots: { inject: (_name: string, factory: () => unknown) => factory(), register: (spec: Record<string, unknown>) => { panes.push(spec); return () => {}; } },
  };
  apply(ctx as never);
  assert.equal(registered.length, 1);
  const spec = registered[0] as { kind: string; patterns: string[]; canOpen(address: string): boolean; title(address: string): string };
  assert.equal(spec.kind, KIND); assert.deepEqual(spec.patterns, ['dsh-resource://file/**']);
  assert.equal(spec.canOpen('dsh-resource://file/session/s1/src/a.ts'), true);
  assert.equal(spec.canOpen('dsh-resource://file/session/s1/a.png'), false);
  assert.equal(spec.title('dsh-resource://file/session/s1/src/a.ts'), 'a.ts');
  assert.deepEqual(panes, [{ name: 'sidebar.right.pane.tab', key: KIND }]);
  for (const cleanup of cleanups) cleanup();
  assert.equal(registered.length, 0, 'unloading removes the viewer');
});

test('a conversation link’s line, passed as a navigation parameter, is where the file opens', async () => {
  disk = { content: 'one\ntwo\nthree\n', mtimeMs: 1 };
  const [{ createRoot }, { Tab }, { editorOf }] = await Promise.all([import('react-dom/client'), import('../src/client/index.js'), import('@dsh-plugins/file-view')]);
  root = createRoot(container);
  const tab = { navigation: { address: 'dsh-resource://file/session/s1/README.md', params: { line: 2 } } };
  await act(async () => root!.render(<Tab sessionId="s1" useTabInfo={() => ({ tab })} />)); await settle();
  const view = editorOf(container.querySelector('.cm-editor')!)!;
  assert.equal(view.state.doc.lineAt(view.state.selection.main.head).number, 2);
});
