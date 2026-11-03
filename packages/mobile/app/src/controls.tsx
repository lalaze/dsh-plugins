/** Shared controls: bottom sheets, composer pills, option rows, switches, icons, and the model and permission pickers. */
import React, { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ModelChoices, ModelSelection, WorkspaceEntry } from '../../src/shared/protocol.js'
import { ui } from './i18n.js'
import { LUCIDE } from './lucide.js'
import { openOverlay } from './nav.js'

/** Close an overlay with the phone's back gesture, as well as with its own controls. */
export function useBackClose(onClose: () => void) {
  const latest = useRef(onClose)
  latest.current = onClose
  useEffect(() => openOverlay(() => latest.current()), [])
}

/** A bottom sheet. Back, a tap outside, Escape, or dragging its top edge down closes it. */
export function Sheet({ title, onClose, children, className }: { title?: ReactNode; onClose(): void; children: ReactNode; className?: string }) {
  useBackClose(onClose)
  const sheet = useRef<HTMLDivElement>(null)
  const drag = useRef<{ y: number; dy: number } | undefined>(undefined)
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    addEventListener('keydown', key)
    return () => removeEventListener('keydown', key)
  }, [onClose])
  const move = (dy: number) => { if (sheet.current) sheet.current.style.transform = dy > 0 ? `translateY(${dy}px)` : '' }
  return <div className="sheet-backdrop" onClick={event => { if (event.target === event.currentTarget) onClose() }}>
    <div ref={sheet} className={`sheet${className ? ` ${className}` : ''}`} role="dialog" aria-label={typeof title === 'string' ? title : undefined}>
      <div className="sheet-handle"
        onTouchStart={event => { drag.current = { y: event.touches[0].clientY, dy: 0 }; if (sheet.current) sheet.current.style.transition = 'none' }}
        onTouchMove={event => { if (!drag.current) return; drag.current.dy = event.touches[0].clientY - drag.current.y; move(drag.current.dy) }}
        onTouchEnd={() => {
          const dy = drag.current?.dy ?? 0
          drag.current = undefined
          if (sheet.current) sheet.current.style.transition = ''
          if (dy > 80) onClose(); else move(0)
        }}>
        <div className="sheet-grip" />
        {title && <div className="sheet-title">{title}</div>}
      </div>
      <div className="sheet-body">{children}</div>
    </div>
  </div>
}

export function Pill({ icon, label, onClick, open, title }: { icon?: ReactNode; label: string; onClick?(): void; open?: boolean; title?: string }) {
  return <button type="button" className="pill" onClick={onClick} disabled={!onClick} aria-expanded={open} aria-label={title ? `${title}: ${label}` : label}>
    {icon}<span>{label}</span>{onClick && icons.chevronDown}
  </button>
}

export function Option({ checked, label, description, icon, danger, onClick }: { checked?: boolean; label: string; description?: string; icon?: ReactNode; danger?: boolean; onClick(): void }) {
  return <button type="button" className={`sheet-item${danger ? ' danger' : ''}`} role={checked === undefined ? 'menuitem' : 'menuitemradio'} aria-checked={checked} onClick={onClick}>
    {icon && <span className="sheet-icon">{icon}</span>}
    <span className="sheet-text"><span>{label}</span>{description && <span className="desc">{description}</span>}</span>
    {checked && <span className="check">{icons.check}</span>}
  </button>
}

/** A labelled on/off switch row. */
export function Toggle({ label, description, checked, onChange, disabled }: { label: string; description?: string; checked: boolean; onChange(value: boolean): void; disabled?: boolean }) {
  return <label className="toggle-row">
    <span className="sheet-text"><span>{label}</span>{description && <span className="desc">{description}</span>}</span>
    <input type="checkbox" role="switch" className="switch" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} />
  </label>
}

