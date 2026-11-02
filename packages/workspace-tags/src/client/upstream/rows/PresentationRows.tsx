import { cloneElement, isValidElement, useEffect, useRef, useState, type ReactNode } from 'react'
import { IconFolderCloseRegular, IconChevronsUpDownOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { rowActivity, type RowActivity } from '../../tags/sections.ts'
import { SectionBlock } from '../../tags/parts.tsx'
import type { TagState } from '../../../shared/tags.ts'
import type { GroupNode } from '../tree.ts'
import { owningParentFolder } from '../tree.ts'
import { sectionPresentation, type MirrorContribution, type PresentedGroup, type PresentedSession, type PresentedSection, type PresentationFilter } from '../presentation.ts'
import type { SectionMode } from '../../tags/contract.ts'
import css from './PresentationRows.module.css'

export interface PresentationContext {
  all: readonly PresentedGroup[]; groups: readonly PresentedGroup[]; tags: TagState
  incomplete: boolean; provider: MirrorContribution | null; labels: { untitled: string }; filter: PresentationFilter; filterKey: string
}
export function PresentedRow({ row, context, children, rejectDrag }: { row: PresentedSession | PresentedGroup; context: PresentationContext; children: ReactNode; rejectDrag?: (drop: boolean) => void }) {
  const remote = row.owner === 'mirror'
  const deviceId = 'deviceId' in row ? row.deviceId : row.owner === 'mirror' ? row.mirror.deviceId : context.provider?.localDevice.deviceId
  const original = 'native' in row ? ('workspaceId' in row.native ? row.native.workspaceId : 'id' in row.native ? row.native.id : undefined) : row.mirror && ('sessionId' in row.mirror ? row.mirror.sessionId : row.mirror.workspaceId)
  if (!remote && isValidElement<Record<string, unknown>>(children) && typeof children.type === 'string') {
    return cloneElement(children, { 'data-presentation-kind': 'local', 'data-owner': deviceId, 'data-original-id': original, 'data-presentation-key': row.canonicalKey, title: 'ownerName' in row ? row.ownerName : context.provider?.localDevice.name })
  }
  return <div style={{ display: 'contents' }} data-presentation-kind={remote ? 'mirror' : 'local'} data-owner={deviceId} data-original-id={original} data-presentation-key={row.canonicalKey}
    onDragOver={remote ? event => { event.preventDefault(); event.stopPropagation(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'none'; rejectDrag?.(false) } : undefined}
    onDrop={remote ? event => { event.preventDefault(); event.stopPropagation(); rejectDrag?.(true) } : undefined}>
    {children}
  </div>
}
export function MirrorSessionRow({ session, context, rejectDrag }: { session: PresentedSession & { owner: 'mirror' }; context: PresentationContext; rejectDrag?: (drop: boolean) => void }) {
  const value = session.mirror
  const selected = context.provider?.activeSession
  return <PresentedRow row={session} context={context} rejectDrag={rejectDrag}>
    <button className={css.session} type="button" role="treeitem" draggable={false}
      data-row-key={session.key} aria-selected={selected?.deviceId === value.deviceId && selected.sessionId === value.sessionId} aria-current={selected?.deviceId === value.deviceId && selected.sessionId === value.sessionId ? 'true' : undefined}
      title={`${value.ownerName} · ${value.connection}`} onClick={() => context.provider?.openSession(value.deviceId, value.sessionId)}>
      <span aria-hidden="true" className={css.state}>{session.waiting ? '◉' : session.running ? '●' : '·'}</span>
      <span className={css.title}>{session.title || context.labels.untitled}</span>
    </button>
  </PresentedRow>
}

/** Native rows are supplied as already-typed, local-only render callbacks; mirrors never enter those callbacks. */
export function usePresentationGroups({ context, mode, nested, renderLocal, nativeExpanded, collapsed, setCollapsed, empty, rejectDrag, label }: {
  context: PresentationContext; mode: SectionMode | null; nested: boolean
  renderLocal(group: GroupNode, depth: number, children: ReactNode, section?: { key: string; active: boolean; running: boolean; toggle(): void; activity: RowActivity | undefined }): ReactNode
  nativeExpanded(group: GroupNode): boolean
  collapsed: Readonly<Record<string, boolean>>; setCollapsed(key: string, value: boolean): void
  empty: ReactNode; rejectDrag(drop: boolean): void
  label(key: string): string
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [sectionFolds, setSectionFolds] = useState<Record<string, boolean>>({})
  const [pins, setPins] = useState<Record<string, { groupKey: string; token: string; sectionKey?: string; kind?: PresentedSection['kind']; tagId?: string }>>({})
  const current = context.provider?.activeSession
  const revealedSelection = useRef<string>()
  useEffect(() => {
    if (!current) { revealedSelection.current = undefined; return }
    const group = context.all.find(g => g.owner === 'mirror' && g.sessions.some(s => s.owner === 'mirror' && s.mirror.deviceId === current.deviceId && s.mirror.sessionId === current.sessionId))
    if (!group) return
    const token = JSON.stringify([current.deviceId, current.sessionId, group.key])
    if (revealedSelection.current === token) return
    revealedSelection.current = token
    setExpanded(old => old[group.key] === true ? old : { ...old, [group.key]: true })
    setSectionFolds(old => {
      const keys = Object.keys(old).filter(key => key.endsWith(`/${group.key}`) && old[key])
      if (!keys.length) return old
      const next = { ...old }; for (const key of keys) delete next[key]
      return next
    })
  }, [current?.deviceId, current?.sessionId, context.all])
  const groups = [...context.groups]
  for (const pin of Object.values(pins)) {
    if (pin.token !== context.filterKey || groups.some(group => group.key === pin.groupKey)) continue
    const group = context.all.find(g => g.owner === 'mirror' && g.key === pin.groupKey)
    if (group?.owner === 'mirror' && group.mirror?.connection !== 'unpaired') groups.push({ ...group, sessions: [] })
  }
  const parents = new Map<string, string>()
  if (nested && mode === null) for (const group of groups) {
    if (!group.displayPath) continue
    const owners = groups.filter(other => other.deviceId === group.deviceId && other.key !== group.key && other.displayPath)
    const parentPath = owningParentFolder(group.displayPath, owners.map(owner => owner.displayPath))
    const parent = owners.find(owner => owner.displayPath === parentPath)
    if (parent) parents.set(group.key, parent.key)
  }
  const renderGroup = (group: PresentedGroup, depth: number, section?: { key: string; active: boolean; running: boolean; toggle(): void; kind: PresentedSection['kind']; tagId?: string }): ReactNode => {
    const children = groups.filter(g => parents.get(g.key) === group.key)
    const sectionKey = section ? `${section.key}/${group.key}` : group.key
    const open = section?.active ? !sectionFolds[sectionKey] : group.owner === 'local' ? nativeExpanded(group.native) : expanded[group.key] ?? children.length > 0
    const childRows = open && children.length ? children.map(child => renderGroup(child, depth + 1)) : null
    if (group.owner === 'local') {
      const sessions = group.sessions.flatMap(session => session.owner === 'local' ? [session.native] : [])
      const native = { ...group.native, expanded: open, sessionCount: sessions.length, sessions: open ? sessions : [] }
      return <PresentedRow key={group.key} row={group} context={context}>{renderLocal(native, depth, childRows, section ? { ...section, activity: rowActivity(sessions), toggle: () => setSectionFolds(old => ({ ...old, [sectionKey]: open })) } : undefined)}</PresentedRow>
    }
    const actor = sectionKey
    const workspace = group.mirror
    return <PresentedRow key={group.key} row={group} context={context} rejectDrag={rejectDrag}>
      <div className={css.group} style={{ paddingInlineStart: depth * 12 }} data-row-key={group.key}>
        <button className={css.workspace} type="button" role="treeitem" aria-expanded={open} draggable={false}
          title={`${group.ownerName} · ${workspace?.connection ?? ''}\n${group.displayPath}\n${label('unified.ownerActions')}`}
          onClick={() => section?.active ? setSectionFolds(old => ({ ...old, [sectionKey]: open })) : setExpanded(old => ({ ...old, [group.key]: !open }))}>
          <span className={css.folderIcon} aria-hidden="true"><IconFolderCloseRegular /><span className={css.chevron}>{open ? '▾' : '▸'}</span></span>
          <span className={css.title}>{group.title || label('unified.ungrouped')}</span>
        </button>
        {workspace && <div className={css.tags}>{context.tags.tags.filter(tag => group.tagIds.includes(tag.id)).map(tag => tag.name).join(' · ') || label('unified.untagged')}</div>}
        {open && <>
          {workspace && context.provider?.renderTagEditor({ deviceId: workspace.deviceId, workspaceId: workspace.workspaceId, filterKey: context.filterKey,
            onEditingChange: editing => setPins(old => {
              if (editing) return { ...old, [actor]: { groupKey: group.key, token: context.filterKey, ...(section ? { sectionKey: section.key, kind: section.kind, ...(section.tagId ? { tagId: section.tagId } : {}) } : {}) } }
              if (old[actor]?.token !== context.filterKey) return old
              const next = { ...old }; delete next[actor]; return next
            }) })}
          {childRows && <div role="group">{childRows}</div>}
          <MirrorSessions sessions={group.sessions} context={context} rejectDrag={rejectDrag} label={label} />
        </>}
      </div>
    </PresentedRow>
  }
  if (mode === null) return <>{groups.length ? groups.filter(group => !parents.has(group.key)).map(group => renderGroup(group, 0)) : context.incomplete ? null : empty}</>
  const sections = sectionPresentation(groups, context.tags, mode)
  for (const pin of Object.values(pins)) {
    if (pin.token !== context.filterKey || !pin.sectionKey || !pin.kind) continue
    const group = groups.find(g => g.key === pin.groupKey)
    if (!group) continue
    let section = sections.find(s => s.key === pin.sectionKey)
    if (!section) { section = { key: pin.sectionKey, kind: pin.kind, groups: [], count: 0, ...(pin.tagId ? { tagId: pin.tagId } : {}) }; sections.push(section) }
    if (!section.groups.some(g => g.key === group.key)) { section.groups.push({ ...group, sessions: [] }); section.count++ }
  }
  return <>{sections.length ? sections.map(section => {
    const folded = collapsed[section.key] ?? section.kind === 'idle'
    const tag = context.tags.tags.find(tag => tag.id === section.tagId)
    return <SectionBlock key={section.key} section={{ key: section.key, kind: section.kind, count: section.count, ...(tag ? { tag } : {}) }} collapsed={folded} onToggle={() => setCollapsed(section.key, !folded)} t={label}>
      {section.groups.map(group => renderGroup(group, 0, { key: section.key, kind: section.kind, ...(section.tagId ? { tagId: section.tagId } : {}), active: !['tag', 'untagged', 'idle'].includes(section.kind), running: section.kind === 'running', toggle: () => {} }))}
    </SectionBlock>
  }) : context.incomplete ? null : empty}</>
}
function MirrorSessions({ sessions, context, rejectDrag, label }: { sessions: readonly PresentedSession[]; context: PresentationContext; rejectDrag(drop: boolean): void; label(key: string): string }) {
  const [limit, setLimit] = useState(5)
  const current = context.provider?.activeSession
  const required = sessions.findIndex(s => s.owner === 'mirror' && current?.deviceId === s.mirror.deviceId && current.sessionId === s.mirror.sessionId) + 1
  const visible = Math.max(limit, required, Math.min(50, sessions.reduce((last, s, index) => s.running || s.waiting ? index + 1 : last, 0)))
  return <>{sessions.slice(0, visible).map(session => session.owner === 'mirror' ? <MirrorSessionRow key={session.key} session={session} context={context} rejectDrag={rejectDrag} /> : null)}
    {sessions.length > visible && <button className={css.more} type="button" onClick={() => setLimit(visible + 5)}><IconChevronsUpDownOutlineRegular />{label('unified.more')} ({sessions.length - visible})</button>}
  </>
}
