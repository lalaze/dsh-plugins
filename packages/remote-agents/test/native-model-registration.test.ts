import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { apply, type Client } from '../src/client/index.js';
import { ModelLabel, type ModelLabelProps } from '../src/client/composer/model-label.js';

test('enabling remote agents preserves the native model seat and its already-declared label slot', t => {
  const core = new SlotCore();
  // Fixture declares the shell contracts at the same erased boundary as JavaScript host bundles.
  const register = core.register.bind(core) as (options: Record<string, unknown>, component: unknown) => () => void;
  register({ name: 'root', children: {
    'settings.section': { kind: 'list', scope: 'root' },
    'sidebar.footer.action': { kind: 'list', scope: 'root' },
    'conversation.input.model': { kind: 'single', scope: 'session' },
    'conversation.input.right': { kind: 'list', scope: 'session' },
  } }, () => null);
  const native = () => null;
  register({ name: 'conversation.input.model', children: {
    'conversation.input.model.label': { kind: 'single', scope: 'session', inline: true },
  } }, native);
  const cleanups: (() => void)[] = [];
  const ctx = {
    get(name: string) { return name === 'modelDirectories' ? { directoryFor() { throw new Error('Native picker owns model selection'); } } : undefined; },
    effect(factory: () => () => void) { cleanups.push(factory()); },
    // Like the renderer, inject runs only once its slot is declared.
    slots: { inject: (name: string, factory: () => void) => (core as unknown as { spec(name: string): unknown }).spec(name) ? factory() : undefined, register: core.register.bind(core) },
  } as Client;
  t.after(() => { for (const cleanup of cleanups.reverse()) cleanup(); });
  assert.doesNotThrow(() => apply(ctx));
  assert.equal(core.entriesOfSlot('conversation.input.model')[0].component, native);
  assert.equal(core.entries('conversation.input.model').length, 1);
  assert.ok(core.specDynamic('conversation.input.model.label'));
  assert.equal(core.entriesOfSlot('conversation.input.model.label')[0].component, ModelLabel);
  assert.equal(core.entries('conversation.input.right').length, 1, 'the usage ring sits before the submit action');
});

test('remote model captions drop the host while list rows keep it muted', () => {
  const html = (provider: string, name: string, placement: ModelLabelProps['placement']) => renderToStaticMarkup(React.createElement(ModelLabel, { provider: { id: provider }, model: { name }, placement }));
  assert.equal(html('remote-cli-claude', 'Opus 5.5 · ubuntu-claude', 'trigger'), 'Opus 5.5');
  assert.equal(html('remote-cli-claude', 'Opus 5.5 · ubuntu-claude', 'menu'), 'Opus 5.5');
  assert.match(html('remote-cli-claude', 'Opus 5.5 · ubuntu-claude', 'option'), /^Opus 5\.5<span data-ra-model-host="" [^>]*>ubuntu-claude<\/span>$/);
  assert.equal(html('remote-cli-codebuddy', 'Auto · Fast · macmini', 'menu'), 'Auto · Fast', 'only the last separator splits off the host');
  assert.equal(html('deepseek', 'DeepSeek · V4', 'trigger'), 'DeepSeek · V4', 'other providers keep their catalog name');
});

test('remote labels coexist with a label contribution already registered by another plugin', () => {
  const core = new SlotCore();
  const register = core.register.bind(core) as (options: Record<string, unknown>, component: unknown) => () => void;
  register({ name: 'root', children: {
    'settings.section': { kind: 'list', scope: 'root' },
    'conversation.input.model': { kind: 'single', scope: 'session' },
    'conversation.input.right': { kind: 'list', scope: 'session' },
  } }, () => null);
  const native = () => null, existing = () => null;
  register({ name: 'conversation.input.model', children: {
    'conversation.input.model.label': { kind: 'single', scope: 'session', inline: true },
  } }, native);
  register({ name: 'conversation.input.model.label', registrant: 'custom-picker' }, existing);
  const cleanups: (() => void)[] = [];
  const ctx: Client = {
    effect(factory) { cleanups.push(factory()); },
    slots: {
      inject(name, factory) { if (!(core as unknown as { spec(name: string): unknown }).spec(name)) return; const dispose = factory() as unknown; if (typeof dispose === 'function') cleanups.push(dispose as () => void); },
      register,
    },
  };
  try {
    assert.doesNotThrow(() => apply(ctx));
    assert.equal(core.entriesOfSlot('conversation.input.model')[0].component, native);
    assert.equal(core.entriesOfSlot('conversation.input.model.label')[0].component, existing);
    assert.ok(core.entriesOfSlot('settings.section').some(e => e.options.id === 'remote-agents'));
  } finally { for (const dispose of cleanups.reverse()) dispose(); }
  assert.equal(core.entries('conversation.input.model.label').length, 1, 'unloading removes only our label contribution');
});
