import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { defaultSettings, settingsFrom } from '../src/domain.js';
import { AutofixSettings } from '../src/client/settings.js';

let root: Root | undefined, container: HTMLElement;
const globals = ['window', 'document', 'navigator', 'MutationObserver', 'Node', 'Element', 'HTMLElement', 'Event', 'fetch'] as const;
/** What the plugin answers, by action. */
let answers: Record<string, unknown> = {};
const asked: string[] = [];
beforeEach(() => {
  const { window } = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/', pretendToBeVisual: true });
  const fetch = async (_url: string, init: { body: string }) => {
    const { action } = JSON.parse(init.body) as { action: string };
    asked.push(action);
    return new Response(JSON.stringify(answers[action] ?? {}), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  for (const name of globals) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === 'window' ? window : name === 'fetch' ? fetch : (window as unknown as Record<string, unknown>)[name] });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.append(container);
});
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined;
  for (const name of globals) delete (globalThis as Record<string, unknown>)[name];
});
const settle = () => act(async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); });

test('a repository whose folder is no longer a workspace is pointed out, and there is no switch for other DSHes', async () => {
  const settings = settingsFrom({ ...defaultSettings(), routes: [{ name: 'Web', project: '/old/web', defaultBranch: 'main' }, { name: 'Admin', project: '/ws/admin', defaultBranch: 'main' }] });
  answers = {
    state: { state: { settings, sources: [], pool: [], tasks: [], needs: [] } },
    projects: { projects: [{ path: '/ws/admin', title: 'admin', location: { kind: 'local' }, folder: '/ws/admin' }], missing: ['/old/web'] },
  };
  const { createRoot } = await import('react-dom/client');
  root = createRoot(container);
  await act(async () => root!.render(<AutofixSettings board={() => undefined} leave={() => undefined} />));
  await settle();
  assert.ok(asked.includes('projects'));
  const heads = [...container.querySelectorAll('.tp-repo-head')];
  assert.deepEqual(heads.map(head => [head.querySelector('.tp-repo-name')?.textContent, head.querySelector('.tp-badge[data-warn]')?.textContent ?? null]), [['Web', 'Workspace gone'], ['Admin', null]]);
  assert.doesNotMatch(container.textContent!, /other DSHes/);
  // Opened, the card says what to do about it.
  await act(async () => { (heads[0] as HTMLButtonElement).click(); });
  await settle();
  assert.match(container.querySelector('.tp-repo-body .tp-error')?.textContent ?? '', /no longer a workspace of this DSH/);
});