/** A copy button that confirms with a check mark for a moment. */
export function CopyButton({ text, label, className }: { text: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false)
  return <button type="button" className={className ?? 'icon-button'} aria-label={ui('Copy')} onClick={event => {
    event.stopPropagation()
    void copyText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400) })
  }}>{copied ? icons.check : icons.copy}{label && <span>{copied ? ui('Copied') : label}</span>}</button>
}

/** Copy to the clipboard, also where the async clipboard API is missing (plain HTTP on a LAN address). */
export async function copyText(text: string): Promise<void> {
  try { await navigator.clipboard.writeText(text); return } catch { /* fall back */ }
  const area = document.createElement('textarea')
  area.value = text; area.setAttribute('readonly', ''); area.style.position = 'fixed'; area.style.opacity = '0'
  document.body.appendChild(area); area.select()
  try { document.execCommand('copy') } finally { area.remove() }
}

/** A short buzz on phones that can, for actions that take effect at once. */
export const haptic = () => { try { navigator.vibrate?.(8) } catch { /* not supported */ } }

/** A Lucide icon at a size, in the current text colour; `fill` paints it solid. */
const icon = (size: number, name: keyof typeof LUCIDE, fill = false) => <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true"
  fill={fill ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
  {LUCIDE[name].map(([tag, attributes], index) => React.createElement(tag, { key: index, ...attributes }))}
</svg>

/** Every icon of the app, from Lucide (the set Paseo's app uses). */
export const icons = {
  folder: icon(15, 'folder'),
  model: icon(14, 'sparkle'),
  brain: icon(14, 'brain'),
  shield: icon(14, 'shield'),
  computer: icon(14, 'monitor'),
  back: icon(24, 'chevron-left'),
  more: icon(22, 'ellipsis'),
  search: icon(21, 'search'),
  filter: icon(19, 'list-filter'),
  gear: icon(21, 'settings'),
  plus: icon(20, 'plus'),
  close: icon(20, 'x'),
  check: icon(18, 'check'),
  chevronDown: icon(13, 'chevron-down'),
  chevronRight: icon(14, 'chevron-right'),
  arrowDown: icon(20, 'arrow-down'),
  arrowUp: icon(18, 'arrow-up'),
  stop: icon(11, 'square', true),
  attach: icon(20, 'paperclip'),
  copy: icon(15, 'copy'),
  pencil: icon(18, 'pencil'),
  archive: icon(18, 'archive'),
  unarchive: icon(18, 'archive-restore'),
  refresh: icon(18, 'refresh-cw'),
  terminal: icon(15, 'square-terminal'),
  file: icon(15, 'file-text'),
  fileWrite: icon(15, 'file-plus'),
  edit: icon(15, 'file-pen-line'),
  find: icon(15, 'text-search'),
  globe: icon(15, 'globe'),
  list: icon(15, 'list-todo'),
  agent: icon(15, 'bot'),
  tool: icon(15, 'wrench'),
  sparkle: icon(14, 'sparkles'),
  warning: icon(16, 'triangle-alert'),
  offline: icon(16, 'wifi-off'),
  running: icon(17, 'circle-play'),
  completed: icon(17, 'circle-check'),
  idle: icon(17, 'moon'),
  tasks: icon(17, 'list'),
}

const PERMISSION_NAMES: Record<string, string> = {
  'read-only': 'Read only', 'workspace-write': 'Workspace write', 'danger-full-access': 'Full access', auto: 'Auto review', custom: 'Custom',
}

export function permissionLabel(value: string | undefined, choices?: ModelChoices): string {
  if (!value) return ui('Permission')
  const option = choices?.permissions.find(item => item.value === value)
  // DSH's presets often have no name of their own; name the built-in ones as DSH's menu does.
  return option && option.name !== value ? option.name : ui(PERMISSION_NAMES[value] ?? value)
}

export function findModel(choices: ModelChoices | undefined, selection: ModelSelection | undefined) {
  const group = choices?.groups.find(item => item.id === selection?.provider)
  return { group, model: group?.models.find(item => item.id === selection?.model) }
}

export function modelLabel(choices: ModelChoices | undefined, selection: ModelSelection | undefined): string {
  if (!selection) return ui('Model')
  return findModel(choices, selection).model?.name ?? selection.model.split('/').at(-1) ?? selection.model
}

export function effortLabel(choices: ModelChoices | undefined, selection: ModelSelection | undefined): string | undefined {
  const { model } = findModel(choices, selection)
  if (!model?.efforts?.length) return undefined
  const id = selection?.reasoningEffort ?? model.defaultEffort
  return model.efforts.find(effort => effort.id === id)?.name ?? (id ? id : ui('Default'))
}

/** A filter field for long pickers. */
function useFilter<T>(items: T[], text: (item: T) => string, threshold = 8) {
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const field = items.length > threshold
    ? <div className="sheet-search"><input type="search" placeholder={ui('Search')} value={query} onChange={event => setQuery(event.target.value)} autoCapitalize="off" autoCorrect="off" /></div>
    : null
  return { field, visible: needle ? items.filter(item => text(item).toLowerCase().includes(needle)) : items }
}

export function ModelSheet({ choices, value, onPick, onClose }: { choices?: ModelChoices; value?: ModelSelection; onPick(model: ModelSelection): void; onClose(): void }) {
  const models = (choices?.groups ?? []).flatMap(group => group.models.map(model => ({ group, model })))
  const { field, visible } = useFilter(models, ({ group, model }) => `${group.name} ${model.name} ${model.id}`, 10)
  const groups = (choices?.groups ?? []).map(group => ({ group, models: visible.filter(item => item.group === group).map(item => item.model) })).filter(item => item.models.length > 0)
  return <Sheet title={ui('Model')} onClose={onClose}>
    {field}
    {!choices && <div className="empty">{ui('Connecting…')}</div>}
    {groups.map(({ group, models: list }) => <div key={group.id}>
      <div className="sheet-group">{group.name}</div>
      {list.map(model => <Option key={model.id} label={model.name} description={model.description}
        checked={value?.provider === group.id && value.model === model.id}
        onClick={() => onPick({ provider: group.id, model: model.id, ...(value?.reasoningEffort && model.efforts?.some(effort => effort.id === value.reasoningEffort) ? { reasoningEffort: value.reasoningEffort } : {}) })} />)}
    </div>)}
  </Sheet>
}

export function EffortSheet({ choices, value, onPick, onClose }: { choices?: ModelChoices; value: ModelSelection; onPick(model: ModelSelection): void; onClose(): void }) {
  const { model } = findModel(choices, value)
  const current = value.reasoningEffort ?? model?.defaultEffort
  return <Sheet title={ui('Reasoning')} onClose={onClose}>
    {model?.efforts?.map(effort => <Option key={effort.id} label={effort.name} checked={current === effort.id} onClick={() => onPick({ ...value, reasoningEffort: effort.id })} />)}
  </Sheet>
}

export function PermissionSheet({ choices, value, onPick, onClose }: { choices?: ModelChoices; value?: string; onPick(value: string): void; onClose(): void }) {
  return <Sheet title={ui('Permission')} onClose={onClose}>
    {choices?.permissions.map(option => <Option key={option.value} label={permissionLabel(option.value, choices)} description={option.description} checked={value === option.value} onClick={() => onPick(option.value)} />)}
  </Sheet>
}

export function WorkspaceSheet({ workspaces, value, onPick, onClose }: { workspaces: WorkspaceEntry[]; value?: string; onPick(workspaceId: string): void; onClose(): void }) {
  const { field, visible } = useFilter(workspaces, workspace => `${workspace.title} ${workspace.path}`)
  return <Sheet title={ui('Workspace')} onClose={onClose}>
    {field}
    {visible.map(workspace => <Option key={workspace.workspaceId} icon={icons.folder} label={workspace.title} description={workspace.path} checked={value === workspace.workspaceId} onClick={() => onPick(workspace.workspaceId)} />)}
  </Sheet>
}
