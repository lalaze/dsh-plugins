import React from 'react';
import { createRoot } from 'react-dom/client';
import { RemoteAgentsApp } from '../../src/client/app.js';
import { apply } from '../../src/client/index.js';
import { createLocaleFixture } from '../../../../scripts/locale-fixture.js';
const fixtureLocale = createLocaleFixture();
const dictionaries = new Map<string, { en: Record<string, string>; zh: Record<string, string> }>();
const locale = { ...fixtureLocale,
  register(namespace: string, dictionary: { en: Record<string, string>; zh: Record<string, string> }) { dictionaries.set(namespace, dictionary); return fixtureLocale.register(namespace, dictionary); },
  bind(namespace: string) { return (key: string, params?: Record<string, string | number>) => {
    const dict = dictionaries.get(namespace), language = fixtureLocale.getSnapshot().active.startsWith('zh') ? 'zh' : 'en';
    const text = dict?.[language]?.[key] ?? dict?.en[key] ?? ({ 'common.cancel': 'Cancel', 'common.save': 'Save' } as Record<string, string>)[key] ?? key;
    return text.replace(/\{(\w+)\}/g, (match, name) => String(params?.[name] ?? match));
  }; },
};
const noSubscription = () => () => {};
const sessionSnapshot = { byId: {}, phase: 'ready' };
const workspaceSnapshot = { items: [] };
const directorySnapshot = { current: null, groups: [] };
const slots = new Map<string, React.FC>();
const context = {
  get: () => locale,
  sessions: { list: { getSnapshot: () => sessionSnapshot, subscribe: noSubscription }, create: async () => ({ sessionId: 'fixture-session' }) },
  workspaces: { list: { getSnapshot: () => workspaceSnapshot, subscribe: noSubscription }, create: async () => ({ workspaceId: 'fixture-workspace' }) },
  modelDirectories: { directoryFor: () => ({ store: { getSnapshot: () => directorySnapshot, subscribe: noSubscription }, load: async () => ({ groups: [] }), select: async () => {} }) },
  effect: (factory: () => unknown) => { factory(); },
  slots: { inject: (_name: string, factory: () => void) => factory(), register: (spec: Record<string, unknown>, component: React.FC) => { slots.set(`${spec.name}:${spec.id}`, component); return () => {}; } },
};
apply(context);
Object.assign(window, { fixture: { setLocale: locale.setLocale, slots: [...slots.keys()] } });
const theme = document.createElement('style');
theme.textContent = ':root{--dsh-bg:#fafbfc;--dsh-bg-secondary:#f0f2f5;--dsh-border:#dce0e6;--dsh-text:#252931;--dsh-text-secondary:#687180}body{margin:0;background:var(--dsh-bg);color:var(--dsh-text)}@media(prefers-color-scheme:dark){:root{--dsh-bg:#191b20;--dsh-bg-secondary:#21242a;--dsh-border:#353a44;--dsh-text:#e5e7eb;--dsh-text-secondary:#959da8}}';
document.head.append(theme);
const root = document.createElement('div'); document.body.append(root);
const banner = document.createElement('div'); banner.textContent = '远程任务 · 演示环境 / Demo data'; banner.style.cssText = 'font:11px system-ui;text-align:center;padding:10px;color:#9297a0;border-bottom:1px solid #333'; document.body.prepend(banner);
const Launcher = slots.get('conversation.input.left:remote-agents')!;
createRoot(root).render(<><div style={{ padding: '8px 20px', borderBottom: '1px solid var(--dsh-border)' }}><Launcher /></div><RemoteAgentsApp /></>);
