import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import type { AgentSummary } from '../src/core/domain.js';
import { DelegatedCatalog, type DelegatedCatalogProps } from '../src/client/sessions/delegated.js';
import type { CatalogAddress, CatalogState } from '../src/client/sessions/delegated-model.js';

const agent: AgentSummary = { id: 'cli-one', ownerSessionId: 'parent', hostId: 'host', cwd: '/project', provider: 'codex', model: 'remote-model', modes: [], title: 'Remote review', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', archived: false, delegated: true, started: true, attached: true, status: 'running', pendingPermissions: 0 };
const state: CatalogState = { byId: { parent: {}, child: { title: 'Original native child' }, other: {} }, projectionsBySession: { parent: { state: 'idle', values: { subagentCatalog: [{ id: 'child', createdAt: 1, mode: 'continuable', label: 'Native child' }] } }, child: { state: 'idle', values: { subagentCatalog: [] } } } };
let root: Root | undefined, container: HTMLElement, requests: Record<string, unknown>[], nativeCalls: CatalogAddress[];
const names = ['window', 'document', 'navigator', 'Node', 'HTMLElement', 'sessionStorage', 'requestAnimationFrame', 'fetch', 'IS_REACT_ACT_ENVIRONMENT'] as const;
const originals = new Map<string, PropertyDescriptor | undefined>();
let deferred: ((response: Response) => void) | undefined;
beforeEach(() => {
  const { window } = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/', pretendToBeVisual: true });
  window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  requests = []; nativeCalls = []; deferred = undefined;
  const fetch = async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body); requests.push(body);
    if (body.action === 'delegations') {
      if (body.sessionId === 'delayed') return new Promise<Response>(resolve => { deferred = resolve; });
      return Response.json(body.sessionId === 'parent' ? [agent] : []);
    }
    assert.equal(body.action, 'agent', 'viewer must never send a mutation');
    return Response.json({ agent, permissions: [], timeline: { epoch: 'one', reset: false, staleCursor: false, gap: false, hasOlder: false, hasNewer: false, startCursor: { epoch: 'one', seq: 1 }, endCursor: { epoch: 'one', seq: 1 }, entries: [{ seqStart: 1, seqEnd: 1, timestamp: agent.createdAt, item: { type: 'assistant_message', text: 'Real saved CLI transcript' } }] } });
  };
  for (const name of names) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === 'window' ? window : name === 'fetch' ? fetch : name === 'IS_REACT_ACT_ENVIRONMENT' ? true : name === 'requestAnimationFrame' ? window.requestAnimationFrame.bind(window) : (window as unknown as Record<string, unknown>)[name] });
  }
  container = document.createElement('div'); document.body.append(container);
});
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined; window.close();
  for (const name of names) { const descriptor = originals.get(name); if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete (globalThis as Record<string, unknown>)[name]; }
});
const settle = () => act(async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); });
// Host-contract fixture: the original component selects from the merged read view and owns navigation.
function Native(props: DelegatedCatalogProps) {
  const rows = props.useSessions(s => s.projectionsBySession[props.sessionId]?.values.subagentCatalog ?? []);
  const summaries = props.useSessions(s => s.byId);
  return <section data-native-menu><span>{rows.length} children</span>{rows.map(row => <button key={row.id} data-child={row.id} onClick={() => props.openChild({ parentSessionId: props.sessionId, childSessionId: row.id, mode: row.mode })}>{row.label} {summaries[row.id]?.title}</button>)}</section>;
}
async function render(sessionId = 'parent') {
  if (!root) { const { createRoot } = await import('react-dom/client'); root = createRoot(container); }
  await act(async () => root!.render(<DelegatedCatalog key={sessionId} sessionId={sessionId} native={Native} useSessions={selector => selector(state)} openChild={address => nativeCalls.push(address)} openChildAside={address => nativeCalls.push(address)} refreshProjection={() => {}} />));
  await settle();
}

test('one native dropdown contains both kinds; remote selection opens read-only transcript without native navigation', async () => {
  await render();
  assert.equal(container.querySelectorAll('[data-native-menu]').length, 1);
  assert.match(container.textContent!, /2 children/);
  assert.match(container.textContent!, /Native child/); assert.match(container.textContent!, /Remote CLI.*Remote review/);
  await act(async () => (container.querySelector('[data-child="child"]') as HTMLButtonElement).click());
  assert.deepEqual(nativeCalls, [{ parentSessionId: 'parent', childSessionId: 'child', mode: 'continuable' }]);
  await act(async () => (container.querySelector('[data-child="remote-cli:cli-one"]') as HTMLButtonElement).click()); await settle();
  assert.equal(nativeCalls.length, 1);
  const dialog = document.querySelector('dialog[open]'); assert.ok(dialog);
  assert.match(dialog.textContent!, /Real saved CLI transcript/); assert.match(dialog.textContent!, /remote-model/);
  assert.equal(dialog.querySelector('form, textarea, select, .ra-detail-actions'), null);
  assert.ok(requests.some(request => request.action === 'agent'));
  await act(async () => (dialog.querySelector('.ra-dialog-bar button') as HTMLButtonElement).click());
  assert.equal(document.querySelector('dialog'), null); assert.equal(document.body.style.overflow, '');
  assert.equal(state.projectionsBySession.parent.values.subagentCatalog!.length, 1);
});

test('switching conversations removes selection and late previous-owner responses cannot leak entries', async () => {
  await render('delayed'); assert.ok(deferred);
  const previous = deferred;
  await render('other');
  await act(async () => previous(Response.json([{ ...agent, ownerSessionId: 'delayed' }]))); await settle();
  assert.doesNotMatch(container.textContent!, /Remote review/); assert.match(container.textContent!, /0 children/);
  await render();
  await act(async () => (container.querySelector('[data-child="remote-cli:cli-one"]') as HTMLButtonElement).click()); await settle();
  assert.ok(document.querySelector('dialog'));
  await render('other'); assert.equal(document.querySelector('dialog'), null);
  assert.doesNotMatch(container.textContent!, /Remote review/);
});
