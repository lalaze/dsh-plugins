import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apply, type Client } from '../src/client/index.js';
import type { LocaleRuntime } from '@dsh-plugins/i18n';
import type { ModelDirectoryState, ModelPickerProps, ModelSelection } from '../src/client/model-picker.js';

test('the grouped picker uses the native directory and selection contract, including reasoning and subagent restrictions', async t => {
  const state: ModelDirectoryState = { current: null, groups: [], failures: [], pending: null, status: 'ready', error: null };
  const store = { getSnapshot: () => state, subscribe: () => () => {} }, selections: ModelSelection[] = [], sessionIds: string[] = [];
  let loads = 0;
  const directory = { store, load: async () => { loads++; return state; }, select: async (selection: ModelSelection) => { selections.push(selection); return { ok: true as const }; } };
  const specs = new Map<string, Record<string, unknown>>(), cleanups: (() => void)[] = [];
  function get(name: 'locale'): LocaleRuntime | undefined;
  function get(name: string): unknown;
  function get(this: Client, name: string): unknown {
    assert.equal(this, ctx, 'Cordis service lookup must keep its receiver');
    if (name === 'modelDirectories') return { directoryFor: (id: string) => { sessionIds.push(id); return directory; } };
    if (name === 'sessions') return { subagentAddress: (id: string) => id === 'child' ? { parent: 'parent' } : undefined };
  }
  const ctx: Client = { get, effect: factory => { cleanups.push(factory()); }, slots: {
    inject: (_name, factory) => factory(), register: spec => { specs.set(String(spec.name), spec); },
  } };
  t.after(() => { for (const cleanup of cleanups.reverse()) cleanup(); });
  apply(ctx);
  const spec = specs.get('conversation.input.model')!;
  assert.equal(spec.priority, -1);
  const inject = spec.inject as (id: string) => ModelPickerProps;
  const face = inject('main'); assert.equal(face.directory, store); assert.equal(face.available, true);
  const selection = { provider: 'remote-cli-codex', model: 'a/model', reasoningEffort: 'high' };
  assert.deepEqual(await face.select(selection), { ok: true }); assert.deepEqual(selections, [selection]);
  face.load(); assert.equal(loads, 1);
  const child = inject('child'); assert.equal(child.available, false); child.load();
  assert.equal(await child.select(selection), undefined); assert.equal(loads, 1); assert.equal(selections.length, 1);
  assert.deepEqual(sessionIds, ['main', 'child']);
});
