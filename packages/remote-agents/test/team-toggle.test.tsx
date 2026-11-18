import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots';
import type { CatalogSlots } from '../src/client/sessions/delegated-model.js';
import { installTeamToggleFilter, TEAM_ID, TEAM_SLOT } from '../src/client/composer/team-toggle.js';
import { setModelDirectories, type Selection } from '../src/client/composer/usage.js';

type Component = React.ComponentType<any>;
type Registry = CatalogSlots<Component> & { entriesOfSlot(name: string): { component: Component; inject?: unknown; locale?: unknown }[] };

let root: Root | undefined, container: HTMLElement;
const globals = ['window', 'document', 'navigator', 'Node', 'HTMLElement'] as const;
const originalGlobals = new Map<string, PropertyDescriptor | undefined>();
beforeEach(() => {
  const { window } = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
  for (const name of globals) {
    originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === 'window' ? window : (window as unknown as Record<string, unknown>)[name] });
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.append(container);
});
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined;
  setModelDirectories(undefined);
  window.close();
  for (const name of globals) { const descriptor = originalGlobals.get(name); if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete (globalThis as Record<string, unknown>)[name]; }
});

/** A conversation's model as DSH's picker directory holds it, changeable as a pick in the menu would. */
function pickedModel(initial: Selection | null) {
  let current = initial; const listeners = new Set<() => void>();
  const store = { getSnapshot: () => ({ current }), subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
  setModelDirectories({ directoryFor: () => ({ store }) });
  return (next: Selection | null) => act(async () => { current = next; for (const listener of listeners) listener(); });
}
/** DSH's model menu slot with the agent-team switch registered as `dsh-client-ui-agent-team` does. */
function menu() {
  const core = new SlotCore(), registry = core as unknown as Registry;
  (core.register as Function)({ name: 'root', children: { [TEAM_SLOT]: { kind: 'list', scope: 'session' } } }, () => null);
  const inject = () => ({ selectTeamMode: async () => null });
  const Native = ({ sessionId }: { sessionId: string }) => <label data-team-switch={sessionId}>启用智能体团队协作</label>;
  registry.register({ name: TEAM_SLOT, id: TEAM_ID, locale: 'agent-team', inject }, Native);
  return { registry, inject };
}
async function render(Component: Component) {
  const { createRoot } = await import('react-dom/client'); root = createRoot(container);
  await act(async () => root!.render(<Component sessionId="chat" locked={false} />));
}

test('the agent-team switch is shown for DSH models and hidden while a remote CLI is selected', async () => {
  const { registry, inject } = menu();
  const stop = installTeamToggleFilter(registry);
  const [winner] = registry.entriesOfSlot(TEAM_SLOT);
  assert.equal(registry.entriesOfSlot(TEAM_SLOT).length, 1, 'the switch is never shown twice');
  assert.equal(winner.inject, inject); assert.equal(winner.locale, 'agent-team');
  const pick = pickedModel({ provider: 'remote-cli-codex', model: 'mac/codex/gpt-6.2-sol', reasoningEffort: 'xhigh' });
  await render(winner.component);
  assert.equal(container.querySelector('[data-team-switch]'), null);
  await pick({ provider: 'local-qwen', model: 'local-current' });
  assert.equal(container.querySelector('[data-team-switch]')?.getAttribute('data-team-switch'), 'chat', 'props reach DSH\'s own switch');
  await pick({ provider: 'remote-cli-claude', model: 'mac/claude/opus' });
  assert.equal(container.querySelector('[data-team-switch]'), null);
  // Before the picker knows the model, DSH's own behaviour stands.
  await pick(null);
  assert.ok(container.querySelector('[data-team-switch]'));
  stop();
  assert.notEqual(registry.entriesOfSlot(TEAM_SLOT)[0].component, winner.component, 'unloading restores DSH\'s entry');
});

test('without the model service the switch stays as DSH shows it', async () => {
  const { registry } = menu();
  const stop = installTeamToggleFilter(registry);
  await render(registry.entriesOfSlot(TEAM_SLOT)[0].component);
  assert.ok(container.querySelector('[data-team-switch]'));
  stop();
});
