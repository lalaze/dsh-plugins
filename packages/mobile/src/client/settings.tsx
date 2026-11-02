import qrcode from 'qrcode-generator'
import React, { useEffect, useMemo, useState } from 'react'
import { APP_ENTRY, DEFAULT_GRANTS, type Grants, type LocalStatus, type PhoneStatus } from '../shared/protocol.js'
import { act, useStatus } from './api.js'
import { localizeError, relative, ui, useLocale } from './i18n.js'
import { styles } from './styles.js'

/** Run an action, showing its failure inline; `done` refreshes the status. */
function useRunner(done: () => Promise<void>) {
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  const run = async (key: string, task: () => Promise<unknown>) => {
    setBusy(key); setError(undefined)
    try { await task(); await done(); return true } catch (failure) { setError(localizeError(failure)); return false } finally { setBusy(undefined) }
  }
  return { busy, error, run }
}
type Run = ReturnType<typeof useRunner>['run']

/** A QR code as SVG squares, readable by phone cameras. */
function Qr({ text }: { text: string }) {
  const path = useMemo(() => {
    const code = qrcode(0, 'L')
    code.addData(text); code.make()
    const count = code.getModuleCount()
    let d = ''
    for (let row = 0; row < count; row++) for (let col = 0; col < count; col++) if (code.isDark(row, col)) d += `M${col} ${row}h1v1h-1z`
    return { d, count }
  }, [text])
  return <svg viewBox={`0 0 ${path.count} ${path.count}`} shapeRendering="crispEdges" role="img" aria-label={ui('Pair a phone')}><path d={path.d} fill="#000" /></svg>
}

function GrantChecks({ grants, onChange, disabled }: { grants: Grants; onChange(next: Grants): void; disabled?: boolean }) {
  return <div className="dsm-section">
    <label className="dsm-check"><input type="checkbox" checked={grants.view} disabled={disabled} onChange={e => onChange({ ...grants, view: e.target.checked, control: e.target.checked && grants.control })} /><span>{ui('Read sessions')}</span></label>
    <label className="dsm-check"><input type="checkbox" checked={grants.control} disabled={disabled || !grants.view} onChange={e => onChange({ ...grants, control: e.target.checked })} /><span>{ui('Steer sessions: send messages, stop tasks, answer confirmations and start sessions')}</span></label>
  </div>
}

