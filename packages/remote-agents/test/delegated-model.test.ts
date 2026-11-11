import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots';
import type { AgentSummary } from '@dsh-plugins/remote-core/domain.js';
import { DELEGATED_ID, DELEGATED_SLOT, decorateCatalogSlot, mergeDelegatedCatalog, ownedDelegations, pollDelegations, remoteCatalogId, routeCatalogAddress, type CatalogSlots, type CatalogState } from '../src/client/sessions/delegated-model.js';

const agent: AgentSummary = { id: 'remote-task', ownerSessionId: 'parent', hostId: 'host', cwd: '/project', provider: 'codex', model: 'actual-model', modes: [], title: 'Review changes', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', archived: false, delegated: true, started: true, attached: true, status: 'running', pendingPermissions: 0 };
const native: CatalogState = { byId: { parent: { title: 'Parent' }, 'native-child': { title: 'Native child', running: true } }, projectionsBySession: { parent: { state: 'idle', values: { other: 42, subagentCatalog: [{ id: 'native-child', mode: 'continuable', label: 'Native', createdAt: 1 }] } }, 'native-child': { state: 'idle', values: { subagentCatalog: [] } } }, unrelated: 'unchanged' };

test('merge is presentation-only, isolated by owner, deduplicated, and preserves all native entries', () => {
  const before = structuredClone(native);
  const merged = mergeDelegatedCatalog(native, 'parent', [agent, agent, { ...agent, id: 'other-owner', ownerSessionId: 'other' }, { ...agent, id: 'chat', chatSessionId: 'parent' }, { ...agent, id: 'not-delegated', delegated: false }]);
  assert.deepEqual(native, before);
  assert.equal(merged.byId.parent, native.byId.parent);
  assert.equal(merged.byId['native-child'], native.byId['native-child']);
  assert.equal(merged.projectionsBySession['native-child'], native.projectionsBySession['native-child']);
  const rows = merged.projectionsBySession.parent.values.subagentCatalog!;
  assert.equal(rows.length, 2); assert.equal(rows[0], native.projectionsBySession.parent.values.subagentCatalog![0]);
  assert.equal(rows[1].id, 'remote-cli:remote-task'); assert.equal(rows[1].mode, 'one-shot');
  assert.equal(rows[1].createdAt, Date.parse(agent.createdAt));
  assert.match(rows[1].label!, /Remote CLI.*Codex.*Review changes/);
  assert.equal(merged.projectionsBySession.parent.values.other, 42);
  assert.deepEqual(merged.projectionsBySession[rows[1].id], { state: 'idle', values: { subagentCatalog: [] } });
  assert.deepEqual(mergeDelegatedCatalog(merged, 'parent', [agent]).projectionsBySession.parent.values.subagentCatalog, rows);
  assert.equal(mergeDelegatedCatalog(native, 'other', [agent]), native);
  assert.equal(mergeDelegatedCatalog(native, 'parent', []), native);
  assert.deepEqual(ownedDelegations([{ ...agent, archived: true }, { ...agent, id: 'legacy', ownerSessionId: undefined }], 'parent').map(a => a.id), [agent.id]);
});

test('honest statuses do not invent completion, timing, or token totals', () => {
  for (const status of ['starting', 'running', 'attention', 'idle', 'error', 'closed'] as const) {
    const state = mergeDelegatedCatalog(native, 'parent', [{ ...agent, status }]);
    const summary = state.byId[remoteCatalogId(agent.id)];
    assert.match(summary.title!, new RegExp(status)); assert.match(summary.title!, /actual-model/);
    assert.equal(summary.running, status === 'starting' || status === 'running');
    assert.deepEqual(summary.projectionValues, {});
  }
  const loading = { ...native, projectionsBySession: { ...native.projectionsBySession, parent: { state: 'error', error: 'native error', values: {} } } };
  const merged = mergeDelegatedCatalog(loading, 'parent', [agent]);
  assert.equal(merged.projectionsBySession.parent.state, 'error');
  assert.equal(merged.projectionsBySession.parent.error, 'native error');
});

test('remote routes never leak to native APIs; native address identity is unchanged', () => {
  const nativeCalls: unknown[] = [], remoteCalls: AgentSummary[] = [];
  const open = (address: { parentSessionId: string; childSessionId: string; mode: string }) => routeCatalogAddress(address, 'parent', [agent], a => remoteCalls.push(a), a => nativeCalls.push(a));
  const address = { parentSessionId: 'parent', childSessionId: 'native-child', mode: 'continuable' };
  open(address); assert.equal(nativeCalls[0], address);
  open({ ...address, childSessionId: remoteCatalogId(agent.id) }); assert.deepEqual(remoteCalls, [agent]);
  open({ ...address, childSessionId: 'remote-cli:missing' });
  open({ ...address, childSessionId: 'remote-cli:' });
  open({ ...address, parentSessionId: 'another-parent', childSessionId: remoteCatalogId(agent.id) });
  open({ ...address, parentSessionId: 'remote-cli:parent' });
  assert.equal(nativeCalls.length, 1); assert.equal(remoteCalls.length, 1);
});

const tick = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };
test('real SlotCore shadows exactly one original and follows HMR without registration loops', async () => {
  const core = new SlotCore();
  // Dynamic plugin slots are intentionally outside the statically augmented host SlotMap.
  const registry = core as unknown as CatalogSlots<() => null> & { entriesOfSlot(name: string): { component: () => null; inject?: unknown; locale?: unknown }[] };
  (core.register as Function)({ name: 'root', children: { [DELEGATED_SLOT]: { kind: 'list', scope: 'session' } } }, () => null);
  const wrappers: unknown[] = [], originals: unknown[] = [];
  const stop = decorateCatalogSlot(registry, original => { originals.push(original); const wrapper = () => null; wrappers.push(wrapper); return wrapper; });
  assert.equal(registry.entries(DELEGATED_SLOT).length, 0);
  const original = () => null, inject = () => ({ native: true });
  const remove = registry.register({ name: DELEGATED_SLOT, id: DELEGATED_ID, order: 10, priority: 0, locale: 'subagent', inject }, original) as () => void;
  await tick();
  assert.equal(wrappers.length, 1); assert.equal(registry.entries(DELEGATED_SLOT).length, 2);
  const [winner] = registry.entriesOfSlot(DELEGATED_SLOT);
  assert.equal(winner.component, wrappers[0]); assert.equal(winner.inject, inject); assert.equal(winner.locale, 'subagent');
  assert.equal(registry.entriesOfSlot(DELEGATED_SLOT).length, 1);
  await tick(); assert.equal(wrappers.length, 1);
  remove(); const replacement = () => null;
  const removeReplacement = registry.register({ name: DELEGATED_SLOT, id: DELEGATED_ID, priority: 0, locale: 'new-locale', inject }, replacement) as () => void;
  await tick(); assert.equal(wrappers.length, 2); assert.equal(registry.entries(DELEGATED_SLOT).length, 2);
  assert.equal(registry.entriesOfSlot(DELEGATED_SLOT)[0].locale, 'new-locale');
  stop(); stop(); await tick();
  assert.equal(registry.entries(DELEGATED_SLOT).length, 1); assert.equal(registry.entriesOfSlot(DELEGATED_SLOT)[0].component, replacement);
  removeReplacement(); await tick(); assert.equal(wrappers.length, 2);
});

