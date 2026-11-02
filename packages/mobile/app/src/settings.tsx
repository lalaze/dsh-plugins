/** Paired computers and notifications. */
import React, { useState } from 'react'
import { fromBase64url, type PushPreferences } from '../../src/shared/protocol.js'
import { errorText, ui } from './i18n.js'
import { ConnectionBadge } from './parts.js'
import { store, useStore, type HubState } from './store.js'

declare const __VERSION__: string

const standalone = () => matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true
const ios = () => /iPhone|iPad|iPod/.test(navigator.userAgent)

/** Subscribe this browser to one computer's notifications. A browser holds one push key at a time. */
async function enablePush(state: HubState, preferences: PushPreferences): Promise<void> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    throw new Error(ios() && !standalone() ? 'On iPhone, add this app to the Home Screen first: Share → Add to Home Screen. Then open it from there.' : 'This browser cannot show notifications.')
  }
  if (await Notification.requestPermission() !== 'granted') throw new Error('Notifications are blocked for this app in the phone’s settings.')
  const key = state.client.info?.pushKey
  if (!key) throw new Error('This phone is not paired with this machine')
  const registration = await navigator.serviceWorker.ready
  let subscription = await registration.pushManager.getSubscription()
  const current = subscription?.options.applicationServerKey ? new Uint8Array(subscription.options.applicationServerKey) : undefined
  const wanted = fromBase64url(key)
  if (subscription && (!current || current.length !== wanted.length || current.some((byte, index) => byte !== wanted[index]))) { await subscription.unsubscribe(); subscription = null }
  subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: wanted })
  const json = subscription.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } }
  await state.client.call('push.subscribe', { subscription: { endpoint: json.endpoint, keys: json.keys }, preferences })
  const previous = store.pushHubId && store.pushHubId !== state.hub.hubId ? store.hubs.get(store.pushHubId) : undefined
  if (previous) void previous.client.call('push.unsubscribe', undefined).catch(() => {})
  store.pushHubId = state.hub.hubId
}

export function SettingsScreen({ onBack, onPair }: { onBack(): void; onPair(): void }) {
  useStore()
  return <div className="screen">
    <header className="bar">
      <button className="icon" aria-label={ui('Back')} onClick={onBack}><svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M15 5l-7 7 7 7" /></svg></button>
      <div className="bar-title"><div className="title-line">{ui('Settings')}</div></div>
    </header>
    <div className="scroll form">
      <h2 className="section-title">{ui('Computers')}</h2>
      {[...store.hubs.values()].map(state => <Computer key={state.hub.hubId} state={state} />)}
      <button className="button wide" onClick={onPair}>{ui('Add a computer')}</button>
      <p className="muted small">{ui('Version {0}', { 0: __VERSION__ })}</p>
    </div>
  </div>
}

function Computer({ state }: { state: HubState }) {
  const [preferences, setPreferences] = useState<PushPreferences>({ finished: true, attention: true })
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string>()
  const on = store.pushHubId === state.hub.hubId
  const other = store.pushHubId && !on ? store.hubs.get(store.pushHubId)?.hub.name : undefined
  const grants = state.client.info?.phone?.grants
  const run = async (task: () => Promise<unknown>, done?: string) => {
    setBusy(true); setMessage(undefined)
    try { await task(); if (done) setMessage(done) } catch (failure) { setMessage(errorText(failure)) } finally { setBusy(false) }
  }
  return <div className="card">
    <ConnectionBadge state={state.client.state} error={state.client.error} name={state.hub.name} />
    {state.client.error && state.client.state !== 'online' && <div className="muted small">{ui(state.client.error)}</div>}
    {grants && <div className="muted small">{grants.control ? ui('Read and steer') : ui('Read only')}</div>}
    <div className="card-label">{ui('Notifications')}</div>
    <label className="option"><input type="checkbox" checked={preferences.finished} onChange={event => setPreferences({ ...preferences, finished: event.target.checked })} /><span>{ui('When a task finishes')}</span></label>
    <label className="option"><input type="checkbox" checked={preferences.attention} onChange={event => setPreferences({ ...preferences, attention: event.target.checked })} /><span>{ui('When a session needs you')}</span></label>
    {other && <div className="muted small">{ui('Notifications work for one computer at a time; turning them on here turns them off for {0}.', { 0: other })}</div>}
    {ios() && !standalone() && <div className="muted small">{ui('On iPhone, add this app to the Home Screen first: Share → Add to Home Screen. Then open it from there.')}</div>}
    <div className="row-actions wrap">
      <button className="button primary" disabled={busy || state.client.state !== 'online'} onClick={() => void run(() => enablePush(state, preferences), ui('Notifications are on for {0}.', { 0: state.hub.name }))}>{ui('Turn on notifications')}</button>
      {on && <button className="button" disabled={busy || state.client.state !== 'online'} onClick={() => void run(() => state.client.call('push.test', undefined))}>{ui('Send a test notification')}</button>}
      {on && <button className="button" disabled={busy} onClick={() => void run(async () => { await state.client.call('push.unsubscribe', undefined); store.pushHubId = undefined })}>{ui('Turn off notifications')}</button>}
    </div>
    {message && <div className="muted small" role="status">{message}</div>}
    <div className="row-actions">
      <button className="button danger" onClick={() => { if (confirm(ui('Remove {0} from this phone? Unpair it on the computer too.', { 0: state.hub.name }))) store.remove(state.hub.hubId) }}>{ui('Remove from this phone')}</button>
    </div>
  </div>
}
