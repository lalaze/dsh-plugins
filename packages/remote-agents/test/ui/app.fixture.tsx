import React from 'react';
import { createRoot } from 'react-dom/client';
import { apply } from '../../src/client/index.js';
import { createLocaleFixture } from '../../../../scripts/locale-fixture.js';
import { modelDirectory, modelFixture } from './model-picker.fixture.js';
import { nativeModelFixture } from './native-model.fixture.js';
const native = await nativeModelFixture();
const fixtureLocale = createLocaleFixture();
const navigation: string[] = [];
const workspace = { openSession: (id: string) => navigation.push(id) };
const sessions = { subagentAddress: () => undefined, list: { getSnapshot: () => ({ byId: { current: { cwd: '/srv/main-chat', retainedBy: { mainView: 1 } } } }) } };
const modelDirectories = { directoryFor: () => modelDirectory };
function get(name: 'locale'): typeof fixtureLocale;
function get(name: 'uiWorkspace'): typeof workspace;
function get(name: 'sessions'): typeof sessions;
function get(name: 'modelDirectories'): typeof modelDirectories;
function get(name: string) { return name === 'uiWorkspace' ? workspace : name === 'sessions' ? sessions : name === 'modelDirectories' ? modelDirectories : fixtureLocale; }
const slots = new Map<string, React.FC>();
const specs = new Map<string, Record<string, unknown>>();
const context = {
  get,
  effect: (factory: () => unknown) => { const dispose = factory(); if (typeof dispose === 'function') cleanups.push(dispose as () => void); },
  slots: { inject: (_name: string, factory: () => void) => factory(), register: (spec: Record<string, unknown>, component: React.FC) => {
    // The real registry rejects duplicate child declarations, unlike the old Map-only fixture.
    const dispose = native.core.register(spec as Parameters<typeof native.core.register>[0], component);
    const key = `${spec.name}:${spec.id}`; slots.set(key, component); specs.set(key, spec); return dispose;
  } },
};
const cleanups: (() => void)[] = [];
apply(context);
Object.assign(window, { fixture: { setLocale: fixtureLocale.setLocale, slots: [...slots.keys()], navigation, picker: modelFixture, disablePlugin: () => { for (const cleanup of cleanups.reverse()) cleanup(); } } });
const theme = document.createElement('style');
theme.textContent = ':root{--dsw-alias-label-primary:var(--dsh-text);--dsw-alias-label-secondary:var(--dsh-text-secondary);--dsw-alias-label-tertiary:var(--dsh-text-secondary);--dsw-alias-label-caption:var(--dsh-text-secondary);--dsw-menu-surface-fill:var(--dsh-bg-secondary);--dsw-radius-lg:12px;--dsw-radius-md:6px;--dsw-alias-interactive-bg-hover:#8882;--dsw-alias-menu-group-header-fill:var(--dsh-bg-secondary);--dsw-elevation-prominent:0 8px 32px #0004;--dsh-bg:#fafbfc;--dsh-bg-secondary:#f0f2f5;--dsh-border:#dce0e6;--dsh-text:#252931;--dsh-text-secondary:#687180}body{margin:0;background:var(--dsh-bg);color:var(--dsh-text)}@media(prefers-color-scheme:dark){:root{--dsh-bg:#191b20;--dsh-bg-secondary:#21242a;--dsh-border:#353a44;--dsh-text:#e5e7eb;--dsh-text-secondary:#959da8}}';
document.head.append(theme);
const root = document.createElement('div'); document.body.append(root);
const Settings = slots.get('settings.section:remote-agents')!;
const Launcher = slots.get('sidebar.footer.action:remote-agents-sessions')!;
const Picker = native.Picker;
createRoot(root).render(<><nav aria-label="Fixture sidebar" style={{ padding: '8px 24px', maxWidth: 300 }}><Launcher /></nav><Settings /><div data-native-picker style={{ position: 'fixed', bottom: 20, right: 20, zIndex: 1 }}><Picker /></div></>);
