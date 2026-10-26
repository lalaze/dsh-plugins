import React from 'react';
import * as ReactDom from 'react-dom';
import * as jsx from 'react/jsx-runtime';
import * as cordis from '@deepseek-ai/cordis';
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives';
import * as store from '@deepseek-ai/dsh-client-store';
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots';
import { modelDirectory, type ModelSelection } from './model-picker.fixture.js';

type Props = {
  available: boolean; directory: typeof modelDirectory.store; load(): void;
  select(selection: ModelSelection): ReturnType<typeof modelDirectory.select>;
  t(key: string, params?: Record<string, unknown>): string;
  renderSlot(name: string, owner: unknown, options: { fallback: string }): React.ReactNode;
};
type NativePlugin = { apply(ctx: unknown): void };
/** Load the unmodified official rc.3 client bundle through its actual ModuleLoader boundary. */
export async function nativeModelFixture(modelDirectories = { directoryFor: (_id: string) => modelDirectory }) {
  let plugin: NativePlugin | undefined;
  const modules: Record<string, unknown> = { react: React, 'react-dom': ReactDom, 'react/jsx-runtime': jsx, '@deepseek-ai/cordis': cordis, '@deepseek-ai/dsh-client-ui-primitives': primitives, '@deepseek-ai/dsh-client-store': store };
  const target = window as unknown as { __ModuleLoader__?: unknown };
  const previous = target.__ModuleLoader__;
  target.__ModuleLoader__ = { load: ({ factory }: { factory: (require: (name: string) => unknown) => NativePlugin }) => {
    plugin = factory(name => { if (!(name in modules)) throw new Error(`Unexpected native dependency: ${name}`); return modules[name]; });
  } };
  try { await import('@deepseek-ai/dsh-client-ui-model-selection/client'); } finally { target.__ModuleLoader__ = previous; }
  const core = new SlotCore();
  // Fixture declares the shell contracts at the same erased boundary as JavaScript host bundles.
  const register = core.register.bind(core) as (options: Record<string, unknown>, component: unknown) => () => void;
  register({ name: 'root', children: {
    'conversation.input.model': { kind: 'single', scope: 'session' },
    'settings.section': { kind: 'list', scope: 'root' },
    'sidebar.footer.action': { kind: 'list', scope: 'root' },
  } }, () => null);
  let dictionary: Record<string, string> = {};
  const t = (key: string, params?: Record<string, unknown>) => (dictionary[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => String(params?.[name] ?? ''));
  const ctx = {
    locale: { register(_name: string, dictionaries: { zh: Record<string, string> }) { dictionary = dictionaries.zh; return () => {}; }, bind: () => t },
    effect: (factory: () => unknown) => factory(),
    // The native directory remains shared; its remote transport is simulated for deterministic tests.
    plugin() {},
    inject: (services: string[], factory: (context: unknown) => void) => { if (services.includes('slots')) factory(ctx); },
    modelDirectories, sessions: { subagentAddress: () => undefined },
    slots: { inject: (_name: string, factory: () => unknown) => factory(), register: core.register.bind(core) },
  };
  if (!plugin) throw new Error('Native client bundle did not register');
  plugin.apply(ctx);
  const entry = core.entriesOfSlot('conversation.input.model')[0];
  const Picker = entry.component as React.FC<Props>;
  return { core, Picker: () => {
    const props = (entry.inject as (id: string) => Omit<Props, 't' | 'renderSlot'>)('fixture-conversation');
    return <Picker {...props} t={t} renderSlot={(_name, _owner, options) => options.fallback} />;
  } };
}
