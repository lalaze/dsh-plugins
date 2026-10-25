import React, { useSyncExternalStore, useState } from 'react';
import { RemoteAgentsApp } from './app.js';
import { ui, useLocale } from './i18n.js';

type ClaudeSettings = React.ComponentType<{ close?: () => void }>;
let nativeSettings: ClaudeSettings | undefined;
const listeners = new Set<() => void>();
export function registerClaudeSettings(component: ClaudeSettings): void {
  nativeSettings = component; for (const listener of listeners) listener();
}
export function RemoteAgentsHub({ close }: { close?: () => void }) {
  useLocale();
  const NativeSettings = useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => nativeSettings);
  const [tab, setTab] = useState<'tasks' | 'claude'>('tasks');
  return <div data-remote-agents-hub>
    <nav aria-label={ui('Execution backend')} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '18px 24px 0' }}>
      {(['tasks', 'claude'] as const).map(value => <button type="button" key={value} aria-pressed={tab === value} onClick={() => setTab(value)} style={{ padding: '8px 14px', cursor: 'pointer', borderRadius: 8, border: '1px solid var(--dsh-border,#73737355)', color: 'inherit', background: tab === value ? 'var(--dsh-bg-secondary,#73737322)' : 'transparent', font: 'inherit' }}>{ui(value === 'tasks' ? 'CLI tasks' : 'Claude SSH')}</button>)}
    </nav>
    {tab === 'tasks' ? <RemoteAgentsApp /> : <section data-remote-native-claude style={{ padding: 24 }}>
      <p style={{ margin: '0 0 18px', opacity: 0.7, fontSize: 13 }}>{ui('Use Claude directly over SSH in DSH conversations. Existing hosts, sign-in and sessions are retained.')}</p>
      {NativeSettings && <NativeSettings close={close} />}
    </section>}
  </div>;
}
