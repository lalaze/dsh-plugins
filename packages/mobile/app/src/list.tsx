/**
 * Every paired computer's sessions in the Status grouping of Workspace Tags, as the DSH sidebar shows them: Waiting
 * for you, Completed, Running and Idle sections; workspaces in sidebar order with their tag dots; sessions in each
 * workspace's own order, five at a time. Tag chips narrow every section to one tag.
 */
import React, { useState } from 'react'
import type { SessionEntry, WorkspaceEntry } from '../../src/shared/protocol.js'
import { brandOf, brandStyle } from './brands.js'
import { icons } from './controls.js'
import { ago, ui } from './i18n.js'
import { ConnectionBadge, statusOf } from './parts.js'
import { store, useStore, type HubState } from './store.js'

type Activity = 'waiting' | 'completed' | 'running'
type SectionKind = Activity | 'idle'
const ACTIVE: readonly Activity[] = ['waiting', 'completed', 'running']
const LABELS: Record<SectionKind, string> = { waiting: 'Waiting for you', completed: 'Completed', running: 'Running', idle: 'Idle' }
/** Sessions shown per workspace before "Show more", as in DSH. */
const WATERMARK = 5
const FOLD_KEY = 'dsh-mobile/folds'

const TAG_COLORS: Record<string, string> = {
  gray: '#a1a1aa', red: '#ef4444', orange: '#f97316', yellow: '#fbbf24', green: '#22c55e', teal: '#14b8a6', blue: '#3b82f6',
  purple: '#a855f7', pink: '#ec4899', amber: '#f59e0b', lime: '#84cc16', emerald: '#10b981', cyan: '#06b6d4', sky: '#0ea5e9',
  indigo: '#6366f1', violet: '#8b5cf6', fuchsia: '#d946ef', rose: '#f43f5e',
}
const tagColor = (color: string) => TAG_COLORS[color] ?? color

interface Group { key: string; hub: HubState; workspace?: WorkspaceEntry; title: string; sessions: SessionEntry[] }
interface Section { kind: SectionKind; groups: Group[]; count: number }

const loadFolds = (): Record<string, boolean> => { try { return JSON.parse(localStorage.getItem(FOLD_KEY) ?? '{}') as Record<string, boolean> } catch { return {} } }

/** A session's one state: waiting on you, running (itself or a sub-agent), finished and unread, or nothing. */
function activityOf(hub: HubState, entry: SessionEntry, runningChildren: Set<string>): Activity | undefined {
  const status = statusOf(entry, store.seen(hub.hub.hubId, entry.sessionId))
  if (status === 'waiting') return 'waiting'
  if (status === 'running' || runningChildren.has(entry.sessionId)) return 'running'
  if (status === 'done' && !entry.archived) return 'completed'
  return undefined
}

/** Workspace Tags' statusSections: a running workspace goes to Running whole; otherwise each state gets its own sessions. */
function statusSections(groups: Group[], activity: (group: Group, entry: SessionEntry) => Activity | undefined): Section[] {
  const active = new Map<Activity, Group[]>(ACTIVE.map(kind => [kind, []]))
  const idle: Group[] = []
  for (const group of groups) {
    if (group.sessions.some(entry => activity(group, entry) === 'running')) { active.get('running')!.push(group); continue }
    const byKind = new Map<Activity, SessionEntry[]>()
    for (const entry of group.sessions) {
      const kind = activity(group, entry)
      if (kind) byKind.set(kind, [...byKind.get(kind) ?? [], entry])
    }
    for (const [kind, sessions] of byKind) active.get(kind)!.push({ ...group, sessions })
    const quiet = group.sessions.filter(entry => activity(group, entry) === undefined)
    if (group.sessions.length === 0 || quiet.length > 0) idle.push({ ...group, sessions: quiet })
  }
  const sections: Section[] = [...active].filter(([, members]) => members.length > 0).map(([kind, members]) => ({
    kind, groups: members,
    count: members.reduce((n, group) => n + (kind === 'running' ? group.sessions.filter(entry => activity(group, entry) === 'running').length : group.sessions.length), 0),
  }))
  if (idle.length > 0) sections.push({ kind: 'idle', groups: idle, count: idle.length })
  return sections
}

const SectionIcon = ({ kind }: { kind: SectionKind }) => {
  const paths: Record<SectionKind, React.ReactNode> = {
    running: <><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" strokeWidth="1.7" /><path d="M10.2 8.8l5 3.2-5 3.2z" fill="currentColor" /></>,
    waiting: <><path d="M12 4l9 15.5H3z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" /><path d="M12 10v4.2M12 16.8v.1" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" /></>,
    completed: <><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" strokeWidth="1.7" /><path d="M8.3 12.3l2.6 2.6 4.9-5.2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></>,
    idle: <path d="M19.5 14.6A7.8 7.8 0 019.4 4.5a7.8 7.8 0 1010.1 10.1z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />,
  }
  return <svg className={`section-icon ${kind}`} viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">{paths[kind]}</svg>
}

