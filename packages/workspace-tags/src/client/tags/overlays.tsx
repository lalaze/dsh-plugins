/**
 * `shell.overlay` entries: the tag checklist a Workspace row's right-click or
 * "Tags…" opens, and one dialog for creating, editing and managing tags.
 * They live in the frame-wide layer so they outlive the row that asked.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  Button, IconCheckOutlineRegular, IconEditOutlineRegular, IconPlusOutlineRegular,
  IconSettingsOutlineRegular, IconTrashOutlineRegular, Menu, Modal, type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, PropsHooks, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { TAG_COLORS, TAG_NAME_MAX, TagError, tagName, type TagColor, type WorkspaceTag } from '../../shared/tags.ts'
import type { TagDialogRequest, TagMenuRequest, TagRuntime, TagSnapshot } from './contract.ts'
import { TagDot, type TagTranslate } from './parts.tsx'
import css from './tags.module.css'

export interface TagOverlayInjected {
  hooks: {
    tagMenu: HostObservable<TagMenuRequest | null>
    tagDialog: HostObservable<TagDialogRequest | null>
    workspaceTags: HostObservable<TagSnapshot>
  }
  run: TagRuntime['run']
  openMenu: TagRuntime['openMenu']
  openDialog: TagRuntime['openDialog']
}

export type TagOverlayProps =
  PropsRuntime<'shell.overlay'>
  & Omit<TagOverlayInjected, 'hooks'>
  & PropsHooks<TagOverlayInjected['hooks']>
  & PropsLocale<'workspace'>

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
const byName = (tags: readonly WorkspaceTag[]) => [...tags].sort((a, b) => collator.compare(a.name, b.name))
const message = (error: unknown) => error instanceof Error ? error.message : String(error)

/** Workspace titles by id, as the sidebar shows them. */
function useWorkspaceTitles(useWorkspaces: TagOverlayProps['useWorkspaces']): ReadonlyMap<string, string> {
  const items = useWorkspaces(state => state.items)
  return useMemo(() => new Map(items.map(item => [item.workspaceId as string, item.title])), [items])
}

export function TagMenuOverlay({ useTagMenu, useWorkspaceTags, useWorkspaces, run, openMenu, openDialog, t }: TagOverlayProps) {
  const request = useTagMenu(value => value)
  if (request === null) return null
  return (
    <TagMenu
      key={`${request.workspaceId}/${request.anchor.x}/${request.anchor.y}`}
      request={request}
      useWorkspaceTags={useWorkspaceTags}
      useWorkspaces={useWorkspaces}
      run={run}
      openMenu={openMenu}
      openDialog={openDialog}
      t={t as unknown as TagTranslate}
    />
  )
}

function TagMenu({ request, useWorkspaceTags, useWorkspaces, run, openMenu, openDialog, t }:
  Pick<TagOverlayProps, 'useWorkspaceTags' | 'useWorkspaces' | 'run' | 'openMenu' | 'openDialog'> & { request: TagMenuRequest; t: TagTranslate }) {
  const snapshot = useWorkspaceTags(value => value)
  const title = useWorkspaceTitles(useWorkspaces).get(request.workspaceId) ?? ''
  // Toggles show at once and settle when the host answers.
  const [pending, setPending] = useState<ReadonlyMap<string, boolean>>(new Map())
  const [error, setError] = useState<string | null>(null)
  const assigned = new Set(snapshot.state.assignments[request.workspaceId] ?? [])
  for (const [id, value] of pending) if (value) assigned.add(id); else assigned.delete(id)
  const tags = byName(snapshot.state.tags)
  const close = () => { openMenu(null) }
  const status: MenuEntry[] = snapshot.phase === 'loading' && tags.length === 0
    ? [{ id: 'status', label: t('tags.menu.loading'), disabled: true }]
    : snapshot.phase === 'error'
      ? [{ id: 'status', label: <span className={css.menuError}>{t('tags.menu.loadFailed')}</span>, disabled: true }]
      : tags.length === 0 ? [{ id: 'status', label: t('tags.menu.empty'), disabled: true }] : []
  const items: MenuEntry[] = [
    { type: 'label', id: 'heading', text: t('tags.menu.label', { name: title }) },
    ...tags.map(tag => ({ id: `tag:${tag.id}`, label: tag.name, icon: <TagDot color={tag.color} /> })),
    ...status,
    ...error === null ? [] : [{ id: 'error', label: <span className={css.menuError}>{error}</span>, disabled: true }],
    { type: 'separator', id: 'actions' },
    { id: 'new', label: t('tags.menu.new'), icon: <IconPlusOutlineRegular /> },
    ...tags.length === 0 ? [] : [{ id: 'manage', label: t('tags.menu.manage'), icon: <IconSettingsOutlineRegular /> }],
  ]
  const toggle = (tagId: string) => {
    const next = !assigned.has(tagId)
    setError(null)
    setPending(current => new Map(current).set(tagId, next))
    run({ op: 'assign', workspaceId: request.workspaceId, tagId, assigned: next })
      .catch((reason: unknown) => { setError(message(reason)) })
      .finally(() => {
        setPending((current) => {
          const rest = new Map(current)
          rest.delete(tagId)
          return rest
        })
      })
  }
  const { x, y, width, height } = request.anchor
  return (
    <Menu
      open
      anchor={<span className={css.menuAnchor} />}
      portal
      getAnchorRect={() => new DOMRect(x, y, width, height)}
      items={items}
      selectedIds={[...assigned].map(id => `tag:${id}`)}
      onSelect={(id) => {
        if (id.startsWith('tag:')) { toggle(id.slice(4)); return }
        close()
        if (id === 'new') openDialog({ kind: 'create', assignTo: request.workspaceId, workspaceTitle: title })
        if (id === 'manage') openDialog({ kind: 'manage' })
      }}
      onClose={close}
      dense
      autoFocus
    />
  )
}

