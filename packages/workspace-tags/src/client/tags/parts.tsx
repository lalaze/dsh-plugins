/** Small tag pieces the sidebar rows and the overlays share. */
import { useSyncExternalStore, type ReactNode } from 'react'
import clsx from 'clsx'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import {
  IconCheckCircleOutlineRegular, IconDarkOutlineRegular, IconPlayOutlineRegular, IconTriangleRightFillRegular,
  IconWarningOutlineRegular, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { emptyTagState, type TagColor, type TagState, type WorkspaceTag } from '../../shared/tags.ts'
import type { TagRuntime, TagSnapshot, TagViewState } from './contract.ts'
import type { Attention, BrowserSection, RowActivity, SpaceActivity } from './sections.ts'
import css from './tags.module.css'

type Translate = (key: never, vars?: Record<string, string | number>) => string
/** The browser's `workspace` translator, narrowed to what these parts need. */
export type TagTranslate = (key: string, vars?: Record<string, string | number>) => string
export const asTagTranslate = (t: Translate) => t as unknown as TagTranslate

const colorClass: Record<TagColor, string> = {
  gray: css.gray!, red: css.red!, orange: css.orange!, yellow: css.yellow!, green: css.green!,
  teal: css.teal!, blue: css.blue!, purple: css.purple!, pink: css.pink!,
  amber: css.amber!, lime: css.lime!, emerald: css.emerald!, cyan: css.cyan!, sky: css.sky!,
  indigo: css.indigo!, violet: css.violet!, fuchsia: css.fuchsia!, rose: css.rose!,
}

/** 16px outline tag glyph in the primitives' icon style. */
export function TagIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2.5 3.5v3.586a1 1 0 0 0 .293.707l5.914 5.914a1 1 0 0 0 1.414 0l3.586-3.586a1 1 0 0 0 0-1.414L7.793 2.793A1 1 0 0 0 7.086 2.5H3.5a1 1 0 0 0-1 1Z"
        stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"
      />
      <circle cx="5.5" cy="5.5" r="1" fill="currentColor" />
    </svg>
  )
}

export function TagDot({ color, className }: { color: TagColor; className?: string }) {
  return <span className={clsx(css.dot, colorClass[color], className)} aria-hidden="true" />
}

/** A Workspace row's tags: a few dots, then a count. */
export function TagDots({ tags, t }: { tags: readonly WorkspaceTag[]; t: TagTranslate }) {
  if (tags.length === 0) return null
  const names = tags.map(tag => tag.name).join(', ')
  const shown = tags.slice(0, 4)
  return (
    <span className={css.rowDots} role="img" aria-label={t('tags.row.aria', { names })} title={names}>
      {shown.map(tag => <TagDot key={tag.id} color={tag.color} />)}
      {tags.length > shown.length && <span className={css.more}>+{tags.length - shown.length}</span>}
    </span>
  )
}

/** How many Sessions need the user, tinted for waiting when any does: the switcher's and folded rows' badge. */
function AttentionBadge({ attention }: { attention: Attention }) {
  return (
    <span className={clsx(css.countBadge, attention.waiting > 0 ? css.waiting : css.completed)} aria-hidden="true">
      {attention.waiting + attention.completed}
    </span>
  )
}

function activityLabel({ waiting, completed }: Attention, t: TagTranslate): string {
  if (waiting > 0 && completed > 0) return t('tags.row.waitingCompleted', { waiting, completed })
  return waiting > 0 ? t('tags.row.waiting', { n: waiting }) : t('tags.row.completed', { n: completed })
}

/**
 * A Workspace row's trailing marks, which give way to the row's hover
 * actions. A folded row first shows what its Sessions' rows would: a badge
 * counting those that need the user, else the running spinner. Then come the
 * tag dots; the badge's shape keeps it apart from a tag of the same color.
 */
export function RowTrail({ activity, tags, t }: { activity: RowActivity | undefined; tags: readonly WorkspaceTag[]; t: TagTranslate }) {
  if (activity === undefined && tags.length === 0) return null
  const label = activity === undefined
    ? undefined
    : activity.waiting + activity.completed > 0 ? activityLabel(activity, t) : t('tags.section.running')
  return (
    <span className={css.rowTrail}>
      {activity !== undefined && (
        <span className={css.rowActivity} role="img" aria-label={label} title={label}>
          {activity.waiting + activity.completed > 0 ? <AttentionBadge attention={activity} /> : <StateDot state="ongoing" size={12} />}
        </span>
      )}
      <TagDots tags={tags} t={t} />
    </span>
  )
}

/**
 * The space switcher: All, then one chip per tag in name order. Picking a
 * tag narrows every grouping to its Workspaces; picking it again goes back
 * to All. A chip that is not selected carries a count of the Sessions in its
 * space that wait for the user or finished unread, tinted for waiting when
 * any does, and the running spinner while any of its Sessions runs, so a
 * filtered-out space still shows what goes on in it.
 */
