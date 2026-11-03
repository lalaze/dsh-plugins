/**
 * Every paired computer's sessions in the Status grouping of Workspace Tags, as the DSH sidebar shows them: Waiting
 * for you, Completed, Running and Idle sections; workspaces in sidebar order with their tag dots; sessions in each
 * workspace's own order, five at a time. Tag chips narrow every section to one tag. Remote Agents' background tasks,
 * which belong to no workspace, follow in a section of their own.
 */
import React, { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { SessionEntry, TaskEntry, WorkspaceEntry } from '../../src/shared/protocol.js'
import { brandOf, brandStyle } from './brands.js'
import { OfflineBanner, Toast } from './chat.js'
import { haptic, icons, Sheet, Toggle } from './controls.js'
import { ago, errorText, ui } from './i18n.js'
import { memory } from './nav.js'
import { requestId, statusOf } from './parts.js'
import { Rename, SessionActions } from './session.js'
import { store, useStore, type HubState } from './store.js'
import { busyTask, cliName } from './task.js'

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
/** What the list keeps while a session is open: search, tag, expanded groups and where it was scrolled to. */
interface ListMemory { query: string; searching: boolean; space: string | null; shown: Record<string, number>; top: number }

/** Tasks waiting for an answer first, then running ones, failed ones, and the rest by their latest change. */
const taskRank = (task: TaskEntry) => task.status === 'attention' ? 0 : busyTask(task) ? 1 : task.status === 'error' ? 2 : 3

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

const SectionIcon = ({ kind }: { kind: SectionKind }) => <span className={`section-icon ${kind}`}>{kind === 'waiting' ? icons.warning : icons[kind]}</span>

/** Pull the list down from its top to reconnect and reload. */
function usePullToRefresh(scroller: RefObject<HTMLDivElement | null>, onRefresh: () => Promise<void>) {
  const [pull, setPull] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const [dragging, setDragging] = useState(false)
  const latest = useRef(onRefresh)
  latest.current = onRefresh
  const busy = useRef(false)
  useEffect(() => {
    const element = scroller.current
    if (!element) return
    let start: number | undefined, distance = 0, active = false
    const down = (event: TouchEvent) => { start = element.scrollTop <= 0 && !busy.current ? event.touches[0].clientY : undefined; distance = 0; active = false }
    const move = (event: TouchEvent) => {
      if (start === undefined) return
      const dy = event.touches[0].clientY - start
      if (dy <= 0 || element.scrollTop > 0) { if (active) { active = false; setDragging(false); setPull(0) } if (dy < 0) start = undefined; return }
      if (!active) { active = true; setDragging(true) }
      distance = Math.min(120, dy * 0.45)
      setPull(distance)
      if (event.cancelable) event.preventDefault()
    }
    const up = () => {
      start = undefined
      if (!active) return
      active = false; setDragging(false)
      if (distance < 60) { setPull(0); return }
      busy.current = true; setRefreshing(true); setPull(52); haptic()
      const minimum = new Promise(resolve => setTimeout(resolve, 700))
      void Promise.all([latest.current().catch(() => {}), minimum]).finally(() => { busy.current = false; setRefreshing(false); setPull(0) })
    }
    element.addEventListener('touchstart', down, { passive: true })
    element.addEventListener('touchmove', move, { passive: false })
    element.addEventListener('touchend', up)
    element.addEventListener('touchcancel', up)
    return () => {
      element.removeEventListener('touchstart', down); element.removeEventListener('touchmove', move)
      element.removeEventListener('touchend', up); element.removeEventListener('touchcancel', up)
    }
  }, [scroller])
  return <div className="pull" data-dragging={dragging} style={{ height: pull }} aria-hidden={!refreshing}>
    <span className="pull-icon" style={{ transform: refreshing ? undefined : `rotate(${Math.min(1, pull / 60) * 270}deg)`, opacity: Math.min(1, pull / 40) }}>
      {refreshing ? <span className="spinner" /> : icons.refresh}
    </span>
  </div>
}

/** Swallow the click a finished long press produces, which would otherwise land on the sheet it just opened. */
function swallowNextClick() {
  const stop = (event: Event) => { event.preventDefault(); event.stopPropagation(); done() }
  const done = () => { removeEventListener('click', stop, true); clearTimeout(timer) }
  const timer = setTimeout(done, 450)
  addEventListener('click', stop, true)
}

/** Long-press (or a right click) for a row's actions; the tap that ends a long press does not open the row. */
function useLongPress(onLong: () => void) {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const fired = useRef(false)
  const origin = useRef<{ x: number; y: number }>(undefined)
  const cancel = () => { clearTimeout(timer.current); timer.current = undefined }
  return {
    onTouchStart: (event: React.TouchEvent) => {
      fired.current = false
      origin.current = { x: event.touches[0].clientX, y: event.touches[0].clientY }
      cancel()
      timer.current = setTimeout(() => { fired.current = true; haptic(); onLong() }, 480)
    },
    onTouchMove: (event: React.TouchEvent) => {
      const start = origin.current, touch = event.touches[0]
      if (start && Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > 10) cancel()
    },
    onTouchEnd: () => { cancel(); if (fired.current) swallowNextClick() },
    onTouchCancel: cancel,
    onContextMenu: (event: React.MouseEvent) => { event.preventDefault(); if (!fired.current) { fired.current = true; onLong() } },
    onClickCapture: (event: React.MouseEvent) => { if (fired.current) { event.preventDefault(); event.stopPropagation(); fired.current = false } },
  }
}

export function SessionList({ onOpen, onOpenTask, onNew, onSettings }: { onOpen(hubId: string, sessionId: string): void; onOpenTask(hubId: string, taskId: string): void; onNew(hubId: string): void; onSettings(): void }) {
  useStore()
  const saved = (memory.get('list') as ListMemory | undefined) ?? { query: '', searching: false, space: null, shown: {}, top: 0 }
  memory.set('list', saved)
  const [query, setQuery] = useState(saved.query)
  const [searching, setSearching] = useState(saved.searching)
  const [space, setSpace] = useState<string | null>(saved.space)
  const [folds, setFolds] = useState(loadFolds)
  const [shown, setShown] = useState<Record<string, number>>(saved.shown)
  const [filters, setFilters] = useState(false)
  const [actions, setActions] = useState<{ hub: HubState; sessionId: string; rename?: boolean }>()
  const [error, setError] = useState<string>()
  const scroller = useRef<HTMLDivElement>(null)
  const view = store.view
  const hubs = [...store.hubs.values()]
  const needle = query.trim().toLowerCase()

  // Coming back from a session finds the list as it was left.
  Object.assign(saved, { query, searching, space, shown })
  useLayoutEffect(() => { if (scroller.current && saved.top) scroller.current.scrollTop = saved.top }, [])

  const pull = usePullToRefresh(scroller, async () => {
    await Promise.all(hubs.map(hub => hub.client.state === 'online' ? hub.refresh() : (hub.client.reconnectNow(), Promise.resolve())))
  })

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
  // Background tasks belong to no workspace, so a tag filter leaves them out.
  const tasks = spaceName ? [] : hubs.flatMap(hub => hub.tasks
    .filter(task => (view.archived || !task.archived) && (!needle || `${task.title} ${task.cwd} ${task.host}`.toLowerCase().includes(needle)))
    .map(task => ({ hub, task })))
    .sort((a, b) => taskRank(a.task) - taskRank(b.task) || b.task.updatedAt - a.task.updatedAt)
  const tasksFolded = !needle && folds.tasks === true
  const taskLimit = needle ? Infinity : shown.tasks ?? WATERMARK

  const fold = (key: string, value: boolean) => setFolds(current => { const next = { ...current, [key]: value }; localStorage.setItem(FOLD_KEY, JSON.stringify(next)); return next })
  const folded = (kind: SectionKind) => !needle && (folds[kind] ?? kind === 'idle')
  const loaded = hubs.some(hub => hub.loaded)
  const primary = hubs.find(hub => hub.client.info?.phone?.grants.control)
  const filtered = view.archived === true || view.subagents === true || view.outside === true
  const allOnline = hubs.every(hub => hub.client.state === 'online')
  const target = actions ? actions.hub.sessions.get(actions.sessionId) : undefined

  return <div className="screen list-screen">
    {searching
      ? <header className="bar search-bar">
        <div className="search">
          {icons.search}
          <input type="search" autoFocus placeholder={ui('Search sessions')} value={query} enterKeyHint="search" autoCapitalize="off" autoCorrect="off"
            onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') (event.target as HTMLInputElement).blur() }} />
          {query && <button type="button" className="clear" aria-label={ui('Clear')} onClick={() => setQuery('')}>{icons.close}</button>}
        </div>
        <button type="button" className="text-button" onClick={() => { setQuery(''); setSearching(false) }}>{ui('Cancel')}</button>
      </header>
      : <header className="bar list-bar">
        <div className="bar-title">
          <div className="title-line big"><span className="ellipsis">DeepSeek Harness</span></div>
          {allOnline && <div className="hub-line ellipsis">{hubs.map(hub => <span key={hub.hub.hubId} className="hub-name"><span className="dot" data-status="idle-ok" />{hub.hub.name}</span>)}</div>}
        </div>
        <button className="icon" aria-label={ui('Search')} onClick={() => setSearching(true)}>{icons.search}</button>
        <button className="icon" aria-label={ui('Settings')} onClick={onSettings}>{icons.gear}</button>
      </header>}
    {hubs.map(hub => <OfflineBanner key={hub.hub.hubId} state={hub.client.state} error={hub.client.error} name={hub.hub.name} onRetry={() => hub.client.reconnectNow()} />)}
    <div className="chips" role="tablist">
      {chips.length > 0 && <>
        <button type="button" role="tab" className="chip-tab" aria-selected={spaceName === null} onClick={() => setSpace(null)}>{ui('All')}</button>
        {chips.map(chip => <button key={chip.name} type="button" role="tab" className="chip-tab" aria-selected={spaceName === chip.name} onClick={() => setSpace(spaceName === chip.name ? null : chip.name)}>
          <span className="tag-dot" style={{ background: tagColor(chip.color) }} />{chip.name}
        </button>)}
      </>}
      <button type="button" className="chip-tab filter" aria-label={ui('View options')} data-active={filtered} onClick={() => setFilters(true)}>{icons.filter}{chips.length === 0 && <span>{ui('View options')}</span>}{filtered && <span className="filter-dot" />}</button>
    </div>
    <div className="scroll list-scroll" ref={scroller} onScroll={event => { saved.top = event.currentTarget.scrollTop }}>
      {pull}
      {!loaded && hubs.some(hub => hub.client.state !== 'offline') && <ListSkeleton />}
      {sections.map(section => {
        const isFolded = folded(section.kind)
        return <section key={section.kind} className="status-section">
          <button type="button" className="section-head" aria-expanded={!isFolded} onClick={() => fold(section.kind, !isFolded)}>
            <SectionIcon kind={section.kind} />
            <span>{ui(LABELS[section.kind])}</span>
            <span className="section-count">{section.count}</span>
            <span className="section-arrow">{icons.chevronRight}</span>
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
                <span className="tag-dots">{tags.map(tag => <span key={tag!.id} className="tag-dot" title={tag!.name} style={{ background: tagColor(tag!.color) }} />)}</span>
                {hubs.length > 1 && <span className="ws-host">{group.hub.hub.name}</span>}
              </div>
              {rows.map(entry => <SessionRow key={entry.sessionId} hub={group.hub} entry={entry} activity={activityOf(group.hub, entry, running.get(group.hub)!)} onOpen={onOpen}
                onActions={group.hub.client.info?.phone?.grants.control ? () => setActions({ hub: group.hub, sessionId: entry.sessionId }) : undefined} />)}
              {hidden > 0 && <button type="button" className="show-more" onClick={() => setShown(current => ({ ...current, [key]: hidden <= WATERMARK ? Infinity : limit + WATERMARK }))}>{ui('Show {0} more sessions', { 0: hidden })}</button>}
              {!needle && hidden === 0 && group.sessions.length > WATERMARK && <button type="button" className="show-more" onClick={() => setShown(current => ({ ...current, [key]: WATERMARK }))}>{ui('Show less')}</button>}
            </div>
          })}
        </section>
      })}
      {tasks.length > 0 && <section className="status-section">
        <button type="button" className="section-head" aria-expanded={!tasksFolded} onClick={() => fold('tasks', !tasksFolded)}>
          <span className="section-icon">{icons.tasks}</span>
          <span>{ui('Background tasks')}</span>
          <span className="section-count">{tasks.length}</span>
          <span className="section-arrow">{icons.chevronRight}</span>
        </button>
        {!tasksFolded && <div className="task-rows">
          {tasks.slice(0, taskLimit).map(({ hub, task }) => <TaskRow key={`${hub.hub.hubId}/${task.id}`} hub={hub} task={task} showHub={hubs.length > 1} onOpen={onOpenTask} />)}
          {tasks.length > taskLimit && <button type="button" className="show-more" onClick={() => setShown(current => ({ ...current, tasks: tasks.length - taskLimit <= WATERMARK ? Infinity : taskLimit + WATERMARK }))}>{ui('Show {0} more tasks', { 0: tasks.length - taskLimit })}</button>}
          {!needle && taskLimit === Infinity && tasks.length > WATERMARK && <button type="button" className="show-more" onClick={() => setShown(current => ({ ...current, tasks: WATERMARK }))}>{ui('Show less')}</button>}
        </div>}
      </section>}
      {loaded && sections.length === 0 && tasks.length === 0 && <div className="empty-state">
        {needle ? icons.search : icons.terminal}
        <div>{needle ? ui('No sessions match.') : ui('No sessions yet.')}</div>
        {!needle && primary && <button type="button" className="button primary" onClick={() => onNew(primary.hub.hubId)}>{ui('New session')}</button>}
      </div>}
      <div className="list-end" />
    </div>
    {primary && !searching && <button className="fab" onClick={() => onNew(primary.hub.hubId)}>{icons.plus}{ui('New')}</button>}
    {filters && <Sheet title={ui('View options')} onClose={() => setFilters(false)}>
      <Toggle label={ui('Show archived')} checked={view.archived === true} onChange={value => store.setView({ archived: value })} />
      <Toggle label={ui('Show sub-agents')} checked={view.subagents === true} onChange={value => store.setView({ subagents: value })} />
      <Toggle label={ui('Show sessions outside workspaces')} checked={view.outside === true} onChange={value => store.setView({ outside: value })} />
    </Sheet>}
    {actions && target && !actions.rename && <SessionActions entry={target} state={actions.hub} onClose={() => setActions(undefined)} onRename={() => setActions({ ...actions, rename: true })} onError={setError} />}
    {actions && target && actions.rename && <Rename entry={target} onClose={() => setActions(undefined)} onSave={title => {
      setActions(undefined)
      void actions.hub.client.call('command', { kind: 'rename', requestId: requestId(), sessionId: target.sessionId, title }).catch(failure => setError(errorText(failure)))
    }} />}
    <Toast message={error} onClose={() => setError(undefined)} />
  </div>
}

