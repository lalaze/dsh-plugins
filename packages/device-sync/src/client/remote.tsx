import React, { useRef, useState } from 'react'
import { workspaceRef, type LocalStatus } from '../shared/protocol.js'
import { act } from './api.js'
import { ago, localizeError, ui } from './i18n.js'
import { SessionViewer } from './sessions.js'
import { canCommand, matchSessions, tagColor, visibleSessions } from './view-model.js'
import { deliveryMessage, SessionFacts, type Delivery } from './session-common.js'

/** Sessions listed per workspace before "Show more". */
const PREVIEW = 5

export function RemoteSettings({ status, refresh }: { status: LocalStatus; refresh(): Promise<void> }) {
  const [busy, setBusy] = useState(false), locked = useRef(false)
  const [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [hidden, setHidden] = useState(false), [children, setChildren] = useState(false)
  const [selected, setSelected] = useState<{ deviceId: string; sessionId: string }>()
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({}), [collapsed, setCollapsed] = useState<Record<string, boolean>>({}), [showAll, setShowAll] = useState<Record<string, boolean>>({})
  const run = async (task: () => Promise<unknown>) => {
    if (locked.current) return
    locked.current = true; setBusy(true); setError(''); setNotice('')
    try { await task(); await refresh() } catch (e) { setError(localizeError(e)) } finally { locked.current = false; setBusy(false) }
  }
  const peerName = (id: string) => status.peers.find(p => p.deviceId === id)?.name ?? id
  const session = status.sessions.find(s => s.deviceId === selected?.deviceId && s.sessionId === selected?.sessionId)
  const workspaceTitle = (deviceId: string, workspaceId?: string) => status.workspaces.find(w => w.deviceId === deviceId)?.items.find(w => w.workspaceId === workspaceId)?.title
  const searching = query.trim() !== ''
  const sessions = matchSessions(visibleSessions(status.sessions, hidden, children), query, s => workspaceTitle(s.deviceId, s.workspaceId))
  const devices = [...new Set(sessions.map(s => s.deviceId))]
  return <>
    {error && <p className="dsy-error" role="alert">{error}</p>}
    {notice && <p className="dsy-hint" role="status">{notice}</p>}
    <section className="dsy-section"><h3>{ui('Remote workspaces')}</h3>
      {!status.groups.tagsPlugin && <p className="dsy-hint">{ui('Install Workspace Tags 0.1.10 or later to see shared groups in the sidebar.')}</p>}
      {!status.workspaces.some(w => w.deviceId !== status.device.deviceId && w.items.length) && <p className="dsy-hint">{ui('No remote workspaces yet.')}</p>}
      {status.workspaces.filter(w => w.deviceId !== status.device.deviceId && w.items.length).map(device => {
        const name = peerName(device.deviceId), key = `workspaces/${device.deviceId}`
        return <div className="dsy-card" key={device.deviceId}>
          <h4><button type="button" className="dsy-fold" aria-expanded={!!expanded[key]} onClick={() => setExpanded(old => ({ ...old, [key]: !old[key] }))}><span className="dsy-chevron" aria-hidden="true">›</span><span className="dsy-ws-title">{name}</span><span className="dsy-count">{ui('{0} workspaces', { 0: device.items.length })}</span></button></h4>
          {expanded[key] && <>
            <p className="dsy-hint">{status.groups.tags.length ? ui('Select a group to add a workspace to it or take it out. Groups show in {0}’s sidebar; paths are only used on {0}.', { 0: name }) : ui('Create groups in Workspace Tags in the sidebar.')}</p>
            {[...device.items].sort((a, b) => a.order - b.order).map(w => {
              const ref = workspaceRef(device.deviceId, w.workspaceId), assigned = status.groups.assignments[ref] ?? []
              return <div className="dsy-wrow" key={ref}>
                <div className="dsy-wrow-main"><span className="dsy-ws-title" title={w.title}>{w.title}</span><span className="dsy-wrow-path dsy-mono" title={w.path}>{w.path}</span></div>
                {status.groups.tags.length > 0 && <div className="dsy-chips" role="group" aria-label={ui('Groups of {0}', { 0: w.title })}>{status.groups.tags.map(t => {
                  const on = assigned.includes(t.id)
                  return <button type="button" key={t.id} className="dsy-chip" aria-pressed={on} disabled={busy} style={{ '--dsy-tag': tagColor(t.color) } as React.CSSProperties}
                    title={ui(on ? 'Remove from {0}' : 'Add to {0}', { 0: t.name })} onClick={() => void run(() => act({ action: 'assign', workspaceRef: ref, tagId: t.id, assigned: !on }))}><span className="dsy-chip-dot" aria-hidden="true" />{t.name}</button>
                })}</div>}
              </div>
            })}
          </>}
        </div>
      })}
    </section>
    {status.outbox.length > 0 && <section className="dsy-section"><h3>{ui('Pending requests')}</h3><p className="dsy-hint">{ui('Held requests are never sent automatically. Review before sending.')}</p>
      {status.outbox.map(item => <div className="dsy-card" key={item.requestId}><div>{peerName(item.deviceId)} · {item.summary}</div><p className="dsy-hint">{ago(item.createdAt)} · {ui(item.state === 'sending' ? 'Sending…' : item.state === 'held' ? 'Held' : 'Failed')}</p>
        {item.error && <p className="dsy-error">{ui(item.error)}</p>}
        <div className="dsy-actions"><button className="dsy-btn" type="button" disabled={busy || item.state === 'sending' || !canCommand(status.peers.find(p => p.deviceId === item.deviceId))} onClick={() => void run(async () => setNotice(deliveryMessage(await act<Delivery>({ action: 'release', requestId: item.requestId }))))}>{ui('Send now')}</button>
          <button className="dsy-btn" type="button" disabled={busy || item.state === 'sending'} onClick={() => void run(() => act({ action: 'discard', requestId: item.requestId }))}>{ui('Discard')}</button></div>
      </div>)}
    </section>}
    <section className="dsy-section"><h3>{ui('Synced sessions')}</h3>
      <input className="dsy-input" type="search" aria-label={ui('Search synced sessions')} placeholder={ui('Search synced sessions')} value={query} onChange={e => setQuery(e.target.value)} />
      <div className="dsy-filters">
        <label className="dsy-check"><input type="checkbox" checked={hidden} onChange={e => setHidden(e.target.checked)} />{ui('Show hidden sessions')}</label>
        <label className="dsy-check"><input type="checkbox" checked={children} onChange={e => setChildren(e.target.checked)} />{ui('Show subagent sessions')}</label>
      </div>
      {!sessions.length && <p className="dsy-hint">{ui('No synced sessions match these filters.')}</p>}
      {devices.map(deviceId => {
        const own = sessions.filter(s => s.deviceId === deviceId)
        // Device cards start folded; a search unfolds every card and group that has a match.
        const deviceOpen = searching || !!expanded[deviceId]
        return <div className="dsy-card" key={deviceId}>
          <h4><button type="button" className="dsy-fold" aria-expanded={deviceOpen} onClick={() => setExpanded(old => ({ ...old, [deviceId]: !deviceOpen }))}><span className="dsy-chevron" aria-hidden="true">›</span><span className="dsy-ws-title">{peerName(deviceId)}</span><span className="dsy-count">{ui('{0} sessions', { 0: own.length })}</span></button></h4>
          {deviceOpen && [...new Set(own.map(s => s.workspaceId))].map(workspaceId => {
            const key = `${deviceId}/${workspaceId ?? ''}`
            const rows = own.filter(s => s.workspaceId === workspaceId).sort((a, b) => b.updatedAt - a.updatedAt)
            const groupOpen = searching || !collapsed[key]
            const shown = searching || showAll[key] ? rows : rows.slice(0, PREVIEW)
            return <section className="dsy-group" key={key}>
              <button type="button" className="dsy-fold dsy-fold-group" aria-expanded={groupOpen} onClick={() => setCollapsed(old => ({ ...old, [key]: groupOpen }))}><span className="dsy-chevron" aria-hidden="true">›</span><span className="dsy-ws-title">{workspaceTitle(deviceId, workspaceId) ?? ui('Other sessions')}</span><span className="dsy-count">{rows.length}</span></button>
              {groupOpen && <>
                {shown.map(s => <div className="dsy-srow" key={s.sessionId} aria-current={s.deviceId === selected?.deviceId && s.sessionId === selected.sessionId}>
                  <button type="button" className="dsy-link dsy-srow-title" title={s.title || s.sessionId} onClick={() => setSelected({ deviceId, sessionId: s.sessionId })}>{s.title || s.sessionId}</button>
                  <SessionFacts session={s} />
                  <button type="button" className="dsy-btn dsy-btn-sm" disabled={busy} onClick={() => void run(() => act({ action: 'hideSession', deviceId, sessionId: s.sessionId, hidden: !s.hidden }))}>{ui(s.hidden ? 'Restore' : 'Hide')}</button>
                </div>)}
                {!searching && rows.length > PREVIEW && <button type="button" className="dsy-link dsy-more" onClick={() => setShowAll(old => ({ ...old, [key]: !old[key] }))}>{showAll[key] ? ui('Show fewer') : ui('Show {0} more', { 0: rows.length - PREVIEW })}</button>}
              </>}
            </section>
          })}
        </div>
      })}
    </section>
    {selected && <section className="dsy-card" aria-label={ui('Remote sessions')}><div className="dsy-actions"><button type="button" className="dsy-btn" onClick={() => setSelected(undefined)}>{ui('Close')}</button></div>
      {session ? <SessionViewer key={`${session.deviceId}:${session.sessionId}`} session={session} peer={status.peers.find(p => p.deviceId === session.deviceId)} outbox={status.outbox} refresh={refresh} /> : <p className="dsy-hint">{ui('This synced session is no longer available.')}</p>}
    </section>}
  </>
}