export function SpaceSwitcher({ tags, filter, activity, onPick, t }: {
  tags: readonly WorkspaceTag[]
  filter: string | null
  activity: ReadonlyMap<string | null, SpaceActivity>
  onPick: (tagId: string | null) => void
  t: TagTranslate
}) {
  const chip = (id: string | null, name: string, marker: ReactNode) => {
    const selected = id === filter
    const count = activity.get(id) ?? { waiting: 0, completed: 0, running: 0 }
    const n = selected ? 0 : count.waiting + count.completed
    const running = !selected && count.running > 0
    const attention = n === 0 ? name : t(n === 1 ? 'tags.filter.attention.one' : 'tags.filter.attention.other', { name, n })
    const label = running ? t('tags.filter.running', { label: attention }) : attention
    return (
      <button
        key={id ?? ''}
        type="button"
        className={clsx(css.chip, selected && css.chipSelected)}
        aria-pressed={selected}
        aria-label={label}
        title={label}
        onClick={() => { onPick(selected ? null : id) }}
      >
        {marker}
        <span className={css.chipLabel}>{name}</span>
        {running && <StateDot state="ongoing" size={12} />}
        {n > 0 && <AttentionBadge attention={count} />}
      </button>
    )
  }
  return (
    <div className={css.switcher} role="group" aria-label={t('tags.filter.label')}>
      {chip(null, t('tags.filter.all'), null)}
      {tags.map(tag => chip(tag.id, tag.name, <TagDot color={tag.color} />))}
    </div>
  )
}

export function workspaceTags(state: TagState, workspaceId: string | undefined): WorkspaceTag[] {
  if (workspaceId === undefined) return []
  const byId = new Map(state.tags.map(tag => [tag.id, tag]))
  return (state.assignments[workspaceId] ?? []).flatMap(id => byId.get(id) ?? [])
}

const statusLabel = {
  running: 'tags.section.running', waiting: 'tags.section.waiting', completed: 'tags.section.completed', idle: 'tags.section.idle',
} as const

/** A glyph per status, so the sections differ by shape and not only by hue. */
const statusIcon = {
  running: IconPlayOutlineRegular, waiting: IconWarningOutlineRegular, completed: IconCheckCircleOutlineRegular, idle: IconDarkOutlineRegular,
} as const

function StatusIcon({ kind }: { kind: keyof typeof statusIcon }) {
  const Icon = statusIcon[kind]
  return <Icon size={16} className={css[kind]} />
}

/** One Tag or Status section: a fold header over its Workspace groups. */
export function SectionBlock({ section, collapsed, onToggle, t, children }: {
  section: BrowserSection
  collapsed: boolean
  onToggle: () => void
  t: TagTranslate
  children: ReactNode
}) {
  const label = section.kind === 'tag'
    ? section.tag!.name
    : section.kind === 'untagged' ? t('tags.section.untagged') : t(statusLabel[section.kind])
  const marker = section.kind === 'tag'
    ? <TagDot color={section.tag!.color} />
    : section.kind === 'untagged'
      ? <span className={clsx(css.dot, css.hollow)} aria-hidden="true" />
      : <StatusIcon kind={section.kind} />
  return (
    <div className={css.section} role="group" aria-label={label} data-section-key={section.key}>
      <button type="button" className={css.sectionHeader} aria-expanded={!collapsed} onClick={onToggle}>
        <IconTriangleRightFillRegular className={clsx(css.sectionArrow, !collapsed && css.sectionArrowOpen)} />
        <span className={css.sectionMarker} aria-hidden="true">{marker}</span>
        <span className={css.sectionLabel}>{label}</span>
        <span className={css.sectionCount}>{section.count}</span>
      </button>
      {!collapsed && children}
    </div>
  )
}

const emptyTags: HostObservable<TagSnapshot> = { getSnapshot: () => EMPTY_SNAPSHOT, subscribe: () => () => {} }
const emptyView: HostObservable<TagViewState> = { getSnapshot: () => EMPTY_VIEW, subscribe: () => () => {} }
const EMPTY_SNAPSHOT: TagSnapshot = { phase: 'ready', state: emptyTagState() }
const EMPTY_VIEW: TagViewState = { mode: null, collapsed: {}, filter: null }

/**
 * Tag state for the browser. Upstream's own specs build the browser without
 * a runtime; they then see no tags and the stock Group by choices.
 */
export function useTagging(runtime: TagRuntime | undefined): { snapshot: TagSnapshot; view: TagViewState } {
  const tags = runtime?.tags ?? emptyTags
  const view = runtime?.view ?? emptyView
  return {
    snapshot: useSyncExternalStore(tags.subscribe, tags.getSnapshot),
    view: useSyncExternalStore(view.subscribe, view.getSnapshot),
  }
}
