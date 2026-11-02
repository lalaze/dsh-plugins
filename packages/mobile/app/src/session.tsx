/** One conversation: its history from the end, live updates, answers it waits for, and the message input. */
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { LiveFrame, ModelSelection, PendingInteraction, QuestionAnswer, SessionEntry, SyncedEvent } from '../../src/shared/protocol.js'
import { Composer, draftContent, type Draft } from './composer.js'
import { effortLabel, EffortSheet, icons, ModelSheet, modelLabel, Option, permissionLabel, Pill, Sheet } from './controls.js'
import { errorText, ui } from './i18n.js'
import { requestId, StatusDot, statusOf } from './parts.js'
import type { HubState } from './store.js'
import { store, useModels, useStore } from './store.js'
import { Timeline } from './timeline.js'

const PAGE = 60
const drafts = new Map<string, Draft>()

type Open = 'menu' | 'rename' | 'model' | 'effort' | undefined

export function SessionView({ state, sessionId, onBack }: { state: HubState; sessionId: string; onBack(): void }) {
  useStore()
  const entry = state.sessions.get(sessionId)
  const choices = useModels(state)
  const [events, setEvents] = useState<SyncedEvent[]>([])
  const [hasEarlier, setHasEarlier] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [live, setLive] = useState<{ text: string; reasoning: string }>()
  const held = useRef(-1)
  const key = `${state.hub.hubId}/${sessionId}`
  const [draft, setDraftState] = useState<Draft>(() => drafts.get(key) ?? { text: '', images: [] })
  const setDraft = (next: Draft) => { drafts.set(key, next); setDraftState(next) }
  const [sending, setSending] = useState(false)
  const [open, setOpen] = useState<Open>()
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const control = state.client.info?.phone?.grants.control === true

  const merge = useCallback((incoming: SyncedEvent[]) => {
    if (!incoming.length) return
    setEvents(current => {
      const bySeq = new Map(current.map(event => [event.seq, event]))
      for (const event of incoming) bySeq.set(event.seq, event)
      return [...bySeq.values()].sort((a, b) => a.seq - b.seq)
    })
    held.current = Math.max(held.current, incoming.at(-1)!.seq)
  }, [])

  /** Fetch what came after the last event held, page by page. */
  const catchUp = useCallback(async () => {
    for (let page = 0; page < 20; page++) {
      const result = await state.client.call('session.events', { sessionId, after: held.current, limit: 200 })
      merge(result.events)
      held.current = Math.max(held.current, result.lastSeq)
      if (!result.hasMore) return
    }
  }, [merge, sessionId, state])

  useEffect(() => {
    let cancelled = false
    setLoading(true); setError(undefined); setEvents([]); held.current = -1
    const load = async () => {
      try {
        const result = await state.client.call('session.events', { sessionId, limit: PAGE })
        if (cancelled) return
        setEvents(result.events); setHasEarlier(result.hasEarlier)
        held.current = result.lastSeq
        setLoading(false)
      } catch (failure) { if (!cancelled) { setError(errorText(failure)); setLoading(false) } }
    }
    void load()
    const handle = state.client.follow('session.live', { sessionId }, raw => {
      const frame = raw as LiveFrame
      if (frame.type === 'event') {
        if (frame.after > held.current && held.current >= 0) { void catchUp().catch(() => {}); return }
        if (frame.event) merge([frame.event])
        held.current = Math.max(held.current, frame.through)
        if (frame.event?.type === 'assistant/message' || frame.event?.type === 'turn/end') setLive(undefined)
      } else if (frame.type === 'draft') setLive(frame.done ? undefined : { text: frame.text, reasoning: frame.reasoning })
      else if (frame.type === 'status' || (frame.type === 'open' && frame.entry)) {
        const next = (frame as { entry: SessionEntry }).entry
        state.update(next)
        if (next.lastSeq > held.current && held.current >= 0) void catchUp().catch(() => {})
      } else if (frame.type === 'error') setError(ui(frame.message))
    }, () => { void catchUp().catch(() => {}) })
    return () => { cancelled = true; handle.close() }
  }, [catchUp, merge, sessionId, state])

  // Opening a session marks what it shows as seen.
  useEffect(() => { if (entry && entry.state === 'idle') store.markSeen(state.hub.hubId, sessionId, entry.lastSeq) }, [entry?.lastSeq, entry?.state, sessionId, state])

  useLayoutEffect(() => {
    const element = scroller.current
    if (element && stick.current) element.scrollTop = element.scrollHeight
  }, [events, live, entry?.pending.length])

  const earlier = async () => {
    const element = scroller.current, before = element?.scrollHeight ?? 0
    try {
      const result = await state.client.call('session.events', { sessionId, before: events[0]?.seq, limit: PAGE })
      setEvents(current => [...result.events, ...current])
      setHasEarlier(result.hasEarlier)
      requestAnimationFrame(() => { if (element) element.scrollTop += element.scrollHeight - before })
    } catch (failure) { setError(errorText(failure)) }
  }

  const command = (task: Promise<unknown>) => { void task.catch(failure => setError(errorText(failure))) }

  const send = async () => {
    const content = draftContent(draft)
    if (!content.length) return
    setSending(true); setError(undefined)
    const sent = draft
    setDraft({ text: '', images: [] })
    stick.current = true
    try {
      // A message sent while a task runs interrupts it, as in Paseo.
      await state.client.call('command', { kind: 'prompt', requestId: requestId(), sessionId, content, mode: entry?.state === 'idle' ? 'queue' : 'steer' })
      for (const image of sent.images) URL.revokeObjectURL(image.preview)
    } catch (failure) {
      setDraft(sent)
      setError(ui('Not sent: {0}', { 0: errorText(failure) }))
    } finally { setSending(false) }
  }

  const stop = () => command(state.client.call('command', { kind: 'cancel', requestId: requestId(), sessionId }))
  const selectModel = (model: ModelSelection) => {
    setOpen(undefined)
    if (entry) state.update({ ...entry, model })
    command(state.client.call('command', { kind: 'model', requestId: requestId(), sessionId, model }))
  }

  const title = entry?.title || ui('Untitled session')
  const running = entry !== undefined && entry.state !== 'idle'
  const model = entry?.model ?? choices?.default
  const effort = effortLabel(choices, model)
  const workspace = state.workspaceTitle(entry?.workspaceId)
  const pills = <>
    <Pill icon={icons.model} title={ui('Model')} label={modelLabel(choices, model)} open={open === 'model'} onClick={control && choices ? () => setOpen('model') : undefined} />
    {effort && <Pill icon={icons.brain} title={ui('Reasoning')} label={effort} open={open === 'effort'} onClick={control && model ? () => setOpen('effort') : undefined} />}
    {entry?.permission && <Pill icon={icons.shield} title={ui('Permission')} label={permissionLabel(entry.permission, choices)} />}
  </>
  return <div className="screen session">
    <header className="bar divided">
      <button className="icon" aria-label={ui('Back')} onClick={onBack}><svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M15 5l-7 7 7 7" /></svg></button>
      <div className="bar-title">
        <div className="title-line">{entry && <StatusDot status={statusOf(entry, -1)} />}<span className="ellipsis">{title}</span></div>
        <div className="subtitle ellipsis">{[workspace, state.hub.name].filter(Boolean).join(' · ')}</div>
      </div>
      {control && entry && <button className="icon" aria-label={ui('More')} onClick={() => setOpen('menu')}><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="5" cy="12" r="1.6" fill="currentColor" /><circle cx="12" cy="12" r="1.6" fill="currentColor" /><circle cx="19" cy="12" r="1.6" fill="currentColor" /></svg></button>}
    </header>
    <div className="scroll" ref={scroller} onScroll={event => { const element = event.currentTarget; stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80 }}>
      <div className="timeline">
        {hasEarlier && <button className="link center" onClick={() => void earlier()}>{ui('Load earlier')}</button>}
        {loading && <div className="empty">{ui('Connecting…')}</div>}
        <Timeline events={events} draft={live} state={state} sessionId={sessionId} />
        {running && !live && entry.pending.length === 0 && <div className="working"><span className="spinner" />{ui('Working…')}</div>}
        {entry?.pending.map(item => <Pending key={item.id} item={item} state={state} sessionId={sessionId} control={control} onError={setError} />)}
      </div>
    </div>
    {error && <div className="error" role="alert">{error}</div>}
    {control
      ? <Composer draft={draft} onDraft={setDraft} onSend={() => void send()} onStop={stop} running={running} busy={sending} disabled={state.client.state !== 'online'} pills={pills} />
      : <div className="readonly">{ui('This phone may only read sessions.')}</div>}
    {open === 'model' && <ModelSheet choices={choices} value={model} onPick={selectModel} onClose={() => setOpen(undefined)} />}
    {open === 'effort' && model && <EffortSheet choices={choices} value={model} onPick={selectModel} onClose={() => setOpen(undefined)} />}
    {open === 'menu' && entry && <Sheet title={title} onClose={() => setOpen(undefined)}>
      <Option label={ui('Rename')} onClick={() => setOpen('rename')} />
      <Option label={entry.archived ? ui('Unarchive') : ui('Archive')} onClick={() => { setOpen(undefined); command(state.client.call('command', { kind: 'archive', requestId: requestId(), sessionId, archived: !entry.archived }).then(() => { if (!entry.archived) onBack() })) }} />
    </Sheet>}
    {open === 'rename' && entry && <Rename entry={entry} onClose={() => setOpen(undefined)} onSave={title => { setOpen(undefined); command(state.client.call('command', { kind: 'rename', requestId: requestId(), sessionId, title })) }} />}
  </div>
}

