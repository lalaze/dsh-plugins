import React, { useState } from 'react';
import { enabledProvidersOf, PROVIDER_LABELS, type Dashboard, type Host } from '../domain.js';
import { api } from './api.js';
import { localizeError, ui } from './i18n.js';
import { SshHostPicker } from './ssh-host-picker.js';

function CliChoices({ value, change, disabled }: { value: string[]; change(next: string[]): void; disabled: boolean }) {
  return <fieldset className="ra-cli-options" disabled={disabled}><legend>{ui('Enabled CLIs')}</legend>{Object.entries(PROVIDER_LABELS).map(([id, label]) => <label key={id}>
    <input type="checkbox" value={id} checked={value.includes(id)} onChange={e => change(e.target.checked ? [...value, id] : value.filter(p => p !== id))} /><span>{label}</span>
  </label>)}</fieldset>;
}
function HostProviders({ host, busy, apply }: { host: Host; busy: boolean; apply(providers: string[]): void }) {
  const enabled = enabledProvidersOf(host), [selection, setSelection] = useState(enabled);
  const changed = selection.length !== enabled.length || selection.some(id => !enabled.includes(id));
  return <div className="ra-cli-settings"><CliChoices value={selection} change={setSelection} disabled={busy} /><div className="ra-actions">
    <span className="ra-muted">{ui('Only selected CLIs are detected and shown in the model picker.')}</span>
    <button type="button" disabled={busy || !changed} onClick={() => apply(selection)}>{ui('Apply selection')}</button>
  </div></div>;
}

/** SSH configuration for the native model routes and delegation tools. */
export function HostManager({ dashboard, update }: { dashboard: Dashboard; update(next: Dashboard): void }) {
  const [label, setLabel] = useState(''), [connection, setConnection] = useState('');
  const [selection, setSelection] = useState<string[]>([]);
  const [busy, setBusy] = useState(''), [error, setError] = useState('');
  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key); setError('');
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(''); }
  };
  const hosts = dashboard.hosts;
  return <div className="ra-page ra-hosts">
    <h2>{ui('Hosts')}</h2>
    <p className="ra-muted">{ui('Choose which CLIs to enable on each machine. No project registration is needed.')}</p>
    {error && <div className="ra-banner" data-tone="error" role="alert">{localizeError(error)}</div>}
    {hosts.length > 0 && <ul className="ra-host-list" aria-label={ui('Saved hosts')}>{hosts.map(host => {
      const agents = dashboard.agents.filter(a => a.hostId === host.id).length;
      return <li className="ra-host-row ra-host-with-clis" key={host.id}><div className="ra-host-top">
        <div className="ra-host-name"><strong>{host.label}</strong><span className="ra-mono ra-muted">{host.connection}</span>
          <span className="ra-muted">{host.modelCount === undefined ? ui('Models have not been detected yet.') : ui('{count} models in the DSH picker', { count: host.modelCount })}</span>
          {host.modelCount === 0 && <span className="ra-muted">{ui(enabledProvidersOf(host).length ? 'Install and sign in to a CLI on this machine, then refresh models.' : 'No CLIs enabled. Select the ones you want to use.')}</span>}
          {(host.modelError || host.error) && <span className="ra-host-error">{localizeError(host.modelError ?? host.error ?? '')}</span>}
          {host.providerErrors?.map(p => <span key={p.label} className="ra-host-error">{p.label}: {localizeError(p.error)}</span>)}
        </div>
        <span className="ra-badge" data-status={host.status}>{ui(host.status)}</span>
        <button type="button" disabled={!!busy || !enabledProvidersOf(host).length} onClick={() => void run(`discover:${host.id}`, async () => update(await api<Dashboard>('discoverHost', { hostId: host.id })))}>{ui(busy === `discover:${host.id}` ? 'Detecting models…' : 'Refresh models')}</button>
        <button type="button" className="ra-danger" disabled={!!busy || agents > 0} title={agents ? ui('Delete this host’s agents, including archived ones, before removing it') : undefined}
          onClick={() => void run(`remove:${host.id}`, async () => update(await api<Dashboard>('removeHost', { hostId: host.id })))}>{ui('Remove')}</button></div>
        <HostProviders key={enabledProvidersOf(host).join(',')} host={host} busy={!!busy} apply={providers => void run(`providers:${host.id}`, async () => update(await api<Dashboard>('setHostProviders', { hostId: host.id, providers })))} />
      </li>;
    })}</ul>}
    <form className="ra-host-form" onSubmit={event => { event.preventDefault(); void run('add', async () => {
      const next = await api<Dashboard>('addHost', { host: { label, connection, enabledProviders: selection } });
      update(next); setLabel(''); setConnection(''); setSelection([]);
    }); }}>
      <h3>{ui('Add host')}</h3>
      <SshHostPicker hosts={hosts} connection={connection} disabled={!!busy} select={host => { setLabel(host.alias.slice(0, 100)); setConnection(host.connection); }} />
      <div className="ra-grid">
        <label className="ra-field">{ui('Host name')}<input aria-label={ui('Host name')} required maxLength={100} value={label} onChange={event => setLabel(event.target.value)} placeholder="build-box" /></label>
        <label className="ra-field">{ui('Connection')}<input aria-label={ui('Connection')} required value={connection} onChange={event => setConnection(event.target.value)} placeholder="ssh://user@build-box:22" autoComplete="off" /></label>
      </div>
      <CliChoices value={selection} change={setSelection} disabled={!!busy} />
      <div className="ra-actions"><button className="ra-primary" disabled={!!busy || !label.trim() || !connection.trim()}>{ui(busy === 'add' ? 'Saving and detecting models…' : 'Save host')}</button></div>
      <p className="ra-foot">{ui('SSH uses the DSH server’s keys and SSH config: BatchMode, verified host keys, aliases and ProxyJump.')}</p>
    </form>
  </div>;
}
