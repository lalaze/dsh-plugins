/** Start a session from the phone: workspace, model, reasoning, permission and the first message, prompt first. */
import React, { useEffect, useState } from 'react'
import type { ModelChoices } from '../../src/shared/protocol.js'
import { Composer, draftContent, type Draft } from './composer.js'
import { errorText, ui } from './i18n.js'
import { requestId } from './parts.js'
import { store, useStore } from './store.js'

const LAST = 'dsh-mobile/new'

interface Last { workspaceId?: string; provider?: string; model?: string; effort?: string; permission?: string }

export function NewSession({ hubId, onBack, onCreated }: { hubId: string; onBack(): void; onCreated(sessionId: string): void }) {
  useStore()
  const state = store.hubs.get(hubId)
  const [choices, setChoices] = useState<ModelChoices>()
  const last: Last = (() => { try { return JSON.parse(localStorage.getItem(`${LAST}/${hubId}`) ?? '{}') as Last } catch { return {} } })()
  const workspaces = [...(state?.workspaces ?? [])].sort((a, b) => a.order - b.order)
  const recent = [...(state?.sessions.values() ?? [])].sort((a, b) => b.updatedAt - a.updatedAt)[0]?.workspaceId
  const [workspaceId, setWorkspaceId] = useState(last.workspaceId && workspaces.some(w => w.workspaceId === last.workspaceId) ? last.workspaceId : recent ?? workspaces[0]?.workspaceId ?? '')
  const [model, setModel] = useState(last.provider && last.model ? `${last.provider}\u0000${last.model}` : '')
  const [effort, setEffort] = useState(last.effort ?? '')
  const [permission, setPermission] = useState(last.permission ?? '')
  const [draft, setDraft] = useState<Draft>({ text: '', images: [] })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    if (!state || state.client.state !== 'online') return
    void state.client.call('models', { workspaceId }).then(result => {
      setChoices(result)
      const known = result.groups.some(group => group.models.some(item => `${group.id}\u0000${item.id}` === model))
      if (!known && result.default) setModel(`${result.default.provider}\u0000${result.default.model}`)
      if (!permission && result.defaultPermission) setPermission(result.defaultPermission)
    }, failure => setError(errorText(failure)))
  }, [state?.client.state])

  if (!state) return null
  const [provider, modelId] = model.split('\u0000')
  const chosen = choices?.groups.find(group => group.id === provider)?.models.find(item => item.id === modelId)

  const start = async () => {
    const content = draftContent(draft)
    if (!content.length || !workspaceId) return
    setBusy(true); setError(undefined)
    try {
      const selection = provider && modelId ? { provider, model: modelId, ...(effort && chosen?.efforts?.some(e => e.id === effort) ? { reasoningEffort: effort } : {}) } : undefined
      const result = await state.client.call('command', { kind: 'create', requestId: requestId(), workspaceId, content, ...(selection ? { model: selection } : {}), ...(permission ? { permission } : {}) })
      localStorage.setItem(`${LAST}/${hubId}`, JSON.stringify({ workspaceId, provider, model: modelId, effort, permission } satisfies Last))
      for (const image of draft.images) URL.revokeObjectURL(image.preview)
      void state.refresh()
      onCreated(result.sessionId!)
    } catch (failure) { setError(errorText(failure)) } finally { setBusy(false) }
  }

  return <div className="screen">
    <header className="bar">
      <button className="icon" aria-label={ui('Back')} onClick={onBack}><svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M15 5l-7 7 7 7" /></svg></button>
      <div className="bar-title"><div className="title-line">{ui('New session')}</div><div className="subtitle">{state.hub.name}</div></div>
    </header>
    <div className="scroll form">
      <label className="field"><span>{ui('Workspace')}</span>
        <select value={workspaceId} onChange={event => setWorkspaceId(event.target.value)}>
          {workspaces.map(workspace => <option key={workspace.workspaceId} value={workspace.workspaceId}>{workspace.title}</option>)}
        </select>
      </label>
      <label className="field"><span>{ui('Model')}</span>
        <select value={model} onChange={event => { setModel(event.target.value); setEffort('') }} disabled={!choices}>
          {!choices && <option value={model}>{ui('Connecting…')}</option>}
          {choices?.groups.map(group => <optgroup key={group.id} label={group.name}>
            {group.models.map(item => <option key={item.id} value={`${group.id}\u0000${item.id}`}>{item.name}</option>)}
          </optgroup>)}
        </select>
      </label>
      {chosen?.efforts && <div className="field"><span>{ui('Reasoning')}</span>
        <div className="chips">
          <button type="button" className="chip-button" aria-pressed={!effort} onClick={() => setEffort('')}>{ui('Default')}</button>
          {chosen.efforts.map(item => <button type="button" key={item.id} className="chip-button" aria-pressed={effort === item.id} onClick={() => setEffort(item.id)}>{item.name}</button>)}
        </div>
      </div>}
      {choices && choices.permissions.length > 0 && <label className="field"><span>{ui('Permission')}</span>
        <select value={permission} onChange={event => setPermission(event.target.value)}>
          {choices.permissions.map(option => <option key={option.value} value={option.value}>{option.name}</option>)}
        </select>
      </label>}
      {error && <div className="error inline" role="alert">{error}</div>}
    </div>
    <Composer draft={draft} onDraft={setDraft} onSend={() => void start()} busy={busy} placeholder={ui('What should it do?')} disabled={state.client.state !== 'online' || !workspaceId} />
  </div>
}
