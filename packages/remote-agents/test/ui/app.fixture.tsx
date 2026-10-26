import React from 'react';
import { createRoot } from 'react-dom/client';
import { apply } from '../../src/client/index.js';
import { createLocaleFixture } from '../../../../scripts/locale-fixture.js';
const fixtureLocale = createLocaleFixture();
const navigation: string[] = [];
const workspace = { openSession: (id: string) => navigation.push(id) };
const sessions = { list: { getSnapshot: () => ({ byId: { current: { cwd: '/srv/main-chat', retainedBy: { mainView: 1 } } } }) } };
function get(name: 'locale'): typeof fixtureLocale;
function get(name: 'uiWorkspace'): typeof workspace;
function get(name: 'sessions'): typeof sessions;
function get(name: string) { return name === 'uiWorkspace' ? workspace : name === 'sessions' ? sessions : fixtureLocale; }
const slots = new Map<string, React.FC>();
const context = {
  get,
  effect: (factory: () => unknown) => { factory(); },
  slots: { inject: (_name: string, factory: () => void) => factory(), register: (spec: Record<string, unknown>, component: React.FC) => { slots.set(`${spec.name}:${spec.id}`, component); return () => {}; } },
};
apply(context);
Object.assign(window, { fixture: { setLocale: fixtureLocale.setLocale, slots: [...slots.keys()], navigation } });
const theme = document.createElement('style');
theme.textContent = ':root{--dsh-bg:#fafbfc;--dsh-bg-secondary:#f0f2f5;--dsh-border:#dce0e6;--dsh-text:#252931;--dsh-text-secondary:#687180}body{margin:0;background:var(--dsh-bg);color:var(--dsh-text)}@media(prefers-color-scheme:dark){:root{--dsh-bg:#191b20;--dsh-bg-secondary:#21242a;--dsh-border:#353a44;--dsh-text:#e5e7eb;--dsh-text-secondary:#959da8}}';
document.head.append(theme);
const root = document.createElement('div'); document.body.append(root);
const Settings = slots.get('settings.section:remote-agents')!;
const Launcher = slots.get('sidebar.footer.action:remote-agents-sessions')!;
createRoot(root).render(<><nav aria-label="Fixture sidebar" style={{ padding: '8px 24px', maxWidth: 300 }}><Launcher /></nav><Settings /></>);
