import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots';
import { apply, type Client } from '../src/client/index.js';
import { DIRECTORY_FLOWS } from '../src/client/workspace/flow.js';

test('Add workspace shadows DSH\'s own picker, yields to dsh-remote and restores the picker on unload', () => {
  for (const withDshRemote of [false, true]) {
    const core = new SlotCore();
    const register = core.register.bind(core) as (options: Record<string, unknown>, component: unknown) => () => void;
    const slots = core as unknown as { spec(name: string): unknown; entriesOfSlot(name: string): readonly { component: unknown }[] };
    register({ name: 'root', children: Object.fromEntries(DIRECTORY_FLOWS.map(name => [name, { kind: 'single', scope: 'root' }])) }, () => null);
    const native = () => null, dshRemote = () => null;
    for (const name of DIRECTORY_FLOWS) {
      register({ name }, native);
      if (withDshRemote) register({ name, id: 'dsh-remote', priority: -100 }, dshRemote);
    }
    const cleanups: (() => void)[] = [];
    const ctx = {
      effect(factory: () => () => void) { cleanups.push(factory()); },
      // Like the renderer, inject runs only once its slot is declared.
      slots: { inject(name: string, factory: () => unknown) { if (!slots.spec(name)) return; const dispose = factory(); if (typeof dispose === 'function') cleanups.push(dispose as () => void); }, register },
    } as Client;
    apply(ctx);
    const winners = () => DIRECTORY_FLOWS.map(name => slots.entriesOfSlot(name)[0]?.component);
    for (const winner of winners()) {
      assert.notEqual(winner, native);
      assert.equal(winner === dshRemote, withDshRemote);
    }
    for (const cleanup of cleanups.reverse()) cleanup();
    assert.deepEqual(winners(), DIRECTORY_FLOWS.map(() => withDshRemote ? dshRemote : native));
  }
});