export function SessionList({ onOpen, onNew, onSettings }: { onOpen(hubId: string, sessionId: string): void; onNew(hubId: string): void; onSettings(): void }) {
  useStore()
  const [query, setQuery] = useState('')
  const [space, setSpace] = useState<string | null>(null)
  const [folds, setFolds] = useState(loadFolds)
  const [shown, setShown] = useState<Record<string, number>>({})
  const view = store.view
  const hubs = [...store.hubs.values()]
  const needle = query.trim().toLowerCase()

  // Tag chips across computers, by name; a tag on several computers is one chip.
  const tagNames = new Map<string, { name: string; color: string }>()
  for (const hub of hubs) for (const tag of hub.tags.tags) if (!tagNames.has(tag.name)) tagNames.set(tag.name, { name: tag.name, color: tag.color })
  const chips = [...tagNames.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  const spaceName = space && tagNames.has(space) ? space : null

  const groups: Group[] = []
  const running = new Map<HubState, Set<string>>()
  for (const hub of hubs) {
    const children = new Set<string>()
    for (const entry of hub.sessions.values()) if (entry.parentSessionId && entry.state !== 'idle') children.add(entry.parentSessionId)
    running.set(hub, children)
    const visible = (entry: SessionEntry | undefined): entry is SessionEntry => Boolean(entry) && !entry!.removed && !entry!.blank
      && (view.archived || !entry!.archived) && (view.subagents || !(entry!.origin === 'subagent' || entry!.parentSessionId))
      && (!needle || `${entry!.title ?? ''} ${entry!.cwd ?? ''}`.toLowerCase().includes(needle))
    const tagged = (workspaceId: string) => !spaceName || (hub.tags.assignments[workspaceId] ?? []).some(id => hub.tags.tags.find(tag => tag.id === id)?.name === spaceName)
    const member = new Set<string>()
    for (const workspace of [...hub.workspaces].sort((a, b) => a.order - b.order)) {
      for (const id of workspace.sessionIds) member.add(id)
      if (!tagged(workspace.workspaceId)) continue
      const sessions = workspace.sessionIds.map(id => hub.sessions.get(id)).filter(visible)
      if (needle && sessions.length === 0 && !workspace.title.toLowerCase().includes(needle)) continue
      groups.push({ key: `${hub.hub.hubId}/${workspace.workspaceId}`, hub, workspace, title: workspace.title, sessions })
    }
    if (view.outside && !spaceName) {
      const outside = [...hub.sessions.values()].filter(entry => !member.has(entry.sessionId)).filter(visible).sort((a, b) => b.updatedAt - a.updatedAt)
      if (outside.length) groups.push({ key: `${hub.hub.hubId}/`, hub, title: ui('Outside workspaces'), sessions: outside })
    }
  }
  const sections = statusSections(groups, (group, entry) => activityOf(group.hub, entry, running.get(group.hub)!))

  const fold = (key: string, value: boolean) => setFolds(current => { const next = { ...current, [key]: value }; localStorage.setItem(FOLD_KEY, JSON.stringify(next)); return next })
  const folded = (kind: SectionKind) => !needle && (folds[kind] ?? kind === 'idle')
  const loaded = hubs.some(hub => hub.loaded)
  const primary = hubs.find(hub => hub.client.info?.phone?.grants.control)

  return <div className="screen">
    <header className="bar">
      <div className="bar-title"><div className="title-line big">{ui('Sessions')}</div></div>
      <button className="icon" aria-label={ui('Settings')} onClick={onSettings}><svg viewBox="0 0 24 24" width="21" height="21" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="1.8" d="M12 15a3 3 0 100-6 3 3 0 000 6z" /><path fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" d="M19.4 13a7.6 7.6 0 000-2l2-1.5-2-3.4-2.3.9a7.5 7.5 0 00-1.7-1L15 3.6h-4l-.4 2.4a7.5 7.5 0 00-1.7 1l-2.3-.9-2 3.4 2 1.5a7.6 7.6 0 000 2l-2 1.5 2 3.4 2.3-.9c.5.4 1.1.7 1.7 1l.4 2.4h4l.4-2.4c.6-.3 1.2-.6 1.7-1l2.3.9 2-3.4z" /></svg></button>
    </header>
    <div className="list-head">
      <div>{hubs.map(hub => <ConnectionBadge key={hub.hub.hubId} state={hub.client.state} error={hub.client.error} name={hub.hub.name} />)}</div>
      <div className="search"><input type="search" placeholder={ui('Search')} value={query} onChange={event => setQuery(event.target.value)} /></div>
      {chips.length > 0 && <div className="spaces" role="tablist">
        <button type="button" role="tab" className="space" aria-selected={spaceName === null} onClick={() => setSpace(null)}>{ui('All')}</button>
        {chips.map(chip => <button key={chip.name} type="button" role="tab" className="space" aria-selected={spaceName === chip.name} onClick={() => setSpace(spaceName === chip.name ? null : chip.name)}>
          <span className="tag-dot" style={{ background: tagColor(chip.color) }} />{chip.name}
        </button>)}
      </div>}
    </div>
    <div className="scroll">
      {sections.map(section => {
        const isFolded = folded(section.kind)
        return <section key={section.kind} className="status-section">
          <button type="button" className="section-head" aria-expanded={!isFolded} onClick={() => fold(section.kind, !isFolded)}>
            <svg className="section-arrow" viewBox="0 0 24 24" width="10" height="10" aria-hidden="true"><path d="M8 5l10 7-10 7z" fill="currentColor" /></svg>
            <SectionIcon kind={section.kind} />
            <span>{ui(LABELS[section.kind])}</span>
            <span className="section-count">{section.count}</span>
          </button>
          {!isFolded && section.groups.map(group => {
            const key = `${section.kind}/${group.key}`
            const limit = needle ? Infinity : shown[key] ?? WATERMARK
            const rows = group.sessions.slice(0, limit), hidden = group.sessions.length - rows.length
            const tags = group.workspace ? (group.hub.tags.assignments[group.workspace.workspaceId] ?? []).map(id => group.hub.tags.tags.find(tag => tag.id === id)).filter(Boolean) : []
            return <div key={key} className="ws-group">
              <div className="ws-row">
                {icons.folder}
                <span className="ellipsis">{group.title}</span>
                {hubs.length > 1 && <span className="ws-host">{group.hub.hub.name}</span>}
                <span className="tag-dots">{tags.map(tag => <span key={tag!.id} className="tag-dot" title={tag!.name} style={{ background: tagColor(tag!.color) }} />)}</span>
              </div>
              {rows.map(entry => <SessionRow key={entry.sessionId} hub={group.hub} entry={entry} activity={activityOf(group.hub, entry, running.get(group.hub)!)} onOpen={onOpen} />)}
              {hidden > 0 && <button type="button" className="show-more" onClick={() => setShown(current => ({ ...current, [key]: hidden <= WATERMARK ? Infinity : limit + WATERMARK }))}>{ui('Show {0} more sessions', { 0: hidden })}</button>}
              {!needle && hidden === 0 && group.sessions.length > WATERMARK && <button type="button" className="show-more" onClick={() => setShown(current => ({ ...current, [key]: WATERMARK }))}>{ui('Show less')}</button>}
            </div>
          })}
        </section>
      })}
      {loaded && sections.length === 0 && <div className="empty">{query ? ui('No sessions match.') : ui('No sessions yet.')}</div>}
      <div className="view-options">
        <label><input type="checkbox" checked={view.archived === true} onChange={event => store.setView({ archived: event.target.checked })} /> {ui('Show archived')}</label>
        <label><input type="checkbox" checked={view.subagents === true} onChange={event => store.setView({ subagents: event.target.checked })} /> {ui('Show sub-agents')}</label>
        <label><input type="checkbox" checked={view.outside === true} onChange={event => store.setView({ outside: event.target.checked })} /> {ui('Show sessions outside workspaces')}</label>
      </div>
    </div>
    {primary && <button className="fab" onClick={() => onNew(primary.hub.hubId)}>
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" d="M12 5v14M5 12h14" /></svg>{ui('New')}
    </button>}
  </div>
}

function SessionRow({ hub, entry, activity, onOpen }: { hub: HubState; entry: SessionEntry; activity?: Activity; onOpen(hubId: string, sessionId: string): void }) {
  const brand = brandOf(entry.model)
  return <button type="button" className="session-row" onClick={() => onOpen(hub.hub.hubId, entry.sessionId)}>
    <span className="brand-wrap" role="img" aria-label={entry.model?.model ?? ui('Model')}>
      <span className="brand" style={brandStyle(brand) as React.CSSProperties} />
      {(activity === 'waiting' || activity === 'completed') && <span className="brand-badge" data-activity={activity} />}
    </span>
    <span className="session-title ellipsis">{entry.title || ui('Untitled session')}</span>
    {activity === 'running' ? <span className="spinner" aria-label={ui('Running')} /> : <span className="session-time">{ago(entry.updatedAt)}</span>}
  </button>
}
