/** Small tag pieces the sidebar rows and the overlays share. */
import { useSyncExternalStore, type ReactNode } from 'react'
import clsx from 'clsx'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import { IconGaugeOutlineRegular, IconTriangleRightFillRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { emptyTagState, type TagColor, type TagState, type WorkspaceTag } from '../../shared/tags.ts'
import type { TagRuntime, TagSnapshot, TagViewState } from './contract.ts'
import type { BrowserSection } from './sections.ts'
import css from './tags.module.css'

type Translate = (key: never, vars?: Record<string, string | number>) => string
/** The browser's `workspace` translator, narrowed to what these parts need. */
export type TagTranslate = (key: string, vars?: Record<string, string | number>) => string
export const asTagTranslate = (t: Translate) => t as unknown as TagTranslate

const colorClass: Record<TagColor, string> = {
  gray: css.gray!, red: css.red!, orange: css.orange!, yellow: css.yellow!, green: css.green!,
  teal: css.teal!, blue: css.blue!, purple: css.purple!, pink: css.pink!,
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

export function workspaceTags(state: TagState, workspaceId: string | undefined): WorkspaceTag[] {
  if (workspaceId === undefined) return []
  const byId = new Map(state.tags.map(tag => [tag.id, tag]))
  return (state.assignments[workspaceId] ?? []).flatMap(id => byId.get(id) ?? [])
}

const statusLabel = { running: 'tags.section.running', waiting: 'tags.section.waiting', idle: 'tags.section.idle' } as const

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
      : <span className={clsx(css.statusIcon, css[section.kind])} aria-hidden="true"><IconGaugeOutlineRegular size={14} /></span>
  return (
    <div className={css.section} role="group" aria-label={label} data-section-key={section.key}>
      <button type="button" className={css.sectionHeader} aria-expanded={!collapsed} onClick={onToggle}>
        <IconTriangleRightFillRegular className={clsx(css.sectionArrow, !collapsed && css.sectionArrowOpen)} />
        {marker}
        <span className={css.sectionLabel}>{label}</span>
        <span className={css.sectionCount}>{section.groups.length}</span>
      </button>
      {!collapsed && children}
    </div>
  )
}

const emptyTags: HostObservable<TagSnapshot> = { getSnapshot: () => EMPTY_SNAPSHOT, subscribe: () => () => {} }
const emptyView: HostObservable<TagViewState> = { getSnapshot: () => EMPTY_VIEW, subscribe: () => () => {} }
const EMPTY_SNAPSHOT: TagSnapshot = { phase: 'ready', state: emptyTagState() }
const EMPTY_VIEW: TagViewState = { mode: null, collapsed: {} }

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
