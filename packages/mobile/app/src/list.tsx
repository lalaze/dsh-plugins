/** Every paired computer's sessions, grouped by workspace like Paseo's agent list, with what needs you first. */
import React, { useState } from 'react'
import type { SessionEntry } from '../../src/shared/protocol.js'
import { ago, ui } from './i18n.js'
import { ConnectionBadge, StatusDot, statusOf, type Status } from './parts.js'
import { store, useStore, type HubState } from './store.js'

const RANK: Record<Status, number> = { waiting: 0, running: 1, done: 2, idle: 3 }

interface Group { key: string; title: string; hub: HubState; sessions: SessionEntry[] }

export function SessionList({ onOpen, onNew, onSettings }: { onOpen(hubId: string, sessionId: string): void; onNew(hubId: string): void; onSettings(): void }) {
  useStore()
  const [query, setQuery] = useState('')
  const view = store.view
  const hubs = [...store.hubs.values()]
  const groups = (() => {
    const result: Group[] = []
    const needle = query.trim().toLowerCase()
    for (const hub of hubs) {
      const titles = new Map(hub.workspaces.map(w => [w.workspaceId, w.title]))
      const byWorkspace = new Map<string, SessionEntry[]>()
      for (const entry of hub.sessions.values()) {
        if (entry.removed || (!view.archived && entry.archived) || (!view.subagents && (entry.origin === 'subagent' || entry.parentSessionId))) continue
        const workspace = entry.workspaceId && titles.has(entry.workspaceId) ? entry.workspaceId : ''
        if (needle && !`${entry.title ?? ''} ${titles.get(workspace) ?? ''} ${entry.cwd ?? ''}`.toLowerCase().includes(needle)) continue
        const list = byWorkspace.get(workspace) ?? []
        list.push(entry); byWorkspace.set(workspace, list)
      }
      for (const [workspace, sessions] of byWorkspace) {
        sessions.sort((a, b) => RANK[statusOf(a, store.seen(hub.hub.hubId, a.sessionId))] - RANK[statusOf(b, store.seen(hub.hub.hubId, b.sessionId))] || b.updatedAt - a.updatedAt)
        result.push({ key: `${hub.hub.hubId}/${workspace}`, title: titles.get(workspace) ?? ui('Other'), hub, sessions })
      }
    }
    // Groups with something waiting or running come first, then the most recently active.
    const score = (group: Group) => Math.min(...group.sessions.map(s => RANK[statusOf(s, store.seen(group.hub.hub.hubId, s.sessionId))]))
    return result.sort((a, b) => score(a) - score(b) || Math.max(...b.sessions.map(s => s.updatedAt)) - Math.max(...a.sessions.map(s => s.updatedAt)))
  })()

  const loaded = hubs.some(hub => hub.loaded)
  const primary = hubs.find(hub => hub.client.info?.phone?.grants.control)
  return <div className="screen">
    <header className="bar">
      <div className="bar-title"><div className="title-line big">{ui('Sessions')}</div></div>
      <button className="icon" aria-label={ui('Settings')} onClick={onSettings}><svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="1.8" d="M12 15a3 3 0 100-6 3 3 0 000 6z" /><path fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" d="M19.4 13a7.6 7.6 0 000-2l2-1.5-2-3.4-2.3.9a7.5 7.5 0 00-1.7-1L15 3.6h-4l-.4 2.4a7.5 7.5 0 00-1.7 1l-2.3-.9-2 3.4 2 1.5a7.6 7.6 0 000 2l-2 1.5 2 3.4 2.3-.9c.5.4 1.1.7 1.7 1l.4 2.4h4l.4-2.4c.6-.3 1.2-.6 1.7-1l2.3.9 2-3.4z" /></svg></button>
    </header>
    <div className="connections">{hubs.map(hub => <ConnectionBadge key={hub.hub.hubId} state={hub.client.state} error={hub.client.error} name={hub.hub.name} />)}</div>
    <div className="search"><input type="search" placeholder={ui('Search')} value={query} onChange={event => setQuery(event.target.value)} /></div>
    <div className="scroll">
      {groups.map(group => <section key={group.key} className="group">
        <h2>{group.title}{hubs.length > 1 && <span className="muted"> · {group.hub.hub.name}</span>}</h2>
        {group.sessions.map(entry => {
          const status = statusOf(entry, store.seen(group.hub.hub.hubId, entry.sessionId))
          return <button key={entry.sessionId} className="session-row" onClick={() => onOpen(group.hub.hub.hubId, entry.sessionId)}>
            <StatusDot status={status} />
            <span className="session-main">
              <span className="session-title ellipsis">{entry.title || ui('Untitled session')}</span>
              <span className="session-meta ellipsis">{status === 'waiting' ? ui('Needs you') : status === 'running' ? ui('Running') : ago(entry.updatedAt)}{entry.model ? ` · ${entry.model.model}` : ''}{entry.archived ? ` · ${ui('Archive')}` : ''}</span>
            </span>
          </button>
        })}
      </section>)}
      {loaded && groups.length === 0 && <div className="empty">{query ? ui('No sessions match.') : ui('No sessions yet.')}</div>}
      <div className="toggles">
        <label><input type="checkbox" checked={view.archived === true} onChange={event => store.setView({ archived: event.target.checked })} /> {ui('Show archived')}</label>
        <label><input type="checkbox" checked={view.subagents === true} onChange={event => store.setView({ subagents: event.target.checked })} /> {ui('Show sub-agents')}</label>
      </div>
    </div>
    {primary && <button className="fab" onClick={() => onNew(primary.hub.hubId)} aria-label={ui('New session')}>
      <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" d="M12 5v14M5 12h14" /></svg>
    </button>}
  </div>
}
