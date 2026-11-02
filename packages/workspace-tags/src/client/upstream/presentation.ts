import type { ReactNode } from 'react'
import type { GroupNode, SessionNode, ArchivedFilter, SessionOrderBy } from './tree.ts'
import type { TagState } from '../../shared/tags.ts'
import { UNTAGGED_FILTER } from '../tags/sections.ts'

/** Browser-only contract. No mirror identity is a host WorkspaceId or SessionId. */
export interface MirrorWorkspace {
  deviceId: string; workspaceId: string; title: string; displayPath: string; order: number
  sessionIds: readonly string[]; tagIds: readonly string[]; ownerName: string; connection: string
}
export interface MirrorSession {
  deviceId: string; sessionId: string; workspaceId?: string; title: string; updatedAt: number
  removed?: boolean; displayProjectLabel?: string; archived: boolean; hidden: boolean; subagent: boolean; running: boolean; waiting: boolean
  ownerName: string; connection: string
}
export interface MirrorContribution {
  localDevice: { deviceId: string; name: string }
  workspaces: readonly MirrorWorkspace[]
  sessions: readonly MirrorSession[]
  visibility: { showHidden: boolean; showSubagents: boolean }
  activeSession?: { deviceId: string; sessionId: string } | undefined
  openSession(deviceId: string, sessionId: string): void
  renderTagEditor(input: { deviceId: string; workspaceId: string; filterKey: string; onEditingChange(open: boolean): void }): ReactNode
}
export interface PresentationProviderOwner {
  publish(lease: object, contribution: MirrorContribution | null, error?: string, phase?: 'loading' | 'ready' | 'error'): void
}
interface SessionFacts {
  key: string; canonicalKey: string; title: string; updatedAt: number; order: number
  archived: boolean; running: boolean; waiting: boolean; completed: boolean; blank: boolean
}
export type PresentedSession = SessionFacts & (
  | { owner: 'local'; native: SessionNode }
  | { owner: 'mirror'; mirror: MirrorSession }
)
interface GroupFacts {
  key: string; canonicalKey: string; deviceId: string; ownerName: string; title: string; displayPath: string
  rawUpdatedAt?: number; order: number; tagIds: readonly string[]; sessions: readonly PresentedSession[]
}
export type PresentedGroup = GroupFacts & (
  | { owner: 'local'; native: GroupNode }
  | { owner: 'mirror'; mirror: MirrorWorkspace | undefined }
)
export interface PresentationFilter { tagId: string | null; archived: ArchivedFilter; query?: string; order: SessionOrderBy }
export const canonicalKey = (deviceId: string, kind: 'workspace' | 'session', id?: string): string => JSON.stringify([deviceId, kind, id ?? null])
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0
export function compareSessions(order: SessionOrderBy, a: PresentedSession, b: PresentedSession): number {
  if (a.blank !== b.blank) return a.blank ? -1 : 1
  const pinA = a.owner === 'local' && a.native.pinned, pinB = b.owner === 'local' && b.native.pinned
  if (pinA !== pinB) return pinA ? -1 : 1
  return (order === 'updated' ? b.updatedAt - a.updatedAt : a.order - b.order) || compare(a.canonicalKey, b.canonicalKey)
}
export const groupRecency = (group: PresentedGroup): number => group.rawUpdatedAt ?? Math.max(0, ...group.sessions.map(s => s.updatedAt))
export function compareGroups(order: SessionOrderBy, a: PresentedGroup, b: PresentedGroup): number {
  return (order === 'updated' ? groupRecency(b) - groupRecency(a) : a.order - b.order) || compare(a.canonicalKey, b.canonicalKey)
}