function Setup({ status, run, busy }: { status: LocalStatus; run: Run; busy?: string }) {
  const [name, setName] = useState(status.name)
  const [relay, setRelay] = useState(status.relay.endpoint.replace(/^wss:\/\//, ''))
  const [appUrl, setAppUrl] = useState(status.appUrl)
  const [saved, setSaved] = useState(false)
  const here = `${location.origin}${APP_ENTRY}`
  const dirty = name !== status.name || relay !== status.relay.endpoint.replace(/^wss:\/\//, '') || appUrl !== status.appUrl
  const state = status.relay.state
  return <form className="dsm-card" onSubmit={async event => {
    event.preventDefault()
    if (await run('settings', () => act({ action: 'settings', name, relay, appUrl }))) { setSaved(true); setTimeout(() => setSaved(false), 1500) }
  }}>
    <h3>{ui('This machine')}</h3>
    <label className="dsm-field"><span>{ui('Name')}</span><input className="dsm-input" value={name} onChange={e => setName(e.target.value)} /></label>
    <label className="dsm-field"><span>{ui('Relay')}</span><input className="dsm-input dsm-mono" value={relay} placeholder="relay.example.com:443" onChange={e => setRelay(e.target.value)} /></label>
    <div className="dsm-inline">
      <span className="dsm-badge"><span className="dsm-dot" data-state={state === 'online' ? 'online' : state === 'connecting' ? 'connecting' : state === 'offline' ? 'offline' : 'off'} />
        {state === 'online' ? ui('Connected to the relay') : state === 'connecting' ? ui('Connecting…') : state === 'offline' ? ui('Not connected') : ui('Off')}</span>
      {!status.relay.endpoint && <span className="dsm-hint">{ui('Enter a relay address, such as relay.example.com:443.')}</span>}
    </div>
    {status.relay.error && <p className="dsm-error">{ui(status.relay.error)}</p>}
    <p className="dsm-hint">{ui('Server ID')}: <span className="dsm-mono">{status.hubId}</span> — {ui('If your relay only accepts known server IDs, allow this one there.')}</p>
    <label className="dsm-field"><span>{ui('Phone app address')}</span>
      <span className="dsm-inline">
        <input className="dsm-input dsm-mono" value={appUrl} placeholder="https://" onChange={e => setAppUrl(e.target.value)} />
        {location.protocol === 'https:' && appUrl !== here && <button type="button" className="dsm-btn" onClick={() => setAppUrl(here)}>{ui('Use this DSH')}</button>}
      </span>
    </label>
    <p className="dsm-hint">{ui('Where the phone app is hosted over HTTPS. To try it from a browser signed in to this DSH, use this DSH’s address followed by {0}.', { 0: APP_ENTRY })}</p>
    <div className="dsm-actions" style={{ justifyContent: 'flex-start' }}>
      <button type="submit" className="dsm-btn" data-kind="primary" disabled={!dirty || busy !== undefined}>{saved ? ui('Saved') : ui('Save')}</button>
    </div>
  </form>
}

function Offer({ offer, run, busy }: { offer: NonNullable<LocalStatus['offer']>; run: Run; busy?: string }) {
  const [copied, setCopied] = useState(false)
  const [, tick] = useState(0)
  useEffect(() => { const timer = setInterval(() => tick(n => n + 1), 15_000); return () => clearInterval(timer) }, [])
  return <div className="dsm-card">
    <h3>{ui('Pair a phone')}</h3>
    <div className="dsm-qr">
      <Qr text={offer.url} />
      <div className="dsm-qr-text">
        <p className="dsm-hint">{ui('Scan this code with the phone’s camera, or open the link on the phone. It works once and expires {0}.', { 0: relative(offer.expires) })}</p>
        <div className="dsm-link-box">{offer.url}</div>
        <div className="dsm-actions" style={{ justifyContent: 'flex-start' }}>
          <button type="button" className="dsm-btn" onClick={() => { void navigator.clipboard.writeText(offer.url).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }) }}>{copied ? ui('Copied') : ui('Copy link')}</button>
          <button type="button" className="dsm-btn" disabled={busy !== undefined} onClick={() => run('cancelOffer', () => act({ action: 'cancelOffer' }))}>{ui('Close')}</button>
        </div>
      </div>
    </div>
  </div>
}

function Request({ request, run, busy }: { request: LocalStatus['requests'][number]; run: Run; busy?: string }) {
  const [grants, setGrants] = useState<Grants>(DEFAULT_GRANTS)
  return <div className="dsm-card" role="group" aria-label={ui('{0} wants to pair', { 0: request.name })}>
    <h3>{ui('{0} wants to pair', { 0: request.name })}{request.platform ? <span className="dsm-hint"> · {request.platform}</span> : null}</h3>
    <p className="dsm-hint">{ui('Check that the phone shows the same code before allowing it.')}</p>
    <div className="dsm-code">{request.code.slice(0, 3)} {request.code.slice(3)}</div>
    <GrantChecks grants={grants} onChange={setGrants} />
    <div className="dsm-actions" style={{ justifyContent: 'flex-start' }}>
      <button type="button" className="dsm-btn" data-kind="primary" disabled={busy !== undefined || !grants.view} onClick={() => run(`confirm-${request.requestId}`, () => act({ action: 'confirm', requestId: request.requestId, grants }))}>{ui('Allow')}</button>
      <button type="button" className="dsm-btn" disabled={busy !== undefined} onClick={() => run(`reject-${request.requestId}`, () => act({ action: 'reject', requestId: request.requestId }))}>{ui('Reject')}</button>
    </div>
  </div>
}

function Phone({ phone, run, busy }: { phone: PhoneStatus; run: Run; busy?: string }) {
  const [confirming, setConfirming] = useState(false)
  const [sent, setSent] = useState(false)
  return <div className="dsm-row">
    <div style={{ display: 'grid', gap: 6, minWidth: 0 }}>
      <div className="dsm-inline">
        <h3>{phone.name}</h3>
        <span className="dsm-badge"><span className="dsm-dot" data-state={phone.online ? 'online' : 'off'} />{phone.online ? ui('Online') : ui('Last seen {0}', { 0: relative(phone.lastSeen) })}</span>
        {phone.push && <span className="dsm-badge">{ui('Notifications on')}</span>}
        {phone.platform && <span className="dsm-hint">{phone.platform}</span>}
      </div>
      <GrantChecks grants={phone.grants} disabled={busy !== undefined} onChange={grants => run(`grants-${phone.id}`, () => act({ action: 'grants', phoneId: phone.id, grants }))} />
      {confirming && <p className="dsm-hint">{ui('{0} will no longer reach this machine.', { 0: phone.name })}</p>}
    </div>
    <div className="dsm-actions">
      {phone.push && !confirming && <button type="button" className="dsm-btn" disabled={busy !== undefined} onClick={async () => { if (await run(`push-${phone.id}`, () => act({ action: 'testPush', phoneId: phone.id }))) { setSent(true); setTimeout(() => setSent(false), 1500) } }}>{sent ? ui('Sent') : ui('Send a test notification')}</button>}
      {confirming
        ? <>
          <button type="button" className="dsm-btn" data-kind="danger" disabled={busy !== undefined} onClick={() => run(`unpair-${phone.id}`, () => act({ action: 'unpair', phoneId: phone.id }))}>{ui('Unpair')}</button>
          <button type="button" className="dsm-btn" onClick={() => setConfirming(false)}>{ui('Cancel')}</button>
        </>
        : <button type="button" className="dsm-btn" data-kind="danger" onClick={() => setConfirming(true)}>{ui('Unpair…')}</button>}
    </div>
  </div>
}

export function MobileSettings() {
  useLocale()
  const { status, error, refresh } = useStatus()
  const { busy, error: actionError, run } = useRunner(refresh)
  return <div className="dsm dsm-settings">
    <style>{styles}</style>
    <div className="dsm-section">
      <h2>{ui('Phone access')}</h2>
      <p className="dsm-hint">{ui('Read and steer this machine’s sessions from your phone, from anywhere. The phone connects through a relay; everything it exchanges with this machine is encrypted end to end, so the relay cannot read it. Sessions always run here, with this machine’s files and sign-ins.')}</p>
    </div>
    {error && <p className="dsm-error">{error}</p>}
    {actionError && <p className="dsm-error" role="alert">{actionError}</p>}
    {status && <>
      <Setup key={`${status.name}|${status.relay.endpoint}|${status.appUrl}`} status={status} run={run} busy={busy} />
      {status.requests.map(request => <Request key={request.requestId} request={request} run={run} busy={busy} />)}
      {status.offer
        ? <Offer offer={status.offer} run={run} busy={busy} />
        : <div><button type="button" className="dsm-btn" data-kind="primary" disabled={busy !== undefined || !status.relay.endpoint || !status.appUrl} onClick={() => run('offer', () => act({ action: 'offer' }))}>{ui('Pair a phone')}</button></div>}
      <div className="dsm-section">
        <h3>{ui('Paired phones')}</h3>
        {status.phones.length === 0
          ? <p className="dsm-hint">{ui('No phones yet.')}</p>
          : <div>{status.phones.map(phone => <Phone key={phone.id} phone={phone} run={run} busy={busy} />)}</div>}
      </div>
    </>}
  </div>
}