function Rename({ entry, onClose, onSave }: { entry: SessionEntry; onClose(): void; onSave(title: string): void }) {
  const [title, setTitle] = useState(entry.title ?? '')
  return <Sheet title={ui('Rename')} onClose={onClose}>
    <form onSubmit={event => { event.preventDefault(); if (title.trim()) onSave(title.trim()) }}>
      <input className="input" value={title} autoFocus onChange={event => setTitle(event.target.value)} />
      <div className="row-actions"><button type="button" className="button" onClick={onClose}>{ui('Cancel')}</button><button type="submit" className="button primary" disabled={!title.trim()}>{ui('Save')}</button></div>
    </form>
  </Sheet>
}

function Pending({ item, state, sessionId, control, onError }: { item: PendingInteraction; state: HubState; sessionId: string; control: boolean; onError(message: string): void }) {
  const [busy, setBusy] = useState(false)
  const run = async (task: () => Promise<unknown>) => {
    setBusy(true)
    try { await task() } catch (failure) { onError(errorText(failure)) } finally { setBusy(false) }
  }
  if (item.kind === 'approval') {
    return <div className="card attention">
      <div className="card-title">{ui('Approve {0}?', { 0: item.toolName })}</div>
      {item.reason && <div className="card-text">{item.reason}</div>}
      {control && item.answerable
        ? <div className="row-actions">
          <button className="button" disabled={busy} onClick={() => void run(() => state.client.call('command', { kind: 'approval', requestId: requestId(), sessionId, approvalId: item.id, outcome: 'rejected' }))}>{ui('Deny')}</button>
          <button className="button primary" disabled={busy} onClick={() => void run(() => state.client.call('command', { kind: 'approval', requestId: requestId(), sessionId, approvalId: item.id, outcome: 'allowed-once' }))}>{ui('Allow once')}</button>
        </div>
        : <div className="card-text">{ui('Answer this on the computer.')}</div>}
    </div>
  }
  return <Questions item={item} control={control} busy={busy} onSubmit={answers => void run(() => state.client.call('command', { kind: 'answer', requestId: requestId(), sessionId, callId: item.callId, answers }))} />
}

