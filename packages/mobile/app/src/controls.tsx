/** Composer pills and the bottom sheets they open: workspace, model, reasoning and permission. */
import React, { useEffect, type ReactNode } from 'react'
import type { ModelChoices, ModelSelection, WorkspaceEntry } from '../../src/shared/protocol.js'
import { ui } from './i18n.js'

export function Sheet({ title, onClose, children }: { title: string; onClose(): void; children: ReactNode }) {
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    addEventListener('keydown', key)
    return () => removeEventListener('keydown', key)
  }, [onClose])
  return <div className="sheet-backdrop" onClick={event => { if (event.target === event.currentTarget) onClose() }}>
    <div className="sheet" role="dialog" aria-label={title}>
      <div className="sheet-grip" />
      <div className="sheet-title">{title}</div>
      <div className="sheet-body">{children}</div>
    </div>
  </div>
}

const Check = () => <svg className="check" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" d="M5 12.5l4.5 4.5L19 7.5" /></svg>
const Chevron = () => <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" d="M7 10l5 5 5-5" /></svg>

export function Pill({ icon, label, onClick, open, title }: { icon?: ReactNode; label: string; onClick?(): void; open?: boolean; title?: string }) {
  return <button type="button" className="pill" onClick={onClick} disabled={!onClick} aria-expanded={open} aria-label={title ? `${title}: ${label}` : label}>
    {icon}<span>{label}</span>{onClick && <Chevron />}
  </button>
}

export function Option({ checked, label, description, onClick }: { checked?: boolean; label: string; description?: string; onClick(): void }) {
  return <button type="button" className="sheet-item" role="menuitemradio" aria-checked={checked === true} onClick={onClick}>
    <span><span>{label}</span>{description && <span className="desc">{description}</span>}</span>
    {checked && <Check />}
  </button>
}

export const icons = {
  folder: <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" d="M3.5 7.5a2 2 0 012-2h4l2 2h7a2 2 0 012 2v7.5a2 2 0 01-2 2h-13a2 2 0 01-2-2z" /></svg>,
  model: <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" /></svg>,
  brain: <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" d="M5 18c3-1 4-3 4-6M19 18c-3-1-4-3-4-6M12 4v16M8 6c-2 0-3 1.5-3 3.5S6 13 8 13M16 6c2 0 3 1.5 3 3.5S18 13 16 13" /></svg>,
  shield: <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" d="M12 3l7 3v5.5c0 4.2-3 7.7-7 9.5-4-1.8-7-5.3-7-9.5V6z" /></svg>,
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
  return findModel(choices, selection).model?.name ?? selection.model
}

export function effortLabel(choices: ModelChoices | undefined, selection: ModelSelection | undefined): string | undefined {
  const { model } = findModel(choices, selection)
  if (!model?.efforts?.length) return undefined
  const id = selection?.reasoningEffort ?? model.defaultEffort
  return model.efforts.find(effort => effort.id === id)?.name ?? (id ? id : ui('Default'))
}

export function ModelSheet({ choices, value, onPick, onClose }: { choices?: ModelChoices; value?: ModelSelection; onPick(model: ModelSelection): void; onClose(): void }) {
  return <Sheet title={ui('Model')} onClose={onClose}>
    {!choices && <div className="empty">{ui('Connecting…')}</div>}
    {choices?.groups.map(group => <div key={group.id}>
      <div className="sheet-group">{group.name}</div>
      {group.models.map(model => <Option key={model.id} label={model.name} description={model.description}
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
  return <Sheet title={ui('Workspace')} onClose={onClose}>
    {workspaces.map(workspace => <Option key={workspace.workspaceId} label={workspace.title} description={workspace.path} checked={value === workspace.workspaceId} onClick={() => onPick(workspace.workspaceId)} />)}
  </Sheet>
}