/** Stable local render keys deliberately do NOT depend on provider availability. */
export function collectPresentation(local: readonly GroupNode[], tags: TagState, contribution?: MirrorContribution | null, localWorkspaceRecency?: ReadonlyMap<string, number>): PresentedGroup[] {
  const deviceId = contribution?.localDevice.deviceId ?? '@this-host'
  const groups: PresentedGroup[] = local.map((native, order) => ({
    owner: 'local', native, key: `local:${native.key}`, canonicalKey: canonicalKey(deviceId, 'workspace', native.workspaceId), deviceId,
    ownerName: contribution?.localDevice.name ?? '', title: native.label, displayPath: native.cwd ?? '', order: native.workspaceId === undefined ? Number.MAX_SAFE_INTEGER : order,
    rawUpdatedAt: native.workspaceId === undefined ? undefined : localWorkspaceRecency?.get(native.workspaceId) ?? Math.max(0, ...native.sessions.map(session => session.updatedAt)),
    tagIds: native.workspaceId === undefined ? [] : tags.assignments[native.workspaceId] ?? [],
    sessions: native.sessions.map((session, index) => ({ owner: 'local', native: session, key: `local:${session.id}`, canonicalKey: canonicalKey(deviceId, 'session', session.id), title: session.title, updatedAt: session.updatedAt, order: index, archived: session.archived, running: session.running || session.runningSubagentCount > 0, waiting: session.pendingInteraction !== undefined, completed: session.completed, blank: session.blank })),
  }))
  if (!contribution) return groups
  // Workspace recency is an inventory fact, not a property of currently visible rows.
  // Only authoritative membership contributes; retained removed history remains readable, not recent.
  const rawSessions = new Map(contribution.sessions.filter(session => !session.removed).map(session => [canonicalKey(session.deviceId, 'session', session.sessionId), session]))
  const mirrors = new Map<string, PresentedGroup & { owner: 'mirror' }>()
  for (const mirror of contribution.workspaces) {
    if (mirror.deviceId === deviceId) continue
    const key = canonicalKey(mirror.deviceId, 'workspace', mirror.workspaceId)
    if (mirrors.has(key)) continue
    mirrors.set(key, { owner: 'mirror', mirror, key, canonicalKey: key, deviceId: mirror.deviceId, ownerName: mirror.ownerName, title: mirror.title, displayPath: mirror.displayPath, order: mirror.order, rawUpdatedAt: Math.max(0, ...mirror.sessionIds.map(id => rawSessions.get(canonicalKey(mirror.deviceId, 'session', id))?.updatedAt ?? 0)), tagIds: mirror.tagIds, sessions: [] })
  }
  const seen = new Set<string>()
  for (const mirror of contribution.sessions) {
    if (mirror.deviceId === deviceId || mirror.hidden && !contribution.visibility.showHidden || mirror.subagent && !contribution.visibility.showSubagents) continue
    const id = canonicalKey(mirror.deviceId, 'session', mirror.sessionId)
    if (seen.has(id)) continue
    seen.add(id)
    // Unknown workspace membership is still owner-qualified, never folded into the local loose bucket.
    let key = canonicalKey(mirror.deviceId, 'workspace', mirror.workspaceId)
    let group = mirrors.get(key)
    if (!group) {
      key = canonicalKey(mirror.deviceId, 'workspace')
      group = mirrors.get(key)
      if (!group) {
        group = { owner: 'mirror', mirror: undefined, key, canonicalKey: key, deviceId: mirror.deviceId, ownerName: mirror.ownerName, title: '', displayPath: '', order: Number.MAX_SAFE_INTEGER, tagIds: [], sessions: [] }
        mirrors.set(key, group)
      }
    }
    const rank = group.mirror?.sessionIds.indexOf(mirror.sessionId) ?? -1
    group.sessions = [...group.sessions, { owner: 'mirror', mirror, key: id, canonicalKey: id, title: mirror.title, updatedAt: mirror.updatedAt, order: rank < 0 ? group.sessions.length : rank, archived: mirror.archived, running: mirror.running, waiting: mirror.waiting, completed: false, blank: false }]
  }
  return [...groups, ...mirrors.values()]
}

