/** Start a session prompt first, as in Paseo: the message, with workspace, model, reasoning and permission pills. */
import React, { useEffect, useState } from 'react'
import type { ModelSelection } from '../../src/shared/protocol.js'
import { OfflineBanner, Toast } from './chat.js'
import { Composer, draftContent, useDraft } from './composer.js'
import { effortLabel, EffortSheet, findModel, icons, ModelSheet, modelLabel, Option, permissionLabel, PermissionSheet, Pill, Sheet, WorkspaceSheet } from './controls.js'
import { errorText, ui } from './i18n.js'
import { go } from './nav.js'
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
  const recentIds = [...new Set([...(state?.sessions.values() ?? [])].filter(entry => !entry.blank && !entry.removed && entry.workspaceId).sort((a, b) => b.updatedAt - a.updatedAt).map(entry => entry.workspaceId!))]
    .filter(id => workspaces.some(workspace => workspace.workspaceId === id))
  const recent = recentIds[0]
  const [workspaceId, setWorkspaceId] = useState(last.workspaceId && workspaces.some(w => w.workspaceId === last.workspaceId) ? last.workspaceId : recent ?? workspaces[0]?.workspaceId ?? '')
  const [model, setModel] = useState<ModelSelection | undefined>(last.model)
  const [permission, setPermission] = useState(last.permission)
  const [draft, setDraft] = useDraft(`new/${hubId}`)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [open, setOpen] = useState<'workspace' | 'model' | 'effort' | 'permission' | 'computer'>()
  const computers = [...store.hubs.values()].filter(hub => hub.client.info?.phone?.grants.control)

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
      setDraft({ text: '', images: [] })
      void state.refresh()
      onCreated(result.sessionId!)
    } catch (failure) { setError(errorText(failure)) } finally { setBusy(false) }
  }

  const pills = <>
    <Pill icon={icons.model} title={ui('Model')} label={modelLabel(choices, model)} open={open === 'model'} onClick={choices ? () => setOpen('model') : undefined} />
    {effort && <Pill icon={icons.brain} title={ui('Reasoning')} label={effort} open={open === 'effort'} onClick={() => setOpen('effort')} />}
    {choices && choices.permissions.length > 0 && <Pill icon={icons.shield} title={ui('Permission')} label={permissionLabel(permission, choices)} open={open === 'permission'} onClick={() => setOpen('permission')} />}
  </>

  return <div className="screen">
    <header className="bar">
      <button className="icon" aria-label={ui('Back')} onClick={onBack}>{icons.back}</button>
      <div className="bar-title"><div className="title-line">{ui('New session')}</div></div>
      {computers.length > 1 && <button type="button" className="pill" onClick={() => setOpen('computer')}>{icons.computer}<span>{state.hub.name}</span>{icons.chevronDown}</button>}
    </header>
    <OfflineBanner state={state.client.state} error={state.client.error} name={state.hub.name} onRetry={() => state.client.reconnectNow()} />
    <div className="new-hero">
      <h1>{ui('What should it do?')}</h1>
      {workspaces.length > 0
        ? <button type="button" className="workspace-card" onClick={() => setOpen('workspace')}>
          <span className="workspace-icon">{icons.folder}</span>
          <span className="row-text"><span className="ellipsis workspace-name">{workspace?.title ?? ui('Workspace')}</span><span className="ellipsis row-sub">{workspace?.path}</span></span>
          {icons.chevronDown}
        </button>
        : <div className="muted small">{state.loaded ? ui('No workspaces on this computer yet.') : ui('Connecting…')}</div>}
      {recentIds.length > 1 && <div className="recent" role="tablist" aria-label={ui('Recent workspaces')}>
        {recentIds.slice(0, 5).map(id => <button key={id} type="button" role="tab" className="chip-tab" aria-selected={id === workspaceId} onClick={() => setWorkspaceId(id)}>
          {icons.folder}{workspaces.find(workspace => workspace.workspaceId === id)!.title}
        </button>)}
      </div>}
    </div>
    <Toast message={error} onClose={() => setError(undefined)} />
    <Composer draft={draft} onDraft={setDraft} onSend={() => void start()} busy={busy} placeholder={ui('Describe the task')} disabled={state.client.state !== 'online' || !workspaceId} pills={pills} />
    {open === 'workspace' && <WorkspaceSheet workspaces={workspaces} value={workspaceId} onPick={id => { setWorkspaceId(id); setOpen(undefined) }} onClose={() => setOpen(undefined)} />}
    {open === 'model' && <ModelSheet choices={choices} value={model} onPick={next => { setModel(next); setOpen(undefined) }} onClose={() => setOpen(undefined)} />}
    {open === 'effort' && model && <EffortSheet choices={choices} value={model} onPick={next => { setModel(next); setOpen(undefined) }} onClose={() => setOpen(undefined)} />}
    {open === 'permission' && <PermissionSheet choices={choices} value={permission} onPick={value => { setPermission(value); setOpen(undefined) }} onClose={() => setOpen(undefined)} />}
    {open === 'computer' && <Sheet title={ui('Computer')} onClose={() => setOpen(undefined)}>
      {computers.map(hub => <Option key={hub.hub.hubId} icon={icons.computer} label={hub.hub.name} description={hub.client.state === 'online' ? ui('Connected') : ui('Offline')} checked={hub.hub.hubId === hubId}
        onClick={() => { setOpen(undefined); if (hub.hub.hubId !== hubId) go(`new/${encodeURIComponent(hub.hub.hubId)}`, true) }} />)}
    </Sheet>}
  </div>
}
