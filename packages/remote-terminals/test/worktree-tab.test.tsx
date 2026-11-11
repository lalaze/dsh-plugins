import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { offerWorktreeTab } from '@dsh-plugins/remote-core/client/worktree-tab.js';
// Add workspace is Remote Agents' dialog; its "From a project" tab is this plugin's.
import { workspaceFlow, type DirectoryFlowProps } from '../../remote-agents/src/client/workspace/flow.js';
import { api } from '../src/client/api.js';
import { ProjectFlow } from '../src/client/worktree.js';
import type { WorktreeProject, WorktreeProjectDetail } from '../src/worktrees.js';

let root: Root | undefined, container: HTMLElement, requests: { url: string; action?: string }[];
const globals = ['window', 'document', 'navigator', 'location', 'localStorage', 'MutationObserver', 'getComputedStyle', 'Node', 'Element', 'HTMLElement', 'HTMLInputElement', 'Event', 'fetch'] as const;
const project: WorktreeProject = { path: '/Users/me/code/shop-app', title: 'shop-app', location: { kind: 'local' }, folder: '/Users/me/code/shop-app' };
const detail: WorktreeProjectDetail = { path: project.path, location: project.location, home: '/Users/me', name: 'shop-app', repository: project.path, subdir: '', head: 'main', defaultBase: 'main',
  branches: [{ name: 'main', local: true, remote: 'origin/main', date: 1_762_000_000 }], root: '/Users/me/.dsh/worktrees/shop-app-1a2b', setup: [], worktrees: [] };
beforeEach(() => {
  const { window } = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/', pretendToBeVisual: true });
  window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  requests = [];
  // Each plugin's page asks its own server: Remote Agents for the machines, this plugin for projects.
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input), action = init?.body ? JSON.parse(String(init.body)).action as string : undefined;
    requests.push({ url, action });
    if (url === '/api/remote-agents' && !action) return Response.json({ hosts: [{ id: 'host-box-1', label: 'Box', connection: 'ssh://builder@box', status: 'connected', modelCount: 1 }], agents: [] });
    if (url === '/api/remote-terminals' && action === 'worktreeProjects') return Response.json([project]);
    if (url === '/api/remote-terminals' && action === 'worktreeInspect') return Response.json(detail);
    return Response.json({ error: `unexpected ${url} ${action}` }, { status: 500 });
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
const tabs = () => [...document.querySelectorAll('.ra-flow-tabs [role=tab]')].map(tab => tab.textContent);
async function open() {
  const { createRoot } = await import('react-dom/client');
  const Flow = workspaceFlow(() => undefined), props: DirectoryFlowProps = { open: true, busy: false, onPicked: () => {}, onCancel: () => {}, onError: () => {} };
  root = createRoot(container);
  await act(async () => root!.render(<Flow {...props} />)); await settle();
}

test('Add workspace has no project tab while this plugin is not there, and never asks Remote Agents for projects', async () => {
  window.localStorage.setItem('dsh-remote-agents.workspace-flow.tab', 'project');
  await open();
  assert.deepEqual(tabs(), ['This computer', 'Remote machine']);
  assert.equal(document.querySelector('.ra-flow-tabs [aria-selected=true]')!.textContent, 'This computer', 'a remembered project tab falls back');
  assert.deepEqual(requests, [{ url: '/api/remote-agents', action: undefined }]);
});

test('once this plugin offers it, the dialog shows the project tab, drawn by this plugin from its own server', async () => {
  const withdraw = offerWorktreeTab({ projects: signal => api<WorktreeProject[]>('worktreeProjects', {}, signal), Flow: ProjectFlow });
  await open();
  assert.deepEqual(tabs(), ['This computer', 'Remote machine', 'From a project']);
  const tab = [...document.querySelectorAll<HTMLButtonElement>('.ra-flow-tabs [role=tab]')].at(-1)!;
  await act(async () => { tab.click(); }); await settle();
  assert.ok(document.querySelector('.ra-flow .ra-wt'), 'the form is drawn inside the dialog');
  assert.ok([...document.querySelectorAll('.ra-flow style')].some(style => style.textContent!.includes('.ra-wt-segment')), 'with its own styles');
  assert.match(document.querySelector('.ra-flow')!.textContent!, /shop-app/);
  assert.deepEqual(requests.map(r => `${r.url} ${r.action ?? 'GET'}`), ['/api/remote-terminals worktreeProjects', '/api/remote-agents GET', '/api/remote-terminals worktreeInspect']);
  // Switched off again, the next dialog is without it.
  withdraw();
  await act(async () => root?.unmount()); root = undefined; requests = [];
  await open();
  assert.deepEqual(tabs(), ['This computer', 'Remote machine']);
});