/** One common filtering and ordering path, before grouping/counts/empty-state decisions. */
export function projectPresentation(groups: readonly PresentedGroup[], tags: TagState, filter: PresentationFilter, contentMatches: ReadonlySet<string> = new Set()): PresentedGroup[] {
  const known = new Set(tags.tags.map(tag => tag.id))
  const query = (filter.query ?? '').trim().toLowerCase()
  return groups.flatMap(group => {
    const liveTags = group.tagIds.filter(id => known.has(id))
    if (filter.tagId === UNTAGGED_FILTER ? liveTags.length !== 0 : filter.tagId !== null && !liveTags.includes(filter.tagId)) return []
    const workspaceMatch = `${group.title}\n${group.displayPath}\n${group.ownerName}`.toLowerCase().includes(query)
    const sessions = group.sessions.filter(session => {
      if (filter.archived === 'default' && session.archived || filter.archived === 'only' && !session.archived) return false
      return query === '' || !session.blank && (workspaceMatch || `${session.title}\n${session.owner === 'local' ? session.native.id : `${session.mirror.sessionId}\n${session.mirror.displayProjectLabel ?? ''}`}`.toLowerCase().includes(query) || contentMatches.has(session.key))
    }).sort((a, b) => compareSessions(filter.order, a, b))
    if ((query !== '' || filter.archived === 'only') && sessions.length === 0) return []
    return [{ ...group, sessions }]
  }).sort((a, b) => compareGroups(filter.order, a, b))
}
export function flattenPresentation(groups: readonly PresentedGroup[], order: SessionOrderBy): PresentedSession[] {
  return groups.flatMap(group => group.sessions).sort((a, b) => compareSessions(order, a, b))
}
export interface PresentedSection { key: string; kind: 'tag' | 'untagged' | 'waiting' | 'running' | 'completed' | 'idle'; tagId?: string; groups: PresentedGroup[]; count: number }
export function sectionPresentation(groups: readonly PresentedGroup[], tags: TagState, mode: 'tag' | 'status'): PresentedSection[] {
  if (mode === 'tag') {
    const known = new Set(tags.tags.map(tag => tag.id))
    const sections: PresentedSection[] = [...tags.tags].sort((a, b) => a.name.localeCompare(b.name)).map(tag => {
      const members = groups.filter(group => group.tagIds.includes(tag.id))
      return { key: `tag:${tag.id}`, kind: 'tag' as const, tagId: tag.id, groups: members, count: members.length }
    })
    sections.push({ key: 'untagged', kind: 'untagged', groups: groups.filter(group => !group.tagIds.some(id => known.has(id))), count: 0 })
    return sections.map(section => ({ ...section, count: section.groups.length })).filter(section => section.count > 0)
  }
  return (['waiting', 'completed', 'running', 'idle'] as const).map(kind => {
    const members = groups.flatMap(group => {
      const running = group.sessions.some(session => session.running)
      if (running) return kind === 'running' ? [group] : []
      const sessions = group.sessions.filter(session => kind === 'waiting' ? session.waiting : kind === 'completed' ? !session.waiting && session.completed && !session.archived : kind === 'idle' ? !session.waiting && (!session.completed || session.archived) : false)
      return sessions.length > 0 || kind === 'idle' && group.sessions.length === 0 ? [{ ...group, sessions }] : []
    })
    return { key: `status:${kind}`, kind, groups: members, count: members.reduce((sum, group) => sum + (kind === 'idle' ? 1 : kind === 'running' ? group.sessions.filter(s => s.running).length : group.sessions.length), 0) }
  }).filter(section => section.groups.length > 0)
}


export function presentationActivity(groups: readonly PresentedGroup[], tags: TagState) {
  const idle = () => ({ waiting: 0, completed: 0, running: 0 })
  const result = new Map<string | null, ReturnType<typeof idle>>([[null, idle()], ...tags.tags.map(tag => [tag.id, idle()] as const)])
  for (const group of groups) for (const session of group.sessions) {
    const state = session.waiting ? 'waiting' : session.running ? 'running' : session.completed && !session.archived ? 'completed' : undefined
    if (!state) continue
    for (const key of [null, ...new Set(group.tagIds)]) { const count = result.get(key); if (count) count[state]++ }
  }
  return result
}
