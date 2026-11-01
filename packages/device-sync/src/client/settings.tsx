import React, { useState } from 'react'
import type { Grants, LocalStatus, PairingStatus, PeerStatus } from '../shared/protocol.js'
import { act, useStatus } from './api.js'
import { ago, localizeError, ui, useLocale } from './i18n.js'
import { styles } from './styles.js'

const CONNECTION: Record<PeerStatus['connection'], string> = { online: 'Online', offline: 'Offline', paused: 'Paused', unpaired: 'Unpaired' }

/** Run an action, showing its failure inline; `done` refreshes the status. */
function useRunner(done: () => Promise<void>) {
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  const run = async (key: string, task: () => Promise<unknown>) => {
    setBusy(key); setError(undefined)
    try { await task(); await done() } catch (failure) { setError(localizeError(failure)) } finally { setBusy(undefined) }
  }
  return { busy, error, run }
}

function GrantChecks({ grants, onChange, disabled, peer }: { grants: Grants; onChange(next: Grants): void; disabled?: boolean; peer: string }) {
  return <div className="dsy-section">
    <label className="dsy-check"><input type="checkbox" checked={grants.history} disabled={disabled} onChange={e => onChange({ ...grants, history: e.target.checked })} />
      <span>{ui('Share this machine’s workspaces, groups and conversations with {0}', { 0: peer })}</span></label>
    <label className="dsy-check"><input type="checkbox" checked={grants.command} disabled={disabled} onChange={e => onChange({ ...grants, command: e.target.checked })} />
      <span>{ui('Allow {0} to steer this machine’s sessions: send messages, stop tasks and answer confirmations. They run here, with this machine’s files and sign-ins.', { 0: peer })}</span></label>
  </div>
}

function Pairing({ pairing, run, busy }: { pairing: PairingStatus; run: ReturnType<typeof useRunner>['run']; busy?: string }) {
  const [grants, setGrants] = useState<Grants>(pairing.grants)
  const incoming = pairing.direction === 'incoming'
  return <div className="dsy-card" role="group" aria-label={ui('Pairing with {0}', { 0: pairing.name })}>
    <h3>{incoming ? ui('{0} wants to pair with this machine', { 0: pairing.name }) : ui('Pairing with {0}', { 0: pairing.name })}</h3>
    <p className="dsy-hint">{ui('Check that both machines show the same code before confirming.')}</p>
    <div className="dsy-code" aria-label={ui('Pairing code')}>{pairing.code.slice(0, 3)} {pairing.code.slice(3)}</div>
    <p className="dsy-hint dsy-mono">{pairing.endpoint}</p>
    {pairing.confirmedHere
      ? <p className="dsy-hint">{ui('Confirmed here. Waiting for confirmation on {0}…', { 0: pairing.name })}</p>
      : <>
        <GrantChecks grants={grants} onChange={setGrants} peer={pairing.name} />
        <div className="dsy-actions" style={{ justifyContent: 'flex-start' }}>
          <button type="button" className="dsy-btn" data-kind="primary" disabled={busy !== undefined}
            onClick={() => run(`confirm-${pairing.pairingId}`, () => act({ action: 'confirmPairing', pairingId: pairing.pairingId, grants }))}>{ui('The codes match, pair')}</button>
          <button type="button" className="dsy-btn" disabled={busy !== undefined}
            onClick={() => run(`reject-${pairing.pairingId}`, () => act({ action: 'rejectPairing', pairingId: pairing.pairingId }))}>{ui('Reject')}</button>
        </div>
      </>}
  </div>
}

