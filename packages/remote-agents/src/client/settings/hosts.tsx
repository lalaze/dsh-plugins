import React, { useId, useState } from 'react';
import { enabledProvidersOf, PROVIDER_LABELS, type Dashboard, type Host } from '@dsh-plugins/remote-core/domain.js';
import { api } from '../api.js';
import { localizeError, ui } from '../i18n.js';
import { ActionsMenu, Chevron } from './menu.js';
import { SshHostPicker } from './ssh-host-picker.js';

function CliChoices({ value, change, disabled, inline = false }: { value: string[]; change(next: string[]): void; disabled: boolean; inline?: boolean }) {
  return <fieldset className="ra-cli-options" disabled={disabled} aria-label={inline ? ui('Enabled CLIs') : undefined}>
    {inline ? <span className="ra-cli-label" aria-hidden="true">{ui('Enabled CLIs')}</span> : <legend>{ui('Enabled CLIs')}</legend>}{Object.entries(PROVIDER_LABELS).map(([id, label]) => <label key={id}>
    <input type="checkbox" value={id} checked={value.includes(id)} onChange={e => change(e.target.checked ? [...value, id] : value.filter(p => p !== id))} /><span>{label}</span>
  </label>)}</fieldset>;
}
function HostProviders({ host, busy, apply }: { host: Host; busy: boolean; apply(providers: string[]): void }) {
  const enabled = enabledProvidersOf(host), [selection, setSelection] = useState(enabled);
  const changed = selection.length !== enabled.length || selection.some(id => !enabled.includes(id));
  // The apply row appears only for an unsaved selection, so an unchanged machine stays one line.
  return <div className="ra-cli-settings"><CliChoices value={selection} change={setSelection} disabled={busy} inline />{changed && <div className="ra-actions">
    <span className="ra-muted">{ui('Only selected CLIs are detected and shown in the model picker.')}</span>
    <button type="button" disabled={busy} onClick={() => apply(selection)}>{ui('Apply selection')}</button>
  </div>}</div>;
}

type Run = (key: string, action: () => Promise<void>) => void;

/** One saved machine: a compact header always shown, its sharing and CLI settings behind a disclosure. */
function HostRow({ host, agents, busy, run, update, removing, setRemoving, remove }: {
  host: Host; agents: number; busy: string; run: Run; update(next: Dashboard): void;
  removing: string; setRemoving(id: string): void; remove(hostId: string, deleteAgents?: boolean, everywhere?: boolean): void;
}) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const enabled = enabledProvidersOf(host);
  const cliList = enabled.map(id => PROVIDER_LABELS[id] ?? id).join(', ');
  return <li className="ra-host-row ra-host-with-clis">
    <div className="ra-host-top">
      <button type="button" className="ra-host-expand" aria-expanded={open} aria-controls={bodyId} aria-label={ui(open ? 'Hide machine settings' : 'Show machine settings')} onClick={() => setOpen(value => !value)}><Chevron open={open} /></button>
      <div className="ra-host-name">
        <div className="ra-host-title"><strong>{host.label}</strong><span className="ra-mono ra-muted">{host.connection}</span><span className="ra-badge" data-status={host.status}>{ui(host.status)}</span>{host.share && <span className="ra-badge ra-share-badge">{ui('Shared')}</span>}</div>
        <span className="ra-muted">{host.modelCount === undefined ? ui('Models have not been detected yet.') : ui('{count} models in the DSH picker', { count: host.modelCount })}{!open && ` · ${enabled.length ? ui('CLIs: {list}', { list: cliList }) : ui('No CLIs enabled')}`}</span>
        {host.modelCount === 0 && <span className="ra-muted">{ui(enabled.length ? 'Install and sign in to a CLI on this machine, then refresh models.' : 'No CLIs enabled. Select the ones you want to use.')}</span>}
        {(host.modelError || host.error) && <span className="ra-host-error">{localizeError(host.modelError ?? host.error ?? '')}</span>}
        {host.providerErrors?.map(p => <span key={p.label} className="ra-host-error">{p.label}: {localizeError(p.error)}</span>)}
      </div>
      <ActionsMenu label={ui('Machine actions')}>{close => <>
        <button type="button" role="menuitem" disabled={!!busy} onClick={() => { close(); void run(`connect:${host.id}`, async () => update(await api<Dashboard>('connect', { hostId: host.id }))); }}>{ui('Test connection')}</button>
        <button type="button" role="menuitem" disabled={!!busy || !enabled.length} onClick={() => { close(); void run(`discover:${host.id}`, async () => update(await api<Dashboard>('discoverHost', { hostId: host.id }))); }}>{ui(busy === `discover:${host.id}` ? 'Detecting models…' : 'Refresh models')}</button>
        <button type="button" role="menuitem" className="ra-danger" disabled={!!busy} onClick={() => { close(); agents ? setRemoving(host.id) : remove(host.id); }}>{ui('Remove')}</button>
      </>}</ActionsMenu>
    </div>
    {removing === host.id && <div className="ra-banner ra-remove-confirm" role="alert">
      {host.share ? <><span>{ui('Remove {host} from this DSH? Its {count} sessions can stay on the machine for the other DSH instances, with their CLIs running, or be deleted in every DSH, which stops their CLIs.', { host: host.label, count: agents })}</span>
        <div className="ra-actions"><button type="button" disabled={!!busy} onClick={() => setRemoving('')}>{ui('Cancel')}</button>
          <button type="button" disabled={!!busy} onClick={() => remove(host.id, true)}>{ui('Remove from this DSH only')}</button>
          <button type="button" className="ra-danger" disabled={!!busy} onClick={() => remove(host.id, true, true)}>{ui('Delete sessions everywhere')}</button></div></>
      : <><span>{ui('Remove {host} and permanently delete its {count} saved sessions, including archived sessions, and their output? Attached CLI processes will be stopped.', { host: host.label, count: agents })}</span>
        <div className="ra-actions"><button type="button" disabled={!!busy} onClick={() => setRemoving('')}>{ui('Cancel')}</button>
          <button type="button" className="ra-danger" disabled={!!busy} onClick={() => remove(host.id, true)}>{ui('Remove host and sessions')}</button></div></>}
    </div>}
    {open && <div className="ra-host-settings" id={bodyId}>
      <div className="ra-share-setting"><label title={ui(host.share ? 'Every DSH connected to this SSH account sees its history, running tasks and remote workspaces, and can continue them.' : 'Sessions started here stay in this DSH, and sessions from other DSH instances are not shown.')}><input type="checkbox" checked={host.share} disabled={!!busy} onChange={event => { const share = event.target.checked; void run(`share:${host.id}`, async () => update(await api<Dashboard>('setHostSharing', { hostId: host.id, share }))); }} />
        <span>{ui('Share sessions and workspaces with other DSH instances')}</span></label>
        {host.share && host.shareError && <span className="ra-host-error">{localizeError(host.shareError)}</span>}
      </div>
      <HostProviders key={enabled.join(',')} host={host} busy={!!busy} apply={providers => void run(`providers:${host.id}`, async () => update(await api<Dashboard>('setHostProviders', { hostId: host.id, providers })))} />
    </div>}
  </li>;
}

