/** Start a session prompt first, as in Paseo: the message, with workspace, model, reasoning and permission pills. */
import React, { useEffect, useState } from 'react'
import type { ModelSelection } from '../../src/shared/protocol.js'
import { Composer, draftContent, type Draft } from './composer.js'
import { effortLabel, EffortSheet, findModel, icons, ModelSheet, modelLabel, permissionLabel, PermissionSheet, Pill, WorkspaceSheet } from './controls.js'
import { errorText, ui } from './i18n.js'
import { requestId } from './parts.js'
import { store, useModels, useStore } from './store.js'

const LAST = 'dsh-mobile/new'

interface Last { workspaceId?: string; model?: ModelSelection; permission?: string }

export function NewSession({ hubId, onBack, onCreated }: { hubId: string; onBack(): void; onCreated(sessionId: string): void }) {
  useStore()
  const state = store.hubs.get(hubId)
  const choices = useModels(state)
  const last: Last = (() => { try { return JSON.parse(localStorage.getItem(`${LAST}/${hubId}`) ?? '{}') as Last } catch { return {} } })()
  const workspaces = [...(state?.workspaces ?? [])].sort((a, b) => a.order - b.order)
  const recent = [...(state?.sessions.values() ?? [])].filter(entry => !entry.blank && entry.workspaceId).sort((a, b) => b.updatedAt - a.updatedAt)[0]?.workspaceId
  const [workspaceId, setWorkspaceId] = useState(last.workspaceId && workspaces.some(w => w.workspaceId === last.workspaceId) ? last.workspaceId : recent ?? workspaces[0]?.workspaceId ?? '')
  const [model, setModel] = useState<ModelSelection | undefined>(last.model)
  const [permission, setPermission] = useState(last.permission)
  const [draft, setDraft] = useState<Draft>({ text: '', images: [] })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [open, setOpen] = useState<'workspace' | 'model' | 'effort' | 'permission'>()

  // A remembered model this machine no longer offers falls back to its default.
  useEffect(() => {
    if (!choices) return
    if (!model || !findModel(choices, model).model) setModel(choices.default)
    if (!permission || !choices.permissions.some(option => option.value === permission)) setPermission(choices.defaultPermission ?? choices.permissions[0]?.value)
  }, [choices])
  useEffect(() => { if (!workspaceId && workspaces[0]) setWorkspaceId(workspaces[0].workspaceId) }, [workspaces.length])

  if (!state) return null
  const workspace = workspaces.find(item => item.workspaceId === workspaceId)
  const effort = effortLabel(choices, model)

  const start = async () => {
    const content = draftContent(draft)
    if (!content.length || !workspaceId) return
    setBusy(true); setError(undefined)
    try {
      const result = await state.client.call('command', { kind: 'create', requestId: requestId(), workspaceId, content, ...(model ? { model } : {}), ...(permission ? { permission } : {}) })
      localStorage.setItem(`${LAST}/${hubId}`, JSON.stringify({ workspaceId, model, permission } satisfies Last))
      for (const image of draft.images) URL.revokeObjectURL(image.preview)
      void state.refresh()
      onCreated(result.sessionId!)
    } catch (failure) { setError(errorText(failure)) } finally { setBusy(false) }
  }

  const pills = <>
    <Pill icon={icons.folder} title={ui('Workspace')} label={workspace?.title ?? ui('Workspace')} open={open === 'workspace'} onClick={workspaces.length ? () => setOpen('workspace') : undefined} />
    <Pill icon={icons.model} title={ui('Model')} label={modelLabel(choices, model)} open={open === 'model'} onClick={choices ? () => setOpen('model') : undefined} />
    {effort && <Pill icon={icons.brain} title={ui('Reasoning')} label={effort} open={open === 'effort'} onClick={() => setOpen('effort')} />}
    {choices && choices.permissions.length > 0 && <Pill icon={icons.shield} title={ui('Permission')} label={permissionLabel(permission, choices)} open={open === 'permission'} onClick={() => setOpen('permission')} />}
  </>

  return <div className="screen">
    <header className="bar">
      <button className="icon" aria-label={ui('Back')} onClick={onBack}><svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M15 5l-7 7 7 7" /></svg></button>
      <div className="bar-title"><div className="subtitle">{state.hub.name}</div></div>
    </header>
    <div className="new-hero">
      <h1>{ui('What should it do?')}</h1>
      <div className="muted small ellipsis">{workspace ? workspace.path : ui('No workspaces on this computer yet.')}</div>
      {error && <div className="error inline" role="alert">{error}</div>}
    </div>
    <Composer draft={draft} onDraft={setDraft} onSend={() => void start()} busy={busy} placeholder={ui('Describe the task')} disabled={state.client.state !== 'online' || !workspaceId} pills={pills} />
    {open === 'workspace' && <WorkspaceSheet workspaces={workspaces} value={workspaceId} onPick={id => { setWorkspaceId(id); setOpen(undefined) }} onClose={() => setOpen(undefined)} />}
    {open === 'model' && <ModelSheet choices={choices} value={model} onPick={next => { setModel(next); setOpen(undefined) }} onClose={() => setOpen(undefined)} />}
    {open === 'effort' && model && <EffortSheet choices={choices} value={model} onPick={next => { setModel(next); setOpen(undefined) }} onClose={() => setOpen(undefined)} />}
    {open === 'permission' && <PermissionSheet choices={choices} value={permission} onPick={value => { setPermission(value); setOpen(undefined) }} onClose={() => setOpen(undefined)} />}
  </div>
}
