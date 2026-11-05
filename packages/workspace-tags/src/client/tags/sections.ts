/**
 * Tag and Status sections over ui-workspace's Workspace groups, and the space
 * filter that narrows every grouping to one tag. A Workspace appears in every
 * Tag or Status section it qualifies for, and each Session in one Status section.
 * The sidebar's Workspace order is kept inside each section; empty sections
 * are left out.
 */
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { orderedTags, type TagState, type WorkspaceTag } from '../../shared/tags.ts'
import type { GroupNode, SessionNode } from '../upstream/tree.ts'
import type { SectionMode } from './contract.ts'

/** What a Session can be doing besides nothing, most urgent first: the Status sections' order. */
/** Internal projection key only; never persisted in the tag catalogue or assignments. */
export const UNTAGGED_FILTER = '@workspace-tags/untagged-filter'

export const ACTIVE_STATUSES = ['waiting', 'completed', 'running'] as const
export type ActiveStatus = typeof ACTIVE_STATUSES[number]

export type SectionKind = 'tag' | 'untagged' | ActiveStatus | 'idle'

export interface BrowserSection {
  /** Stable across renders: `tag:<id>`, `untagged`, or `status:<kind>`. */
  key: string
  kind: SectionKind
  tag?: WorkspaceTag
  /**
   * Tag sections hold whole Workspaces. Waiting and Completed hold each Workspace
   * with only its Sessions in that state. Running holds a Workspace with a running
   * Session, with the Sessions resting beside it, and Idle the others, following the
   * Workspace's own fold.
   */
  groups: readonly GroupNode[]
  /** Workspaces in Tag and Idle sections, running Sessions in Running, matching Sessions in the others. */
  count: number
}

/** Sessions waiting on the user and finished-but-unread ones: what the space switcher's badges count. */
export interface Attention { waiting: number; completed: number }

/** What a folded Workspace row shows: its Sessions that need the user, else whether one runs. */
export interface RowActivity extends Attention { running: boolean }

/** What a space chip shows: its Sessions that need the user, and how many only run. */
export interface SpaceActivity extends Attention { running: number }

/**
 * A Session's one state, ranked as its row's status dot ranks them: waiting
 * on the user, then running (itself or a subagent), then finished and unread.
 * An archived Session cannot be opened, so its completion could never be read.
 */
export function sessionActivity(node: SessionNode): ActiveStatus | undefined {
  if (node.pendingInteraction !== undefined) return 'waiting'
  if (node.running || node.runningSubagentCount > 0) return 'running'
  if (node.completed && !node.archived) return 'completed'
  return undefined
}

/** A group's activity from its unfolded Sessions; undefined when all are idle. */
export function rowActivity(sessions: readonly SessionNode[]): RowActivity | undefined {
  const activity: RowActivity = { waiting: 0, completed: 0, running: false }
  for (const node of sessions) {
    const kind = sessionActivity(node)
    if (kind === 'running') activity.running = true
    else if (kind !== undefined) activity[kind]++
  }
  return activity.running || activity.waiting + activity.completed > 0 ? activity : undefined
}

export const isActiveStatus = (kind: SectionKind): kind is ActiveStatus => (ACTIVE_STATUSES as readonly string[]).includes(kind)

/** The space filter's tag when it still exists; a deleted or not yet loaded tag shows everything. */
export function liveFilter(state: TagState, filter: string | null): WorkspaceTag | null {
  return filter === null ? null : state.tags.find(tag => tag.id === filter) ?? null
}

/** Whether a group shows under the space filter; the Ungrouped bucket has no tags. */
export function inSpace(state: TagState, filter: string | null, workspaceId: string | undefined): boolean {
  if (filter === UNTAGGED_FILTER) return workspaceId === undefined || !(state.assignments[workspaceId] ?? []).some(id => state.tags.some(tag => tag.id === id))
  return filter === null || (workspaceId !== undefined && (state.assignments[workspaceId] ?? []).includes(filter))
}

/**
 * Activity across all groups (`null`) and per tag, for the space switcher.
 * @param groups - every group, unfiltered, with its Sessions unfolded.
 */
export function activityBySpace(groups: readonly GroupNode[], state: TagState): Map<string | null, SpaceActivity> {
  const idle = (): SpaceActivity => ({ waiting: 0, completed: 0, running: 0 })
  const counts = new Map<string | null, SpaceActivity>([[null, idle()], ...state.tags.map(tag => [tag.id, idle()] as const)])
  for (const group of groups) {
    const spaces = [null, ...group.workspaceId === undefined ? [] : state.assignments[group.workspaceId] ?? []]
    for (const node of group.sessions) {
      const activity = sessionActivity(node)
      if (activity === undefined) continue
      for (const space of spaces) {
        const count = counts.get(space)
        if (count !== undefined) count[activity]++
      }
    }
  }
  return counts
}

