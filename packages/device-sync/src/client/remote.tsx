import React, { useRef, useState } from 'react'
import { workspaceRef, type LocalStatus } from '../shared/protocol.js'
import { act } from './api.js'
import { ago, localizeError, ui } from './i18n.js'
import { SessionViewer } from './sessions.js'
import { canCommand, tagColor, visibleSessions } from './view-model.js'
import { deliveryMessage, SessionFacts, type Delivery } from './session-common.js'

export function RemoteSettings({ status, refresh }: { status: LocalStatus; refresh(): Promise<void> }) {
  const [busy, setBusy] = useState(false), locked = useRef(false)
  const [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [hidden, setHidden] = useState(false), [children, setChildren] = useState(false)
  const [selected, setSelected] = useState<{ deviceId: string; sessionId: string }>()
  const run = async (task: () => Promise<unknown>) => {
    if (locked.current) return
    locked.current = true; setBusy(true); setError(''); setNotice('')
    try { await task(); await refresh() } catch (e) { setError(localizeError(e)) } finally { locked.current = false; setBusy(false) }
  }
  const peerName = (id: string) => status.peers.find(p => p.deviceId === id)?.name ?? id
  const local = status.workspaces.find(w => w.deviceId === status.device.deviceId)?.items ?? []
  const session = status.sessions.find(s => s.deviceId === selected?.deviceId && s.sessionId === selected?.sessionId)
  const sessions = visibleSessions(status.sessions, hidden, children)
  const devices = [...new Set(sessions.map(s => s.deviceId))]
  return <>
    {error && <p className="dsy-error" role="alert">{error}</p>}
    {notice && <p className="dsy-hint" role="status">{notice}</p>}
    <section className="dsy-section"><h3>{ui('Remote workspaces')}</h3>
      {!status.groups.tagsPlugin && <p className="dsy-hint">{ui('Install Workspace Tags 0.1.10 or later to see shared groups in the sidebar.')}</p>}
      {!status.groups.tags.length && <p className="dsy-hint">{ui('Create groups in Workspace Tags in the sidebar.')}</p>}
      {!status.workspaces.some(w => w.deviceId !== status.device.deviceId && w.items.length) && <p className="dsy-hint">{ui('No remote workspaces yet.')}</p>}
      {status.workspaces.filter(w => w.deviceId !== status.device.deviceId).map(device => <div key={device.deviceId} className="dsy-section"><h4>{peerName(device.deviceId)}</h4>
        {[...device.items].sort((a, b) => a.order - b.order).map(w => {
          const ref = workspaceRef(device.deviceId, w.workspaceId)
          return <div className="dsy-card" key={ref}><h4>{w.title}</h4><p className="dsy-hint dsy-mono">{w.path}</p><p className="dsy-hint">{ui('Path used only on the other machine.')}</p>
            {status.groups.tags.map(t => <label className="dsy-check" key={t.id}><input type="checkbox" disabled={busy} checked={(status.groups.assignments[ref] ?? []).includes(t.id)} onChange={e => { const assigned = e.target.checked; void run(() => act({ action: 'assign', workspaceRef: ref, tagId: t.id, assigned })) }} /><span className="dsy-tagdot" style={{ background: tagColor(t.color) }} />{t.name}</label>)}
            <h4>{ui('Linked workspaces')}</h4>
            {!local.length && <p className="dsy-hint">{ui('No local workspaces.')}</p>}
            {local.map(l => {
              const localRef = workspaceRef(status.device.deviceId, l.workspaceId)
              const linked = status.groups.links.some(pair => pair.includes(ref) && pair.includes(localRef))
              return <label className="dsy-check" key={localRef}><input type="checkbox" checked={linked} disabled={busy} onChange={e => { const linked = e.target.checked; void run(() => act({ action: 'link', localRef, remoteRef: ref, linked })) }} />{l.title}</label>
            })}
          </div>
        })}
      </div>)}
    </section>
    {status.outbox.length > 0 && <section className="dsy-section"><h3>{ui('Pending requests')}</h3><p className="dsy-hint">{ui('Held requests are never sent automatically. Review before sending.')}</p>
      {status.outbox.map(item => <div className="dsy-card" key={item.requestId}><div>{peerName(item.deviceId)} · {item.summary}</div><p className="dsy-hint">{ago(item.createdAt)} · {ui(item.state === 'sending' ? 'Sending…' : item.state === 'held' ? 'Held' : 'Failed')}</p>
        {item.error && <p className="dsy-error">{ui(item.error)}</p>}
        <div className="dsy-actions"><button className="dsy-btn" type="button" disabled={busy || item.state === 'sending' || !canCommand(status.peers.find(p => p.deviceId === item.deviceId))} onClick={() => void run(async () => setNotice(deliveryMessage(await act<Delivery>({ action: 'release', requestId: item.requestId }))))}>{ui('Send now')}</button>
          <button className="dsy-btn" type="button" disabled={busy || item.state === 'sending'} onClick={() => void run(() => act({ action: 'discard', requestId: item.requestId }))}>{ui('Discard')}</button></div>
      </div>)}
    </section>}
    <section className="dsy-section"><h3>{ui('Synced sessions')}</h3>
      <label className="dsy-check"><input type="checkbox" checked={hidden} onChange={e => setHidden(e.target.checked)} />{ui('Show hidden sessions')}</label>
      <label className="dsy-check"><input type="checkbox" checked={children} onChange={e => setChildren(e.target.checked)} />{ui('Show subagent sessions')}</label>
      {!sessions.length && <p className="dsy-hint">{ui('No synced sessions match these filters.')}</p>}
      {devices.map(deviceId => <div className="dsy-card" key={deviceId}><h4>{peerName(deviceId)}</h4>
        {[...new Set(sessions.filter(s => s.deviceId === deviceId).map(s => s.workspaceId))].map(workspaceId => <section className="dsy-section" key={workspaceId ?? ''}><h4>{status.workspaces.find(w => w.deviceId === deviceId)?.items.find(w => w.workspaceId === workspaceId)?.title ?? ui('Other sessions')}</h4>
          {sessions.filter(s => s.deviceId === deviceId && s.workspaceId === workspaceId).sort((a, b) => b.updatedAt - a.updatedAt).map(s => <div className="dsy-row" key={s.sessionId}><div><button type="button" className="dsy-link" onClick={() => setSelected({ deviceId, sessionId: s.sessionId })}>{s.title || s.sessionId}</button><SessionFacts session={s} /></div>
            <button type="button" className="dsy-btn" disabled={busy} onClick={() => void run(() => act({ action: 'hideSession', deviceId, sessionId: s.sessionId, hidden: !s.hidden }))}>{ui(s.hidden ? 'Restore' : 'Hide')}</button></div>)}
        </section>)}
      </div>)}
    </section>
    {selected && <section className="dsy-card" aria-label={ui('Remote sessions')}><div className="dsy-actions"><button type="button" className="dsy-btn" onClick={() => setSelected(undefined)}>{ui('Close')}</button></div>
      {session ? <SessionViewer key={`${session.deviceId}:${session.sessionId}`} session={session} peer={status.peers.find(p => p.deviceId === session.deviceId)} outbox={status.outbox} refresh={refresh} /> : <p className="dsy-hint">{ui('This synced session is no longer available.')}</p>}
    </section>}
  </>
}
