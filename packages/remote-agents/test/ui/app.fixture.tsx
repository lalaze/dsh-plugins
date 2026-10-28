import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { apply, type Client } from '../../src/client/index.js';
import { createLocaleFixture } from '../../../../scripts/locale-fixture.js';
import { modelDirectory, modelFixture } from './model-picker.fixture.js';
import { nativeModelFixture } from './native-model.fixture.js';
import { customModelFixture } from './custom-model.fixture.js';
const modelDirectories = { directoryFor: (_id: string) => modelDirectory };
const native = await nativeModelFixture(modelDirectories);
const fixtureLocale = createLocaleFixture();
const navigation: string[] = [];
/** Add workspace outcomes and the simulated Host directory API (`uiWorkspace`). */
const flow = { picked: [] as string[], cancelled: 0, errors: [] as string[], owner: '', localPick: '/Users/me/project' as string | null, refusePick: false, picks: 0 };
const localTree: Record<string, string[]> = { '/Users/me': ['project', 'notes', '.cache'], '/Users/me/project': [], '/Users/me/notes': [], '/Users/me/.cache': [] };
const workspace = {
  openSession: (id: string) => navigation.push(id),
  pickDirectory: async () => {
    flow.picks++;
    // The browse composition refuses the chooser verb.
    if (flow.refusePick) throw new Error('directory-picker/unsupported: this host serves browse');
    return flow.localPick;
  },
  listDirectory: async (path?: string) => {
    const target = path ?? '/Users/me', names = localTree[target];
    if (!names) throw new Error('Not a readable directory');
    const crumbs = target.split('/').filter(Boolean).map((_, i, parts) => ({ name: parts[i], path: `/${parts.slice(0, i + 1).join('/')}`, hidden: false }));
    return { path: target, home: '/Users/me', crumbs: [{ name: '/', path: '/', hidden: false }, ...crumbs], truncated: false, entries: names.map(name => ({ name, path: `${target}/${name}`, hidden: name.startsWith('.') })) };
  },
};
let modelWorkspace = 'macmini';
const placementListeners = new Set<() => void>();
const subscribePlacement = (listener: () => void) => { placementListeners.add(listener); return () => { placementListeners.delete(listener); }; };
const sessions = { subagentAddress: () => undefined, list: { subscribe: subscribePlacement, getSnapshot: () => ({ byId: {
  current: { cwd: '/srv/main-chat', retainedBy: { mainView: 1 } }, 'fixture-conversation': { cwd: `/srv/${modelWorkspace}` },
} }) } };
const workspaces = { list: { subscribe: subscribePlacement, getSnapshot: () => ({ items: [{ path: `/srv/${modelWorkspace}`, workspaceId: modelWorkspace }] }) } };
function get(name: 'locale'): typeof fixtureLocale;
function get(name: 'uiWorkspace'): typeof workspace;
function get(name: 'sessions'): typeof sessions;
function get(name: 'modelDirectories'): typeof modelDirectories;
function get(name: string) { return name === 'uiWorkspace' ? workspace : name === 'sessions' ? sessions : name === 'modelDirectories' ? modelDirectories : fixtureLocale; }
const slots = new Map<string, React.FC>();
const specs = new Map<string, Record<string, unknown>>();
const context = {
  get, modelDirectories, sessions, workspaces,
  inject: (_services: string[], factory: (scoped: Client) => void) => factory(context),
  effect: (factory: () => unknown) => { const dispose = factory(); if (typeof dispose === 'function') cleanups.push(dispose as () => void); },
  slots: { inject: (_name: string, factory: () => void) => factory(), register: (spec: Record<string, unknown>, component: React.FC) => {
    // The real registry rejects duplicate child declarations, unlike the old Map-only fixture.
    const dispose = native.core.register(spec as Parameters<typeof native.core.register>[0], component);
    const key = `${spec.name}:${spec.id}`; slots.set(key, component); specs.set(key, spec); return dispose;
  } },
};
const cleanups: (() => void)[] = [];
// DSH's own native picker occupies both holes at the default priority; this plugin must shadow it.
const NativeFlow: React.FC = () => <span data-native-flow />;
for (const name of ['conversation.hero.workspace.directoryFlow', 'sidebar.workspaces.directoryFlow']) (native.core.register as (spec: Record<string, unknown>, component: unknown) => unknown)({ name }, NativeFlow);
// Some DSH builds render menu rows without model-label ids; strip them before the plugin's own observer runs.
if (new URLSearchParams(location.search).has('no-model-ids')) new MutationObserver(() => {
  for (const label of Array.from(document.querySelectorAll('[data-menu-material] [data-provider-id]'))) { label.removeAttribute('data-provider-id'); label.removeAttribute('data-model-id'); }
}).observe(document.body, { childList: true, subtree: true });
apply(context);
const flowEntry = native.core.entriesOfSlot('sidebar.workspaces.directoryFlow' as Parameters<typeof native.core.entriesOfSlot>[0])[0];
flow.owner = flowEntry?.component === NativeFlow ? 'native' : 'remote-agents';
Object.assign(window, { fixture: { setLocale: fixtureLocale.setLocale, slots: [...slots.keys()], navigation, picker: modelFixture, flow,
  customModel: customModelFixture,
  workspace: async (name: string) => {
    await fetch('/__fixture', { method: 'POST', body: JSON.stringify({ workspaceHostIds: name === 'local' ? [] : [name] }) });
    modelWorkspace = name; for (const listener of placementListeners) listener();
  },
  selectModel: (selection: Parameters<typeof modelDirectory.select>[0]) => modelDirectories.directoryFor('fixture-conversation').select(selection),
  disablePlugin: () => { for (const cleanup of cleanups.reverse()) cleanup(); },
} });
const theme = document.createElement('style');
theme.textContent = ':root{--dsw-alias-label-primary:var(--dsh-text);--dsw-alias-label-secondary:var(--dsh-text-secondary);--dsw-alias-label-tertiary:var(--dsh-text-secondary);--dsw-alias-label-caption:var(--dsh-text-secondary);--dsw-menu-surface-fill:var(--dsh-bg-secondary);--dsw-radius-lg:12px;--dsw-radius-md:6px;--dsw-alias-interactive-bg-hover:#8882;--dsw-alias-menu-group-header-fill:var(--dsh-bg-secondary);--dsw-elevation-prominent:0 8px 32px #0004;--dsw-alias-bg-layer-1:var(--dsh-bg-secondary);--dsw-alias-bg-layer-3:var(--dsh-bg-card);--dsw-alias-border-l2:var(--dsh-border);--dsh-bg-card:#fff;--dsh-bg:#fafbfc;--dsh-bg-secondary:#f0f2f5;--dsh-border:#dce0e6;--dsh-text:#252931;--dsh-text-secondary:#687180}body{margin:0;background:var(--dsh-bg);color:var(--dsh-text)}@media(prefers-color-scheme:dark){:root{--dsh-bg-card:#2a2d33;--dsh-bg:#191b20;--dsh-bg-secondary:#21242a;--dsh-border:#353a44;--dsh-text:#e5e7eb;--dsh-text-secondary:#959da8}}';
document.head.append(theme);
// Explicit themes make the preview reviewable regardless of the reviewer's OS theme.
const previewTheme = new URLSearchParams(location.search).get('theme');
if (previewTheme === 'light' || previewTheme === 'dark') {
  const palette = previewTheme === 'light'
    ? { '--dsh-bg-card': '#fff', '--dsh-bg': '#fafbfc', '--dsh-bg-secondary': '#f0f2f5', '--dsh-border': '#dce0e6', '--dsh-text': '#252931', '--dsh-text-secondary': '#687180' }
    : { '--dsh-bg-card': '#2a2d33', '--dsh-bg': '#191b20', '--dsh-bg-secondary': '#21242a', '--dsh-border': '#353a44', '--dsh-text': '#e5e7eb', '--dsh-text-secondary': '#959da8' };
  for (const [key, value] of Object.entries(palette)) document.documentElement.style.setProperty(key, value);
  document.documentElement.style.colorScheme = previewTheme;
}
const root = document.createElement('div'); document.body.append(root);
const Settings = slots.get('settings.section:remote-agents')!;
const Usage = slots.get('conversation.input.right:remote-agents-usage') as React.FC<{ sessionId?: string }>;
const Picker = native.Picker;
/** The ui-workspace owner: renders the hole's winning occupant and adopts one outcome per open. */
function AddWorkspace() {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false);
  const Flow = flowEntry?.component as React.FC<{ open: boolean; busy: boolean; onPicked(path: string): void; onCancel(): void; onError(message: string): void }> | undefined;
  if (!Flow) return null;
  // In the document flow, so it never covers the settings page under test.
  return <div data-flow-open={open} style={{ padding: '8px 24px 0' }}>
    <button type="button" data-open-flow onClick={() => setOpen(true)}>Add workspace</button>
    <Flow open={open} busy={busy}
      onPicked={path => { flow.picked.push(path); setBusy(true); setTimeout(() => { setBusy(false); setOpen(false); }, 50); }}
      onCancel={() => { flow.cancelled++; setOpen(false); }}
      onError={message => { flow.errors.push(message); setOpen(false); }} />
  </div>;
}
function Preview() {
  const settings = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.has('sessions')) settings.current?.querySelector<HTMLButtonElement>('.ra-settings-heading button')?.click();
    const frame = params.has('history') ? requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('.ra-filters button:nth-child(2)')?.click()) : undefined;
    return () => { if (frame !== undefined) cancelAnimationFrame(frame); };
  }, []);
  return <><AddWorkspace /><div ref={settings}><Settings /></div><div data-native-picker style={{ position: 'fixed', bottom: 20, right: 20, zIndex: 1 }}><Picker /></div><div data-composer-right style={{ position: 'fixed', bottom: 60, right: 20, zIndex: 1 }}><Usage sessionId="fixture-conversation" /></div></>;
}
createRoot(root).render(<Preview />);