/** Tag sections in the tags' order, then Untagged; the ungrouped bucket has no tags. */
export function tagSections(groups: readonly GroupNode[], state: TagState): BrowserSection[] {
  const known = new Map(state.tags.map(tag => [tag.id, tag]))
  const byTag = new Map<string, GroupNode[]>()
  const untagged: GroupNode[] = []
  for (const group of groups) {
    const ids = group.workspaceId === undefined ? [] : (state.assignments[group.workspaceId] ?? []).filter(id => known.has(id))
    if (ids.length === 0) untagged.push(group)
    for (const id of ids) {
      const members = byTag.get(id)
      if (members === undefined) byTag.set(id, [group])
      else members.push(group)
    }
  }
  const sections: BrowserSection[] = orderedTags(state).filter(tag => byTag.has(tag.id))
    .map(tag => ({ key: `tag:${tag.id}`, kind: 'tag' as const, tag, groups: byTag.get(tag.id)!, count: byTag.get(tag.id)!.length }))
  if (untagged.length > 0) sections.push({ key: 'untagged', kind: 'untagged', groups: untagged, count: untagged.length })
  return sections
}

/**
 * Waiting for the user, then finished and unread, then running, then Idle.
 * What needs the user always shows in its own section, a Workspace that also runs
 * something included. A Workspace with a running Session (including a subagent)
 * keeps its resting Sessions in Running, so it is not in Idle as well. Idle also
 * holds Workspaces without Sessions, where a new one starts.
 * @param groups - the rendered groups, whose Sessions follow their fold state.
 * @param sessionsOf - a group's Sessions regardless of its fold state.
 */
export function statusSections(groups: readonly GroupNode[], sessionsOf: (group: GroupNode) => readonly SessionNode[]): BrowserSection[] {
  const active = new Map<ActiveStatus, GroupNode[]>(ACTIVE_STATUSES.map(kind => [kind, []]))
  const idle: GroupNode[] = []
  for (const group of groups) {
    const all = sessionsOf(group)
    const byKind = new Map<ActiveStatus, SessionNode[]>()
    for (const node of all) {
      const kind = sessionActivity(node)
      if (kind === undefined) continue
      const members = byKind.get(kind)
      if (members === undefined) byKind.set(kind, [node])
      else members.push(node)
    }
    const busy = byKind.has('running')
    for (const kind of ['waiting', 'completed'] as const) {
      const sessions = byKind.get(kind)
      if (sessions !== undefined) active.get(kind)!.push({ ...group, expanded: true, sessions })
    }
    if (busy) {
      const sessions = all.filter((node) => { const kind = sessionActivity(node); return kind === 'running' || kind === undefined })
      active.get('running')!.push({ ...group, expanded: true, sessions })
    } else if (all.length === 0 || all.some(node => sessionActivity(node) === undefined)) {
      idle.push({ ...group, sessions: group.sessions.filter(node => sessionActivity(node) === undefined) })
    }
  }
  const sections: BrowserSection[] = [...active]
    .filter(([, members]) => members.length > 0)
    .map(([kind, members]) => ({
      key: `status:${kind}`, kind, groups: members, count: members.reduce((n, member) => n + (kind === 'running'
        ? member.sessions.filter(node => sessionActivity(node) === 'running').length
        : member.sessions.length), 0),
    }))
  if (idle.length > 0) sections.push({ key: 'status:idle', kind: 'idle', groups: idle, count: idle.length })
  return sections
}

/**
 * The Session whose completion to keep showing. Opening a Session reads its completion at once,
 * which would take the row out from under the click, often into the folded Idle, so it stays
 * until the user leaves it or it has something new to show.
 * @param held - the Session held so far.
 * @param previous - DSH's status before this one.
 * @param open - the Session in the main view.
 */
export function heldCompletion(
  held: SessionId | undefined,
  previous: SessionStatusSnapshot,
  statuses: SessionStatusSnapshot,
  open: SessionId | undefined,
): SessionId | undefined {
  if (open === undefined) return undefined
  const status = statuses.get(open)
  if (status?.running === true || status?.pendingInteraction !== undefined) return undefined
  if (held === open) return held
  return previous.get(open)?.completionUnread === true && status?.completionUnread !== true ? open : undefined
}

/** Idle starts folded: it is the catch-all, and the sections above it are what needs a look. */
export function sectionFoldedByDefault(key: string): boolean {
  return key === 'status:idle'
}

export function sectionFolded(collapsed: Readonly<Record<string, boolean>>, key: string): boolean {
  return collapsed[key] ?? sectionFoldedByDefault(key)
}

export function browserSections(
  mode: SectionMode,
  groups: readonly GroupNode[],
  state: TagState,
  sessionsOf: (group: GroupNode) => readonly SessionNode[],
): BrowserSection[] {
  return mode === 'tag' ? tagSections(groups, state) : statusSections(groups, sessionsOf)
}