function ListSkeleton() {
  return <div className="list-skeleton" aria-label={ui('Connecting…')}>{[0, 1, 2, 3, 4].map(index => <div key={index} className="sk-row"><span className="sk sk-dot" /><span className="sk sk-bar" style={{ width: `${70 - index * 9}%` }} /></div>)}</div>
}

function TaskRow({ hub, task, showHub, onOpen }: { hub: HubState; task: TaskEntry; showHub: boolean; onOpen(hubId: string, taskId: string): void }) {
  const brand = brandOf({ provider: `remote-cli-${task.provider}`, model: task.model })
  const folder = task.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? task.cwd
  return <button type="button" className="session-row task-row" onClick={() => onOpen(hub.hub.hubId, task.id)}>
    <span className="brand-wrap" role="img" aria-label={cliName(task.provider)}>
      <span className="brand" style={brandStyle(brand) as React.CSSProperties} />
      {task.status === 'attention' && <span className="brand-badge" data-activity="waiting" />}
    </span>
    <span className="row-text">
      <span className="session-title ellipsis">{task.title || ui('Untitled session')}</span>
      <span className={`row-sub ellipsis${task.status === 'attention' ? ' waiting' : ''}`}>{task.status === 'attention' ? ui('Needs approval') : [cliName(task.provider), `${task.host}:${folder}`, ...(showHub ? [hub.hub.name] : [])].join(' · ')}</span>
    </span>
    {busyTask(task) && task.status !== 'attention' ? <span className="spinner small" aria-label={ui('Running')} />
      : task.status === 'error' ? <span className="task-error">{ui('Error')}</span>
      : <span className="session-time">{ago(task.updatedAt)}</span>}
  </button>
}

