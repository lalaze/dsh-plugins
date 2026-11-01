import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import type { AgentDetail, AgentSummary, TimelinePage } from '../src/core/domain.js';
import { SessionDetail } from '../src/client/sessions/sessions.js';

let root: Root | undefined, container: HTMLElement, requests: Record<string, unknown>[];
const globals = ['window', 'document', 'navigator', 'Node', 'HTMLElement', 'sessionStorage', 'requestAnimationFrame', 'fetch'] as const;
const originalGlobals = new Map<string, PropertyDescriptor | undefined>();
const agent: AgentSummary = { id: 'delegated-one', ownerSessionId: 'parent-one', hostId: 'remote-host', cwd: '/srv/project', provider: 'codex', model: 'remote-model', modes: [{ id: 'full-access', label: 'Full access' }], title: 'Delegated work', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', archived: false, delegated: true, started: true, attached: true, status: 'attention', pendingPermissions: 1 };
const page = (older: boolean): TimelinePage => ({ epoch: 'epoch-one', reset: false, staleCursor: false, gap: false, entries: [{ seqStart: older ? 1 : 2, seqEnd: older ? 1 : 2, timestamp: agent.createdAt, item: { type: older ? 'user_message' : 'assistant_message', text: older ? 'Original task' : 'Full saved answer' } }], startCursor: { epoch: 'epoch-one', seq: older ? 1 : 2 }, endCursor: { epoch: 'epoch-one', seq: older ? 1 : 2 }, hasOlder: !older, hasNewer: older });
beforeEach(() => {
  const { window } = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/', pretendToBeVisual: true });
  requests = [];
  const fetch = async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body); requests.push(body);
    assert.equal(body.action, 'agent', 'observation must never issue a mutation');
    const detail: AgentDetail = { agent, permissions: [{ id: 'approval', name: 'Bash', kind: 'tool', title: 'Run tests?', input: { command: 'pnpm test' } }], timeline: page(body.direction === 'before') };
    return Response.json(detail);
  };
  for (const name of globals) {
    originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === 'window' ? window : name === 'fetch' ? fetch : name === 'requestAnimationFrame' ? window.requestAnimationFrame.bind(window) : (window as unknown as Record<string, unknown>)[name] });
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.append(container);
});
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined;
  window.close();
  for (const name of globals) { const descriptor = originalGlobals.get(name); if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete (globalThis as Record<string, unknown>)[name]; }
});
const settle = () => act(async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); });
async function render(readOnly: boolean) {
  const { createRoot } = await import('react-dom/client'); root = createRoot(container);
  await act(async () => root!.render(<SessionDetail original={agent} changed={() => {}} readOnly={readOnly} />));
  await settle();
}

test('read-only delegated detail preserves paged history and pending requests without steering controls', async () => {
  await render(true);
  assert.match(container.textContent!, /remote-model/);
  assert.match(container.textContent!, /Full saved answer/);
  assert.match(container.textContent!, /Run tests\?/);
  assert.match(container.textContent!, /pnpm test/);
  assert.equal(container.querySelector('form, textarea, select, .ra-detail-actions, .ra-rename'), null);
  const earlier = [...container.querySelectorAll('button')].find(button => button.textContent === 'Load earlier messages');
  assert.ok(earlier);
  await act(async () => earlier.click()); await settle();
  assert.match(container.textContent!, /Original task/);
  assert.match(container.textContent!, /Full saved answer/);
  assert.ok(requests.some(request => request.direction === 'before'));
  assert.equal(requests.every(request => request.action === 'agent'), true);
});

test('the existing session panel retains its steering controls by default', async () => {
  await render(false);
  assert.ok(container.querySelector('textarea'));
  assert.ok(container.querySelector('.ra-detail-actions'));
  assert.ok([...container.querySelectorAll('button')].some(button => button.textContent?.includes('Stop')));
});