test('decorator waits for absent native entry and removes its shadow on native unload', async () => {
  const core = new SlotCore();
  const registry = core as unknown as CatalogSlots<() => null>;
  const stop = decorateCatalogSlot(registry, () => () => null);
  (core.register as Function)({ name: 'root', children: { [DELEGATED_SLOT]: { kind: 'list', scope: 'session' } } }, () => null);
  await tick(); assert.equal(registry.entries(DELEGATED_SLOT).length, 0);
  const remove = registry.register({ name: DELEGATED_SLOT, id: DELEGATED_ID }, () => null) as () => void;
  await tick(); assert.equal(registry.entries(DELEGATED_SLOT).length, 2);
  remove(); await tick(); assert.equal(registry.entries(DELEGATED_SLOT).length, 0); stop();
});

test('poll cancellation ignores a late response even when the transport ignores abort', async () => {
  let resolve!: (agents: AgentSummary[]) => void, signal!: AbortSignal;
  const accepted: unknown[] = [], errors: unknown[] = [], scheduled: unknown[] = [];
  const stop = pollDelegations('parent', { request: (_id, value) => { signal = value; return new Promise(r => { resolve = r; }); }, accept: a => accepted.push(a), error: e => errors.push(e), schedule: callback => { scheduled.push(callback); return 1 as unknown as ReturnType<typeof setTimeout>; } });
  stop(); assert.equal(signal.aborted, true); resolve([agent]); await tick();
  assert.deepEqual(accepted, []); assert.deepEqual(errors, []); assert.deepEqual(scheduled, []);
});

test('poll failures retain successful items and cleanup clears its scheduled retry', async () => {
  let callback!: () => void, attempts = 0, cancelled = false;
  const accepted: AgentSummary[][] = [], errors: unknown[] = [];
  const stop = pollDelegations('parent', {
    request: async id => { assert.equal(id, 'parent'); if (++attempts === 2) throw new Error('offline'); return [agent]; },
    accept: a => accepted.push(a), error: e => errors.push(e),
    schedule: next => { callback = next; return 1 as unknown as ReturnType<typeof setTimeout>; }, cancel: () => { cancelled = true; },
  });
  await tick(); assert.equal(accepted.length, 1); callback(); await tick();
  assert.equal(accepted.length, 1); assert.equal(errors.length, 1);
  stop(); assert.equal(cancelled, true);
});
