import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots';
import { apply, type Client } from '../src/client/index.js';

test('enabling remote agents preserves the native model seat and its already-declared label slot', t => {
  const core = new SlotCore();
  // Fixture declares the shell contracts at the same erased boundary as JavaScript host bundles.
  const register = core.register.bind(core) as (options: Record<string, unknown>, component: unknown) => () => void;
  register({ name: 'root', children: {
    'settings.section': { kind: 'list', scope: 'root' },
    'sidebar.footer.action': { kind: 'list', scope: 'root' },
    'conversation.input.model': { kind: 'single', scope: 'session' },
  } }, () => null);
  const native = () => null;
  register({ name: 'conversation.input.model', children: {
    'conversation.input.model.label': { kind: 'single', scope: 'session', inline: true },
  } }, native);
  const cleanups: (() => void)[] = [];
  const ctx = {
    get(name: string) { return name === 'modelDirectories' ? { directoryFor() { throw new Error('Native picker owns model selection'); } } : undefined; },
    effect(factory: () => () => void) { cleanups.push(factory()); },
    slots: { inject: (_name: string, factory: () => void) => factory(), register: core.register.bind(core) },
  } as Client;
  t.after(() => { for (const cleanup of cleanups.reverse()) cleanup(); });
  assert.doesNotThrow(() => apply(ctx));
  assert.equal(core.entriesOfSlot('conversation.input.model')[0].component, native);
  assert.equal(core.entries('conversation.input.model').length, 1);
  assert.ok(core.specDynamic('conversation.input.model.label'));
});
