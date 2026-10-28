/**
 * Tag and Status sections over ui-workspace's Workspace groups. A Workspace
 * appears in every section it qualifies for, keeping the sidebar's Workspace
 * order inside each; empty sections are left out.
 */
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TagState, WorkspaceTag } from '../../shared/tags.ts'
import { runningChildCount, visiblePendingKind, type GroupNode } from '../upstream/tree.ts'
import type { SectionMode } from './contract.ts'

export type SectionKind = 'tag' | 'untagged' | 'running' | 'waiting' | 'completed' | 'idle'

export interface BrowserSection {
  /** Stable across renders: `tag:<id>`, `untagged`, or `status:<kind>`. */
  key: string
  kind: SectionKind
  tag?: WorkspaceTag
  groups: readonly GroupNode[]
}

/**
 * What a Workspace's Sessions are doing. Each Session counts once, in this
 * order: waiting on the user, running, finished but not yet opened.
 */
export interface WorkspaceActivity { running: boolean; waiting: boolean; completed: boolean }

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** Tag sections in name order, then Untagged; the ungrouped bucket has no tags. */
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
  const sections: BrowserSection[] = [...byTag]
    .map(([id, members]) => ({ key: `tag:${id}`, kind: 'tag' as const, tag: known.get(id)!, groups: members }))
    .sort((a, b) => collator.compare(a.tag.name, b.tag.name))
  if (untagged.length > 0) sections.push({ key: 'untagged', kind: 'untagged', groups: untagged })
  return sections
}

/** Running first, then waiting for the user, then finished and unread, then idle. */
export function statusSections(groups: readonly GroupNode[], activityOf: (group: GroupNode) => WorkspaceActivity): BrowserSection[] {
  const running: GroupNode[] = []
  const waiting: GroupNode[] = []
  const completed: GroupNode[] = []
  const idle: GroupNode[] = []
  for (const group of groups) {
    const activity = activityOf(group)
    if (activity.running) running.push(group)
    if (activity.waiting) waiting.push(group)
    if (activity.completed) completed.push(group)
    if (!activity.running && !activity.waiting && !activity.completed) idle.push(group)
  }
  return ([['running', running], ['waiting', waiting], ['completed', completed], ['idle', idle]] as const)
    .filter(([, members]) => members.length > 0)
    .map(([kind, members]) => ({ key: `status:${kind}`, kind, groups: members }))
}

/**
 * Activity across every member Session, including folded ones, with the same
 * status sources the Session rows use. Subagent children count through their
 * parent; the Ungrouped bucket's members include them, and would otherwise
 * show it running alongside the parent's Workspace. An unread completion
 * counts only on a Session that has a row to open: archived Sessions cannot
 * be opened, so theirs could never be read.
 */
export function workspaceActivity(
  sessionIds: readonly SessionId[],
  list: SessionListState,
  statuses: SessionStatusSnapshot,
  archived: ReadonlySet<SessionId> = new Set(),
): WorkspaceActivity {
  let running = false
  let waiting = false
  let completed = false
  for (const id of sessionIds) {
    if (list.byId[id]?.origin === 'subagent') continue
    const status = statuses.get(id)
    if (visiblePendingKind(status?.pendingInteraction?.kind) !== undefined) waiting = true
    else if ((status?.running ?? list.byId[id]?.running) === true || runningChildCount(list, id, statuses) > 0) running = true
    else if (status?.completionUnread === true && !archived.has(id)) completed = true
  }
  return { running, waiting, completed }
}

export function browserSections(
  mode: SectionMode,
  groups: readonly GroupNode[],
  state: TagState,
  activityOf: (group: GroupNode) => WorkspaceActivity,
): BrowserSection[] {
  return mode === 'tag' ? tagSections(groups, state) : statusSections(groups, activityOf)
}
