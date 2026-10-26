import React, { useState } from 'react';
import type { Dashboard } from '../domain.js';
import { api } from './api.js';
import { localizeError, ui } from './i18n.js';
import { SshHostPicker } from './ssh-host-picker.js';

/** SSH configuration for the native model routes and delegation tools. */
export function HostManager({ dashboard, update }: { dashboard: Dashboard; update(next: Dashboard): void }) {
  const [label, setLabel] = useState(''), [connection, setConnection] = useState('');
  const [busy, setBusy] = useState(''), [error, setError] = useState('');
  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key); setError('');
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(''); }
  };
  const hosts = dashboard.hosts;
  return <div className="ra-page ra-hosts">
    <h2>{ui('Hosts')}</h2>
    <p className="ra-muted">{ui('Save a machine to discover its models automatically. No project registration is needed.')}</p>
    {error && <div className="ra-banner" data-tone="error" role="alert">{localizeError(error)}</div>}
    {hosts.length > 0 && <ul className="ra-host-list" aria-label={ui('Saved hosts')}>{hosts.map(host => {
      const agents = dashboard.agents.filter(a => a.hostId === host.id).length;
      return <li className="ra-host-row" key={host.id}>
        <div className="ra-host-name"><strong>{host.label}</strong><span className="ra-mono ra-muted">{host.connection}</span>
          <span className="ra-muted">{host.modelCount === undefined ? ui('Models have not been detected yet.') : ui('{count} models in the DSH picker', { count: host.modelCount })}</span>
          {host.modelCount === 0 && <span className="ra-muted">{ui('Install and sign in to a CLI on this machine, then refresh models.')}</span>}
          {(host.modelError || host.error) && <span className="ra-host-error">{localizeError(host.modelError ?? host.error ?? '')}</span>}
          {host.providerErrors?.map(p => <span key={p.label} className="ra-host-error">{p.label}: {localizeError(p.error)}</span>)}
        </div>
        <span className="ra-badge" data-status={host.status}>{ui(host.status)}</span>
        <button type="button" disabled={!!busy} onClick={() => void run(`discover:${host.id}`, async () => update(await api<Dashboard>('discoverHost', { hostId: host.id })))}>{ui(busy === `discover:${host.id}` ? 'Detecting models…' : 'Refresh models')}</button>
        <button type="button" className="ra-danger" disabled={!!busy || agents > 0} title={agents ? ui('Delete this host’s agents, including archived ones, before removing it') : undefined}
          onClick={() => void run(`remove:${host.id}`, async () => update(await api<Dashboard>('removeHost', { hostId: host.id })))}>{ui('Remove')}</button>
      </li>;
    })}</ul>}
    <form className="ra-host-form" onSubmit={event => { event.preventDefault(); void run('add', async () => {
      const next = await api<Dashboard>('addHost', { host: { label, connection } });
      update(next); setLabel(''); setConnection('');
    }); }}>
      <h3>{ui('Add host')}</h3>
      <SshHostPicker hosts={hosts} connection={connection} disabled={!!busy} select={host => { setLabel(host.alias.slice(0, 100)); setConnection(host.connection); }} />
      <div className="ra-grid">
        <label className="ra-field">{ui('Host name')}<input aria-label={ui('Host name')} required maxLength={100} value={label} onChange={event => setLabel(event.target.value)} placeholder="build-box" /></label>
        <label className="ra-field">{ui('Connection')}<input aria-label={ui('Connection')} required value={connection} onChange={event => setConnection(event.target.value)} placeholder="ssh://user@build-box:22" autoComplete="off" /></label>
      </div>
      <div className="ra-actions"><button className="ra-primary" disabled={!!busy || !label.trim() || !connection.trim()}>{ui(busy === 'add' ? 'Saving and detecting models…' : 'Save host')}</button></div>
      <p className="ra-foot">{ui('SSH uses the DSH server’s keys and SSH config: BatchMode, verified host keys, aliases and ProxyJump.')}</p>
    </form>
  </div>;
}