function Questions({ item, control, busy, onSubmit }: { item: Extract<PendingInteraction, { kind: 'question' }>; control: boolean; busy: boolean; onSubmit(answers: QuestionAnswer[]): void }) {
  const [selected, setSelected] = useState<Record<string, string[]>>({})
  const [custom, setCustom] = useState<Record<string, string>>({})
  const complete = item.questions.every(question => (selected[question.id]?.length ?? 0) > 0 || (custom[question.id] ?? '').trim())
  return <form className="card attention" onSubmit={event => {
    event.preventDefault()
    onSubmit(item.questions.map(question => ({ id: question.id, selected: selected[question.id] ?? [], ...((custom[question.id] ?? '').trim() ? { custom: custom[question.id].trim() } : {}) })))
  }}>
    {item.questions.map(question => <fieldset key={question.id} className="question" disabled={!control || busy}>
      {question.header && <div className="card-label">{question.header}</div>}
      <legend className="card-title">{question.question}</legend>
      {question.detail && <div className="card-text">{question.detail}</div>}
      {question.options?.map(option => {
        const checked = selected[question.id]?.includes(option.label) ?? false
        return <label key={option.label} className="option">
          <input type={question.multiSelect ? 'checkbox' : 'radio'} name={question.id} checked={checked} onChange={() => setSelected(current => ({
            ...current, [question.id]: question.multiSelect ? (checked ? (current[question.id] ?? []).filter(label => label !== option.label) : [...(current[question.id] ?? []), option.label]) : [option.label],
          }))} />
          <span><span>{option.label}</span>{option.description && <span className="muted block small">{option.description}</span>}</span>
        </label>
      })}
      <input className="input" placeholder={ui('Other answer')} value={custom[question.id] ?? ''} onChange={event => setCustom(current => ({ ...current, [question.id]: event.target.value }))} />
    </fieldset>)}
    {control ? <div className="row-actions"><button type="submit" className="button primary" disabled={busy || !complete}>{ui('Submit')}</button></div> : <div className="card-text">{ui('Answer this on the computer.')}</div>}
  </form>
}
