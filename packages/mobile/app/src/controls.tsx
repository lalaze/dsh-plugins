/** Shared controls: bottom sheets, composer pills, option rows, switches, icons, and the model and permission pickers. */
import React, { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ModelChoices, ModelSelection, WorkspaceEntry } from '../../src/shared/protocol.js'
import { ui } from './i18n.js'
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

const icon = (size: number, body: ReactNode, fill = false) => <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" fill={fill ? 'currentColor' : 'none'} stroke={fill ? 'none' : 'currentColor'} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{body}</svg>

export const icons = {
  folder: icon(15, <path d="M3.5 7.5a2 2 0 012-2h4l2 2h7a2 2 0 012 2v7.5a2 2 0 01-2 2h-13a2 2 0 01-2-2z" />),
  model: icon(14, <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />),
  brain: icon(14, <path d="M5 18c3-1 4-3 4-6M19 18c-3-1-4-3-4-6M12 4v16M8 6c-2 0-3 1.5-3 3.5S6 13 8 13M16 6c2 0 3 1.5 3 3.5S18 13 16 13" />),
  shield: icon(14, <path d="M12 3l7 3v5.5c0 4.2-3 7.7-7 9.5-4-1.8-7-5.3-7-9.5V6z" />),
  computer: icon(14, <><rect x="3.5" y="4.5" width="17" height="11.5" rx="2" /><path d="M8.5 20h7M12 16v4" /></>),
  back: icon(24, <path d="M15 5l-7 7 7 7" strokeWidth="2" />),
  more: icon(22, <><circle cx="5.5" cy="12" r="1.5" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" /><circle cx="18.5" cy="12" r="1.5" fill="currentColor" stroke="none" /></>),
  search: icon(21, <><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4 4" /></>),
  filter: icon(21, <path d="M4 6.5h16M7 12h10M10 17.5h4" />),
  // Lucide's "settings" (ISC, see THIRD_PARTY_NOTICES.md).
  gear: icon(21, <><path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" /><circle cx="12" cy="12" r="3" /></>),
  plus: icon(20, <path d="M12 5v14M5 12h14" strokeWidth="2.2" />),
  close: icon(20, <path d="M6 6l12 12M18 6L6 18" strokeWidth="2" />),
  check: icon(18, <path d="M5 12.5l4.5 4.5L19 7.5" strokeWidth="2.2" />),
  chevronDown: icon(12, <path d="M7 10l5 5 5-5" strokeWidth="2.2" />),
  chevronRight: icon(14, <path d="M10 7l5 5-5 5" strokeWidth="2" />),
  arrowDown: icon(20, <path d="M12 5v14M6 13l6 6 6-6" strokeWidth="2" />),
  arrowUp: icon(18, <path d="M12 19V5M6 11l6-6 6 6" strokeWidth="2.2" />),
  stop: icon(14, <rect x="5" y="5" width="14" height="14" rx="2.5" />, true),
  attach: icon(21, <path d="M20 11.5l-7.8 7.8a5 5 0 01-7.1-7.1l8.5-8.5a3.3 3.3 0 014.7 4.7l-8.5 8.5a1.7 1.7 0 01-2.4-2.4l7.8-7.8" />),
  copy: icon(16, <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2" /></>),
  pencil: icon(18, <path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4" />),
  archive: icon(18, <><rect x="3.5" y="4.5" width="17" height="4.5" rx="1.2" /><path d="M5.5 9v9a2 2 0 002 2h9a2 2 0 002-2V9M10 13h4" /></>),
  unarchive: icon(18, <><rect x="3.5" y="4.5" width="17" height="4.5" rx="1.2" /><path d="M5.5 9v9a2 2 0 002 2h9a2 2 0 002-2V9M12 17v-5M9.5 14l2.5-2.5 2.5 2.5" /></>),
  refresh: icon(18, <path d="M19.5 12a7.5 7.5 0 11-2.2-5.3M19.5 4.5v3.8h-3.8" />),
  terminal: icon(15, <><rect x="3" y="4.5" width="18" height="15" rx="2.5" /><path d="M7 9.5l3 2.5-3 2.5M12.5 15h4.5" /></>),
  file: icon(15, <><path d="M6 3.5h8l4 4V20a.5.5 0 01-.5.5h-11.5A.5.5 0 015.5 20V4a.5.5 0 01.5-.5z" /><path d="M13.5 3.5V8h4.5" /></>),
  edit: icon(15, <path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4" />),
  find: icon(15, <><circle cx="11" cy="11" r="6" /><path d="M15.5 15.5l4 4" /></>),
  globe: icon(15, <><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17M12 3.5c2.5 2.6 2.5 14.4 0 17M12 3.5c-2.5 2.6-2.5 14.4 0 17" /></>),
  list: icon(15, <path d="M9 6.5h11M9 12h11M9 17.5h11M4.5 6.5l.8.8 1.6-1.8M4.5 12l.8.8 1.6-1.8M4.5 17.5h2" />),
  agent: icon(15, <><circle cx="12" cy="8.5" r="3.5" /><path d="M5.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5" /></>),
  tool: icon(15, <path d="M14.5 5.5a4 4 0 00-5.2 5.2L4 16l4 4 5.3-5.3a4 4 0 005.2-5.2l-2.6 2.6-2.8-.6-.6-2.8z" />),
  sparkle: icon(14, <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />),
  warning: icon(16, <><path d="M12 4l9 15.5H3z" /><path d="M12 10v4.2M12 16.8v.1" strokeWidth="2" /></>),
  offline: icon(16, <><path d="M3 3l18 18M8.5 16a5 5 0 017 0M5 12.5a10 10 0 015-2.6M14.5 10a10 10 0 014.5 2.5M2 9a15 15 0 015-2.9M12 5.1a15 15 0 0110 3.9" /><circle cx="12" cy="19.5" r=".6" fill="currentColor" /></>),
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