/** SSH configuration for the native model routes and delegation tools. */
export function HostManager({ dashboard, update }: { dashboard: Dashboard; update(next: Dashboard): void }) {
  const [label, setLabel] = useState(''), [connection, setConnection] = useState('');
  const [selection, setSelection] = useState<string[]>([]);
  const [busy, setBusy] = useState(''), [error, setError] = useState('');
  const [removing, setRemoving] = useState('');
  const hosts = dashboard.hosts;
  // The add form stays out of the way once machines exist; an empty list always shows it.
  const [adding, setAdding] = useState(false);
  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key); setError('');
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(''); }
  };
  const remove = (hostId: string, deleteAgents = false, everywhere = false) => void run(`remove:${hostId}`, async () => {
    update(await api<Dashboard>('removeHost', { hostId, deleteAgents, everywhere })); setRemoving('');
  });
  return <div className="ra-page ra-hosts">
    <h2>{ui('Hosts')}</h2>
    <p className="ra-muted">{ui('Choose which CLIs to enable on each machine. No project registration is needed.')}</p>
    {error && <div className="ra-banner" data-tone="error" role="alert">{localizeError(error)}</div>}
    {hosts.length > 0 && <ul className="ra-host-list" aria-label={ui('Saved hosts')}>{hosts.map(host =>
      <HostRow key={host.id} host={host} agents={dashboard.agents.filter(a => a.hostId === host.id).length} busy={busy} run={run} update={update} removing={removing} setRemoving={setRemoving} remove={remove} />)}</ul>}
    {!adding && hosts.length > 0 && <div className="ra-actions ra-add-host"><button type="button" className="ra-add-host-toggle" disabled={!!busy} onClick={() => setAdding(true)}>{ui('Add a machine')}</button></div>}
    {(adding || hosts.length === 0) && <form className="ra-host-form" onSubmit={event => { event.preventDefault(); void run('add', async () => {
      const next = await api<Dashboard>('addHost', { host: { label, connection, enabledProviders: selection } });
      update(next); setLabel(''); setConnection(''); setSelection([]); setAdding(false);
    }); }}>
      <h3>{ui('Add host')}</h3>
      <SshHostPicker hosts={hosts} connection={connection} disabled={!!busy} select={host => { setLabel(host.alias.slice(0, 100)); setConnection(host.connection); }} />
      <div className="ra-grid">
        <label className="ra-field">{ui('Host name')}<input aria-label={ui('Host name')} required maxLength={100} value={label} onChange={event => setLabel(event.target.value)} placeholder="build-box" /></label>
        <label className="ra-field">{ui('Connection')}<input aria-label={ui('Connection')} required value={connection} onChange={event => setConnection(event.target.value)} placeholder="ssh://user@build-box:22" autoComplete="off" /></label>
      </div>
      <CliChoices value={selection} change={setSelection} disabled={!!busy} />
      <div className="ra-actions">{hosts.length > 0 && <button type="button" disabled={!!busy} onClick={() => { setAdding(false); setLabel(''); setConnection(''); setSelection([]); }}>{ui('Cancel')}</button>}<button className="ra-primary" disabled={!!busy || !label.trim() || !connection.trim()}>{ui(busy === 'add' ? 'Saving and detecting models…' : 'Save host')}</button></div>
      <p className="ra-foot">{ui('SSH uses the DSH server’s keys and SSH config: BatchMode, verified host keys, aliases and ProxyJump.')}</p>
    </form>}
  </div>;
}
