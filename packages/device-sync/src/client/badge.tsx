import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { LocalStatus } from '../shared/protocol.js'
import { useStatus } from './api.js'
import { ui, useLocale } from './i18n.js'
import { onSessionOpened } from './navigation.js'
import { SyncSettings } from './settings.js'
import { styles } from './styles.js'

const CONNECTION: Record<string, string> = { online: 'Online', offline: 'Offline', paused: 'Paused', unpaired: 'Unpaired' }

/** One word for the badge: the worst state among paired machines. */
function summary(status: LocalStatus): { state: string; text: string; problem?: string } | undefined {
  const peers = status.peers.filter(peer => peer.connection !== 'unpaired')
  if (peers.length === 0 && status.pairings.length === 0) return undefined
  const problem = status.listener.error ?? peers.find(peer => peer.lastError)?.lastError
  if (peers.length === 0) return { state: 'waiting', text: ui('Pairing…') }
  if (peers.length === 1) {
    const [peer] = peers
    return { state: problem ? 'waiting' : peer.connection, text: `${peer.name} · ${ui(CONNECTION[peer.connection])}`, ...(problem ? { problem } : {}) }
  }
  const online = peers.filter(peer => peer.connection === 'online').length
  return { state: problem ? 'waiting' : online === peers.length ? 'online' : 'offline', text: ui('{0} of {1} online', { 0: online, 1: peers.length }), ...(problem ? { problem } : {}) }
}

function SettingsDialog({ onClose }: { onClose(): void }) {
  const close = useRef<HTMLButtonElement>(null), onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    close.current?.focus()
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); onCloseRef.current() } }
    document.addEventListener('keydown', key, true)
    // A conversation opened from here, such as one continued on this machine, shows behind the dialog.
    const stopOpened = onSessionOpened(() => onCloseRef.current())
    return () => { document.removeEventListener('keydown', key, true); stopOpened(); if (opener?.isConnected) opener.focus() }
  }, [])
  return createPortal(<div className="dsy dsy-overlay"><style>{styles}</style>
    <div className="dsy-mask" onPointerDown={onClose} />
    <div className="dsy-dialog" style={{ width: 'min(760px, 100%)' }} role="dialog" aria-modal="true" aria-label={ui('Device sync')}>
      <button ref={close} type="button" className="dsy-close" aria-label={ui('Close')} title={ui('Close')} onClick={onClose}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
      </button>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '20px 24px 24px' }}><SyncSettings /></div>
    </div>
  </div>, document.body)
}

/** Conversation header: how the paired machines are doing. Hidden until this machine is paired. */
export function SyncBadge() {
  useLocale()
  const { status } = useStatus(10_000)
  const [open, setOpen] = useState(false)
  const shown = status && summary(status)
  if (!shown) return null
  const label = shown.problem ? `${ui('Device sync')}: ${shown.text} — ${ui(shown.problem)}` : `${ui('Device sync')}: ${shown.text}`
  return <>
    <style>{styles}</style>
    <button type="button" className="dsy dsy-header-button" aria-haspopup="dialog" aria-label={label} title={label} onClick={() => setOpen(true)}>
      <span className="dsy-dot" data-state={shown.state} />{shown.text}
    </button>
    {open && <SettingsDialog onClose={() => setOpen(false)} />}
  </>
}
