import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
// Only visual primitives are stubbed: preserve the original menu logic and navigation.
const Icon = () => <span aria-hidden="true" />;
const primitives = { IconRefreshOutlineRegular: Icon, IconChevronRightOutlineRegular: Icon, IconChevronDownOutlineRegular: Icon, StateDot: ({ state }: { state: string }) => <span data-state={state} />, Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</> };
import { DelegatedCatalog, type DelegatedCatalogProps } from '../src/client/sessions/delegated.js';
import type { CatalogState } from '../src/client/sessions/delegated-model.js';

// Set to a trusted DSH client bundle to verify the exact original dropdown, not a reimplementation.
// No host account, SSH connection, CLI process, or project mutation is used in this test.
test('actual native dropdown counts remote children and opens their read-only transcript', { skip: !process.env.DSH_NATIVE_SUBAGENT_BUNDLE }, async () => {
  const code = await readFile(process.env.DSH_NATIVE_SUBAGENT_BUNDLE!, 'utf8');
  const { window } = new JSDOM('<!doctype html><body><main></main></body>', { url: 'http://localhost/', pretendToBeVisual: true });
  window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  const requests: string[] = [], nativeCalls: unknown[] = [];
  const remote = { id: 'cli', ownerSessionId: 'parent', hostId: 'host', cwd: '/project', provider: 'codex', model: 'actual-cli-model', modes: [], title: 'CLI review', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', archived: false, delegated: true, started: true, attached: true, status: 'running', pendingPermissions: 0 };
  const fetch = async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body); requests.push(body.action);
    if (body.action === 'delegations') return Response.json([remote]);
    assert.equal(body.action, 'agent');
    return Response.json({ agent: remote, permissions: [], timeline: { epoch: 'e', entries: [{ seqStart: 1, seqEnd: 1, timestamp: remote.createdAt, item: { type: 'assistant_message', text: 'Saved remote transcript' } }], reset: false, staleCursor: false, gap: false, hasOlder: false, hasNewer: false } });
  };
  const values: Record<string, unknown> = { window, document: window.document, navigator: window.navigator, Node: window.Node, HTMLElement: window.HTMLElement, sessionStorage: window.sessionStorage, requestAnimationFrame: window.requestAnimationFrame.bind(window), fetch, IS_REACT_ACT_ENVIRONMENT: true };
  const old = new Map(Object.keys(values).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const [name, value] of Object.entries(values)) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  let root: import('react-dom/client').Root | undefined;
  try {
    let plugin: { apply(ctx: unknown): void } | undefined, Native: React.ComponentType<DelegatedCatalogProps> | undefined;
    const require = createRequire(import.meta.url);
    const dictionaries: Record<string, string> = {};
    const moduleWindow = window as unknown as { __ModuleLoader__: unknown };
    moduleWindow.__ModuleLoader__ = { load: (entry: { factory(require: (name: string) => unknown): unknown }) => { plugin = entry.factory(name => name === '@deepseek-ai/dsh-client-ui-primitives' ? primitives : require(name)) as typeof plugin; } };
    runInNewContext(code, { window: moduleWindow, document, Node: window.Node, HTMLElement: window.HTMLElement, console, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, requestAnimationFrame: window.requestAnimationFrame.bind(window) });
    plugin!.apply({ effect: (fn: () => unknown) => fn(), inject: () => {}, locale: { register: (_namespace: string, dict: { en: Record<string, string> }) => Object.assign(dictionaries, dict.en) }, slots: { inject: (_name: string, fn: () => void) => fn(), register: (spec: { id?: string }, component: React.ComponentType<DelegatedCatalogProps>) => { if (spec.id === 'subagent-catalog') Native = component; } } });
    assert.ok(Native);
    const state: CatalogState = { byId: { parent: {}, child: { title: 'Native child' } }, projectionsBySession: { parent: { state: 'idle', values: { subagentCatalog: [{ id: 'child', mode: 'continuable', createdAt: 1, label: 'Native child' }] } }, child: { state: 'idle', values: { subagentCatalog: [] } } } };
    const statuses = new Map();
    const t = (key: string, vars: Record<string, string | number> = {}) => (dictionaries[key] ?? key).replace(/\{(\w+)\}/g, (_all, name: string) => String(vars[name] ?? name));
    const { createRoot } = await import('react-dom/client'); root = createRoot(document.querySelector('main')!);
    await act(async () => root!.render(<DelegatedCatalog sessionId="parent" native={Native!} useSessions={selector => selector(state)} useSessionStatus={(selector: (value: Map<unknown, unknown>) => unknown) => selector(statuses)} t={t} openChild={address => nativeCalls.push(address)} openChildAside={address => nativeCalls.push(address)} refreshProjection={id => { assert.ok(!id.startsWith('remote-cli:')); }} />));
    await act(async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); });
    const trigger = document.querySelector('button[aria-haspopup]') as HTMLButtonElement;
    assert.ok(trigger); assert.match(trigger.textContent!, /2/);
    await act(async () => trigger.click());
    const rows = [...document.querySelectorAll('[role="treeitem"]')]; assert.equal(rows.length, 2);
    const row = rows.find(item => item.textContent?.includes('Remote CLI')); assert.ok(row);
    assert.notEqual(row.getAttribute('aria-disabled'), 'true');
    await act(async () => row.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    await act(async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); });
    assert.equal(nativeCalls.length, 0); assert.match(document.querySelector('dialog[open]')!.textContent!, /Saved remote transcript/);
    assert.ok(requests.includes('agent')); assert.ok(requests.every(action => action === 'agent' || action === 'delegations'));
  } finally {
    await act(async () => root?.unmount()); window.close();
    for (const [name, descriptor] of old) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete (globalThis as Record<string, unknown>)[name]; }
  }
});