export function TagDialogOverlay({ useTagDialog, useWorkspaceTags, useWorkspaces, run, openDialog, t }: TagOverlayProps) {
  const request = useTagDialog(value => value)
  const snapshot = useWorkspaceTags(value => value)
  const titles = useWorkspaceTitles(useWorkspaces)
  const translate = t as unknown as TagTranslate
  if (request === null) return null
  const close = () => { openDialog(null) }
  if (request.kind === 'manage') {
    return <ManageTags tags={snapshot.state.tags} assignments={snapshot.state.assignments} titles={titles} run={run} openDialog={openDialog} onClose={close} t={translate} />
  }
  const editing = request.kind === 'edit' ? snapshot.state.tags.find(tag => tag.id === request.tagId) : undefined
  // A tag deleted elsewhere while its editor was open: nothing left to edit.
  if (request.kind === 'edit' && editing === undefined) return null
  const back = () => { openDialog(request.kind === 'edit' && request.back === 'manage' ? { kind: 'manage' } : null) }
  return (
    <TagForm
      key={request.kind === 'edit' ? request.tagId : `create/${request.assignTo ?? ''}`}
      tags={snapshot.state.tags}
      editing={editing}
      assignTo={request.kind === 'create' ? request.assignTo : undefined}
      workspaceTitle={request.kind === 'create' ? request.workspaceTitle : undefined}
      run={run}
      onDone={back}
      onCancel={back}
      t={translate}
    />
  )
}

function TagForm({ tags, editing, assignTo, workspaceTitle, run, onDone, onCancel, t }: {
  tags: readonly WorkspaceTag[]
  editing: WorkspaceTag | undefined
  assignTo: string | undefined
  workspaceTitle: string | undefined
  run: TagRuntime['run']
  onDone: () => void
  onCancel: () => void
  t: TagTranslate
}) {
  const [name, setName] = useState(editing?.name ?? '')
  // New tags take the first color no tag uses yet.
  const [color, setColor] = useState<TagColor>(editing?.color ?? TAG_COLORS.find(c => !tags.some(tag => tag.color === c)) ?? 'blue')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const composing = useRef(false)
  let problem: 'empty' | 'duplicate' | null = null
  try { tagName(name, tags, editing?.id) }
  catch (reason) { problem = name.trim() === '' ? 'empty' : reason instanceof TagError && /already exists/.test(reason.message) ? 'duplicate' : null }
  const unchanged = editing !== undefined && editing.name === name.trim() && editing.color === color
  const blocked = saving || problem !== null || unchanged
  const submit = () => {
    if (blocked) return
    setSaving(true)
    setError(null)
    const operation = editing === undefined
      ? { op: 'create' as const, name, color, ...assignTo === undefined ? {} : { assignTo } }
      : { op: 'update' as const, id: editing.id, name, color }
    run(operation).then(onDone).catch((reason: unknown) => {
      setSaving(false)
      setError(message(reason))
    })
  }
  return (
    <Modal
      open
      onClose={() => { if (!saving) onCancel() }}
      closeLabel={t('close')}
      title={editing === undefined ? t('tags.editor.createTitle') : t('tags.editor.editTitle')}
      footer={(
        <>
          <Button variant="outline" disabled={saving} onClick={onCancel}>{t('cancel')}</Button>
          <Button variant="primary" disabled={blocked} onClick={submit}>
            {editing === undefined ? t('tags.editor.create') : t('tags.editor.save')}
          </Button>
        </>
      )}
    >
      <label className={css.field}>
        <span className={css.fieldLabel}>{t('tags.editor.name')}</span>
        <input
          className={css.nameInput}
          value={name}
          maxLength={TAG_NAME_MAX}
          data-modal-autofocus
          disabled={saving}
          onFocus={(e) => { e.target.select() }}
          onChange={(e) => { setName(e.target.value); setError(null) }}
          onCompositionStart={() => { composing.current = true }}
          onCompositionEnd={() => { composing.current = false }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !composing.current) { e.preventDefault(); submit() }
          }}
        />
      </label>
      <div className={css.field}>
        <span className={css.fieldLabel} id="dsh-workspace-tags-color">{t('tags.editor.color')}</span>
        <div className={css.swatches} role="radiogroup" aria-labelledby="dsh-workspace-tags-color">
          {TAG_COLORS.map(option => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={option === color}
              aria-label={t(`tags.color.${option}`)}
              title={t(`tags.color.${option}`)}
              className={clsx(css.swatch, css[option])}
              disabled={saving}
              onClick={() => { setColor(option) }}
            >
              <TagDot color={option} />
            </button>
          ))}
        </div>
      </div>
      {workspaceTitle !== undefined && workspaceTitle !== '' && (
        <div className={css.hint}>{t('tags.editor.assignHint', { name: workspaceTitle })}</div>
      )}
      {problem === 'duplicate' && <div className={css.error} role="alert">{t('tags.editor.duplicate', { name: name.trim() })}</div>}
      {error !== null && <div className={css.error} role="alert">{error}</div>}
    </Modal>
  )
}

