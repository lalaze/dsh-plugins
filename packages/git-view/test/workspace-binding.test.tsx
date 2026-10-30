import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { installFakeMonaco, type FakeMonaco } from '@dsh-plugins/file-view/testing';
import { setSessions } from '../src/client/sessions.js';
import { StatusCache } from '../src/client/status.js';
import { GitView } from '../src/git.js';
import { GitError, type RemoteWorkspaces } from '../src/runner.js';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const original = 'same original\n';
const comparison = (content = original) => ({ location: { kind: 'local' }, path: 'a.ts', repoPath: 'a.ts', head: { kind: 'text', content: original },
  working: { kind: 'text', content, revision: hash(content), size: content.length }, code: ' M' });
const globals = ['window', 'document', 'navigator', 'MutationObserver', 'getComputedStyle', 'Node', 'Element', 'HTMLElement', 'Event', 'InputEvent', 'KeyboardEvent',
  'MouseEvent', 'requestAnimationFrame', 'cancelAnimationFrame', 'localStorage', 'fetch'] as const;
let root: Root | undefined, container: HTMLElement, fake: FakeMonaco;
let requests: Record<string, unknown>[], compare: () => unknown;
const sessions = (cwd: string) => setSessions({ list: { getSnapshot: () => ({ ids: ['s'], byId: { s: { cwd } } }), subscribe: () => () => {} } });
beforeEach(() => {
  const { window } = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/', pretendToBeVisual: true });
  fake = installFakeMonaco(); requests = []; compare = () => comparison();
  const fetch = async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body); requests.push(body);
    return Response.json(body.action === 'compare' ? await compare() : body.action === 'status' ? { prefix: '', changes: [] } : { revision: hash(String(body.content ?? '')) });
  };
  for (const name of globals) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === 'window' ? window : name === 'fetch' ? fetch : (window as unknown as Record<string, unknown>)[name] });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.append(container); sessions('/a');
});
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined; setSessions(undefined);
  for (const name of globals) delete (globalThis as Record<string, unknown>)[name];
});
const settle = () => act(async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); });
async function mount(cache: StatusCache) {
  const { DiffTab } = await import('../src/client/diff-tab.js'), { createRoot } = await import('react-dom/client');
  root = createRoot(container);
  await act(async () => root!.render(<DiffTab address="dsh-resource://file/session/s/a.ts" cache={cache} />)); await settle();
}
const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;

test('an open dirty diff stays bound to its workspace until explicitly reloaded', async () => {
  await mount(new StatusCache());
  assert.equal(requests[0].expectedCwd, '/a');
  const editor = fake.diffs[0];
  await act(async () => editor.getModel()!.modified.setValue('draft from A\n'));
  await act(async () => sessions('/b'));
  assert.equal(editor.getModel()!.modified.getValue(), 'draft from A\n', 'retargeting must not silently drop the draft');
  assert.equal(editor.getRawOptions().readOnly, true);
  assert.match(container.textContent!, /The workspace changed/);
  assert.equal(button('Save (⌘/Ctrl+S)').disabled, true);
  assert.equal(button('Stage this file').disabled, true);
  await act(async () => { button('Save (⌘/Ctrl+S)').click(); button('Stage this file').click(); });
  assert.equal(requests.some(r => r.action === 'save' || r.action === 'stage'), false);
  await act(async () => button('Reload').click()); await settle();
  assert.equal(requests.filter(r => r.action === 'compare').at(-1)!.expectedCwd, '/b');
  const reloaded = fake.diffs.at(-1)!;
  assert.equal(reloaded.getModel()!.modified.getValue(), original);
  await act(async () => reloaded.getModel()!.modified.setValue('draft from B\n'));
  await act(async () => button('Save (⌘/Ctrl+S)').click()); await settle();
  assert.equal(requests.find(r => r.action === 'save')!.expectedCwd, '/b');
  await act(async () => button('Stage this file').click()); await settle();
  assert.equal(requests.find(r => r.action === 'stage')!.expectedCwd, '/b');
});

test('typing during a delayed automatic comparison preserves the new draft', async () => {
  const cache = new StatusCache(); await mount(cache);
  let resolve!: (value: unknown) => void;
  compare = () => new Promise(done => { resolve = done; });
  await act(async () => cache.set('/a', { prefix: '', changes: [{ code: 'UU', path: 'a.ts', local: 'a.ts' }] })); await settle();
  const editor = fake.diffs[0];
  await act(async () => editor.getModel()!.modified.setValue('typed while SSH was reading\n'));
  await act(async () => resolve(comparison('new disk version\n'))); await settle();
  assert.equal(editor.getModel()!.modified.getValue(), 'typed while SSH was reading\n');
  assert.match(container.querySelector('.gv-notes')!.textContent!, /The file changed on disk/);
});

test('an older Remote Agents service fails clearly without executing local Git', async () => {
  const old = { target: async () => ({ hostId: 'host', label: 'host', cwd: '/repo' }) } as unknown as RemoteWorkspaces;
  const view = new GitView({ cwdOf: async () => '/home/me/.dsh/remote-workspaces/host/repo', remote: () => old, local: () => assert.fail('never use the local anchor') });
  await assert.rejects(view.overview('s', new AbortController().signal), (error: GitError) => error.status === 409 && /Update Remote Agents/.test(error.message));
});