function Peer({ peer, run, busy }: { peer: PeerStatus; run: ReturnType<typeof useRunner>['run']; busy?: string }) {
  const [confirmUnpair, setConfirmUnpair] = useState(false)
  const [forget, setForget] = useState(false)
  const unpaired = peer.connection === 'unpaired'
  return <div className="dsy-card" role="group" aria-label={peer.name}>
    <div className="dsy-row" style={{ padding: 0, border: 0 }}>
      <div>
        <h3>{peer.name}</h3>
        <p className="dsy-hint"><span className="dsy-mono">{peer.endpoint}</span> · {ui('Device {0}', { 0: peer.deviceId.slice(0, 8) })}</p>
      </div>
      <span className="dsy-badge"><span className="dsy-dot" data-state={peer.connection} />{ui(CONNECTION[peer.connection])}</span>
    </div>
    <p className="dsy-hint">
      {ui('Last synced {0}', { 0: ago(peer.lastSyncAt) })}
      {peer.pending > 0 && <> · {ui('{0} waiting to sync', { 0: peer.pending })}</>}
      {' · '}{peer.grantsFromPeer.command ? ui('{0} allows remote control from here', { 0: peer.name }) : ui('{0} does not allow remote control from here', { 0: peer.name })}
    </p>
    {peer.lastError && <p className="dsy-error" role="status">{ui(peer.lastError)}</p>}
    {!unpaired && <GrantChecks grants={peer.grantsToPeer} peer={peer.name} disabled={busy !== undefined}
      onChange={grants => run(`grants-${peer.deviceId}`, () => act({ action: 'setGrants', deviceId: peer.deviceId, grants }))} />}
    {unpaired && <p className="dsy-hint">{ui('No longer paired. The history copied from {0} stays readable here until you remove it.', { 0: peer.name })}</p>}
    <div className="dsy-actions" style={{ justifyContent: 'flex-start' }}>
      {!unpaired && <button type="button" className="dsy-btn" disabled={busy !== undefined} onClick={() => run(`retry-${peer.deviceId}`, () => act({ action: 'retry', deviceId: peer.deviceId }))}>{ui('Sync now')}</button>}
      {!unpaired && <button type="button" className="dsy-btn" disabled={busy !== undefined} onClick={() => run(`pause-${peer.deviceId}`, () => act({ action: 'pause', deviceId: peer.deviceId, paused: peer.connection !== 'paused' }))}>
        {peer.connection === 'paused' ? ui('Resume sync') : ui('Pause sync')}</button>}
      {!confirmUnpair && <button type="button" className="dsy-btn" data-kind="danger" onClick={() => setConfirmUnpair(true)}>{unpaired ? ui('Remove…') : ui('Unpair…')}</button>}
    </div>
    {confirmUnpair && <div className="dsy-section">
      {!unpaired && <p className="dsy-hint">{ui('{0} will no longer be able to sync with this machine or send it requests.', { 0: peer.name })}</p>}
      <label className="dsy-check"><input type="checkbox" checked={forget || unpaired} disabled={unpaired} onChange={e => setForget(e.target.checked)} />
        <span>{ui('Also remove the history copied from {0} on this machine', { 0: peer.name })}</span></label>
      <div className="dsy-actions" style={{ justifyContent: 'flex-start' }}>
        <button type="button" className="dsy-btn" data-kind="danger" disabled={busy !== undefined}
          onClick={() => run(`unpair-${peer.deviceId}`, () => act({ action: 'unpair', deviceId: peer.deviceId, forgetHistory: forget || unpaired }))}>{unpaired ? ui('Remove') : ui('Unpair')}</button>
        <button type="button" className="dsy-btn" onClick={() => setConfirmUnpair(false)}>{ui('Cancel')}</button>
      </div>
    </div>}
  </div>
}

function Conflicts({ status, run, busy }: { status: LocalStatus; run: ReturnType<typeof useRunner>['run']; busy?: string }) {
  const conflicts = status.groups.conflicts
  if (conflicts.length === 0) return null
  const show = (value: unknown) => typeof value === 'string' ? value : typeof value === 'boolean' ? (value ? ui('Yes') : ui('No')) : JSON.stringify(value)
  return <section className="dsy-section" aria-label={ui('Group conflicts')}>
    <h3>{ui('Group conflicts')}</h3>
    <p className="dsy-hint">{ui('Both machines changed the same thing before they synced. Both values are kept until you pick one.')}</p>
    {conflicts.map(conflict => <div key={conflict.key} className="dsy-row">
      <div><div>{ui(conflict.label)}</div>
        <p className="dsy-hint">{ui('In use: {0} (from {1}) · Other: {2} (from {3})', { 0: show(conflict.kept), 1: conflict.keptFrom, 2: show(conflict.other), 3: conflict.otherFrom })}</p></div>
      <div className="dsy-actions">
        <button type="button" className="dsy-btn" disabled={busy !== undefined} onClick={() => run(`keep-${conflict.key}`, () => act({ action: 'resolveConflict', key: conflict.key, useOther: false }))}>{ui('Keep {0}', { 0: show(conflict.kept) })}</button>
        <button type="button" className="dsy-btn" disabled={busy !== undefined} onClick={() => run(`other-${conflict.key}`, () => act({ action: 'resolveConflict', key: conflict.key, useOther: true }))}>{ui('Use {0}', { 0: show(conflict.other) })}</button>
      </div>
    </div>)}
  </section>
}