/** What a waiting session asks, for the line under its title. */
function askOf(entry: SessionEntry): string | undefined {
  const item = entry.pending[0]
  if (!item) return undefined
  if (item.kind === 'approval') return ui('Needs approval · {0}', { 0: item.toolName })
  return item.questions[0]?.question ?? ui('Asks a question')
}

function SessionRow({ hub, entry, activity, onOpen, onActions }: { hub: HubState; entry: SessionEntry; activity?: Activity; onOpen(hubId: string, sessionId: string): void; onActions?(): void }) {
  const brand = brandOf(entry.model)
  const press = useLongPress(() => onActions?.())
  const ask = activity === 'waiting' ? askOf(entry) : undefined
  return <button type="button" className="session-row" data-activity={activity} onClick={() => onOpen(hub.hub.hubId, entry.sessionId)} {...(onActions ? press : {})}>
    <span className="brand-wrap" role="img" aria-label={entry.model?.model ?? ui('Model')}>
      <span className="brand" style={brandStyle(brand) as React.CSSProperties} />
      {(activity === 'waiting' || activity === 'completed') && <span className="brand-badge" data-activity={activity} />}
    </span>
    <span className="row-text">
      <span className={`session-title ellipsis${activity === 'completed' ? ' unread' : ''}`}>{entry.title || ui('Untitled session')}</span>
      {ask && <span className="row-sub waiting ellipsis">{ask}</span>}
    </span>
    {activity === 'running' ? <span className="spinner small" aria-label={ui('Running')} /> : <span className="session-time">{ago(entry.updatedAt)}</span>}
  </button>
}