function ManageTags({ tags, assignments, titles, run, openDialog, onClose, t }: {
  tags: readonly WorkspaceTag[]
  assignments: Readonly<Record<string, readonly string[]>>
  titles: ReadonlyMap<string, string>
  run: TagRuntime['run']
  openDialog: TagRuntime['openDialog']
  onClose: () => void
  t: TagTranslate
}) {
  const [confirming, setConfirming] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Assignments of Workspaces deleted elsewhere do not count.
  const counts = new Map<string, number>()
  for (const [workspaceId, ids] of Object.entries(assignments)) {
    if (!titles.has(workspaceId)) continue
    for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  useEffect(() => { if (confirming !== null && !tags.some(tag => tag.id === confirming)) setConfirming(null) }, [confirming, tags])
  const remove = (tag: WorkspaceTag) => {
    setDeleting(true)
    setError(null)
    run({ op: 'delete', id: tag.id }).then(() => { setConfirming(null) })
      .catch((reason: unknown) => { setError(message(reason)) })
      .finally(() => { setDeleting(false) })
  }
  return (
    <Modal
      open
      onClose={() => { if (!deleting) onClose() }}
      closeLabel={t('close')}
      title={t('tags.manage.title')}
      footer={(
        <>
          <Button variant="outline" disabled={deleting} onClick={() => { openDialog({ kind: 'create' }) }}>
            <IconPlusOutlineRegular /> {t('tags.manage.new')}
          </Button>
          <Button variant="primary" disabled={deleting} onClick={onClose}>{t('tags.manage.done')}</Button>
        </>
      )}
    >
      {tags.length === 0
        ? <div className={css.empty}>{t('tags.manage.empty')}</div>
        : (
          <ul className={css.manageList}>
            {byName(tags).map(tag => tag.id === confirming
              ? (
                <li key={tag.id} className={clsx(css.manageRow, css.confirmRow)}>
                  <span className={css.confirmText}>{t('tags.manage.confirmDelete', { name: tag.name })}</span>
                  <span className={css.confirmActions}>
                    <Button variant="outline" disabled={deleting} onClick={() => { setConfirming(null) }}>{t('cancel')}</Button>
                    <Button variant="outline" disabled={deleting} onClick={() => { remove(tag) }}>
                      <IconCheckOutlineRegular /> {t('tags.manage.confirm')}
                    </Button>
                  </span>
                </li>
              )
              : (
                <li key={tag.id} className={css.manageRow}>
                  <TagDot color={tag.color} />
                  <span className={css.manageName}>{tag.name}</span>
                  <span className={css.manageCount}>{t((counts.get(tag.id) ?? 0) === 1 ? 'tags.manage.count.one' : 'tags.manage.count.other', { n: counts.get(tag.id) ?? 0 })}</span>
                  <button
                    type="button"
                    className={css.iconButton}
                    aria-label={t('tags.manage.edit', { name: tag.name })}
                    disabled={deleting}
                    onClick={() => { openDialog({ kind: 'edit', tagId: tag.id, back: 'manage' }) }}
                  >
                    <IconEditOutlineRegular />
                  </button>
                  <button
                    type="button"
                    className={clsx(css.iconButton, css.danger)}
                    aria-label={t('tags.manage.delete', { name: tag.name })}
                    disabled={deleting}
                    onClick={() => { setError(null); setConfirming(tag.id) }}
                  >
                    <IconTrashOutlineRegular />
                  </button>
                </li>
              ))}
          </ul>
        )}
      {error !== null && <div className={css.error} role="alert">{error}</div>}
    </Modal>
  )
}