/** Settings → Device sync. */
export function SyncSettings() {
  useLocale()
  const { status, error: loadError, refresh } = useStatus()
  const { busy, error, run } = useRunner(refresh)
  const [endpoint, setEndpoint] = useState('')
  const [grants, setGrants] = useState<Grants>({ history: true, command: false })
  const [name, setName] = useState<string>()
  return <section className="dsy dsy-settings" aria-label={ui('Device sync')}><style>{styles}</style>
    <header>
      <h2>{ui('Device sync')}</h2>
      <p className="dsy-hint">{ui('Pair this machine with another one over Tailscale to share workspace groups and conversations, and to steer each other’s sessions. Each session runs only on the machine that owns it.')}</p>
    </header>
    {loadError && <p className="dsy-error" role="alert">{loadError}</p>}
    {error && <p className="dsy-error" role="alert">{error}</p>}
    {status && <>
      <section className="dsy-section">
        <div className="dsy-row">
          <div>
            <div>{ui('This machine')}</div>
            <p className="dsy-hint">{status.listener.address
              ? ui('Reachable at {0} · Device {1}', { 0: status.listener.address, 1: status.device.deviceId.slice(0, 8) })
              : <span className="dsy-warn">{ui(status.listener.error ?? 'Not reachable by paired devices yet.')}</span>}</p>
          </div>
          <div className="dsy-actions">
            <input className="dsy-input" aria-label={ui('Name of this machine')} value={name ?? status.device.name} onChange={e => setName(e.target.value)} />
            {name !== undefined && name !== status.device.name && <button type="button" className="dsy-btn" disabled={busy !== undefined}
              onClick={() => run('rename', async () => { await act({ action: 'rename', name }); setName(undefined) })}>{ui('Save')}</button>}
          </div>
        </div>
        <div className="dsy-row">
          <div><div>{ui('Remote sessions')}</div><p className="dsy-hint">{ui('To watch and steer a paired machine’s sessions, open its own DSH Web over Tailscale. Its synced history stays readable here while it is offline.')}</p></div>
        </div>
      </section>

      <section className="dsy-section" aria-label={ui('Pair a machine')}>
        <h3>{ui('Pair a machine')}</h3>
        <p className="dsy-hint">{ui('Enter the other machine’s Tailscale address and port, as shown under “This machine” there, for example {0}.', { 0: 'mac-mini:47630' })}</p>
        <form className="dsy-pair" onSubmit={event => { event.preventDefault(); void run('pair', async () => { await act({ action: 'pair', endpoint, grants }); setEndpoint('') }) }}>
          <input className="dsy-input dsy-mono" aria-label={ui('Address of the other machine')} placeholder="100.x.y.z:47630" value={endpoint} onChange={e => setEndpoint(e.target.value)} />
          <button type="submit" className="dsy-btn" data-kind="primary" disabled={!endpoint.trim() || busy !== undefined}>{busy === 'pair' ? ui('Connecting…') : ui('Pair')}</button>
        </form>
        <GrantChecks grants={grants} onChange={setGrants} peer={ui('the other machine')} />
      </section>

      {status.pairings.map(pairing => <Pairing key={pairing.pairingId} pairing={pairing} run={run} busy={busy} />)}

      {status.peers.length > 0 && <section className="dsy-section" aria-label={ui('Paired machines')}>
        <h3>{ui('Paired machines')}</h3>
        {status.peers.map(peer => <Peer key={peer.deviceId} peer={peer} run={run} busy={busy} />)}
      </section>}

      <Conflicts status={status} run={run} busy={busy} />

      <section className="dsy-section">
        <h3>{ui('Groups')}</h3>
        <p className="dsy-hint">{status.groups.tagsPlugin
          ? ui('Groups come from Workspace Tags and follow its edits on both machines.')
          : ui('Install Workspace Tags 0.1.10 or later to see shared groups in the sidebar.')}</p>
        {status.backups.length > 0 && <p className="dsy-hint">{ui('{0} backups were made before first syncs, in this plugin’s storage folder under “backups”.', { 0: status.backups.length })}</p>}
      </section>
    </>}
  </section>
}
