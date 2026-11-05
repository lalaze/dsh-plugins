/** One conversation: its history from the end, live updates, answers it waits for, and the message input. */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { LiveFrame, ModelSelection, PendingInteraction, QuestionAnswer, SessionEntry, SyncedEvent } from '../../src/shared/protocol.js'
import { JumpToEnd, LoadEarlier, OfflineBanner, Skeleton, Toast, useChatScroll } from './chat.js'
import { Composer, draftContent, useDraft } from './composer.js'
import { effortLabel, EffortSheet, haptic, icons, ModelSheet, modelLabel, Option, permissionLabel, Pill, Sheet } from './controls.js'
import { errorText, ui } from './i18n.js'
import { requestId, StatusDot, statusOf } from './parts.js'
import type { HubState } from './store.js'
import { store, useModels, useStore } from './store.js'
import { Timeline, toolArguments, userText } from './timeline.js'
import { describeTool, parseArgs } from './tools.js'

const PAGE = 60

type Open = 'menu' | 'rename' | 'model' | 'effort' | undefined
/** A message on its way, shown at once until the session records it. */
interface Outbox { text: string; images: string[]; after: number }

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
  const [draft, setDraft] = useDraft(`${state.hub.hubId}/${sessionId}`)
  const [sending, setSending] = useState(false)
  const [outbox, setOutbox] = useState<Outbox>()
  const [open, setOpen] = useState<Open>()
  const scroller = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const scroll = useChatScroll(scroller, content, events.at(-1)?.seq ?? -1)
  const control = state.client.info?.phone?.grants.control === true
  const online = state.client.state === 'online'

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
        if (next.state === 'idle') setLive(undefined)
        if (next.lastSeq > held.current && held.current >= 0) void catchUp().catch(() => {})
      } else if (frame.type === 'error') setError(ui(frame.message))
    }, () => { setLive(undefined); void catchUp().catch(() => {}) })
    return () => { cancelled = true; handle.close() }
  }, [catchUp, merge, sessionId, state])

  // Opening a session marks what it shows as seen, here and on the computers sharing it once the phone is really showing it.
  useEffect(() => {
    if (!entry || entry.state !== 'idle') return
    store.markSeen(state.hub.hubId, sessionId, entry.lastSeq)
    const tell = () => { if (document.visibilityState === 'visible') void state.client.call('session.read', { sessionId }).catch(() => {}) }
    tell()
    document.addEventListener('visibilitychange', tell)
    return () => document.removeEventListener('visibilitychange', tell)
  }, [entry?.lastSeq, entry?.state, sessionId, state])

  // The sent message shows until the session has it.
  const delivered = outbox !== undefined && events.some(event => event.seq > outbox.after && userText(event) !== undefined)
  useEffect(() => {
    if (!delivered || !outbox) return
    for (const url of outbox.images) URL.revokeObjectURL(url)
    setOutbox(undefined)
  }, [delivered, outbox])

  const earlier = useCallback(async () => {
    try {
      const result = await state.client.call('session.events', { sessionId, before: events[0]?.seq, limit: PAGE })
      scroll.holdPosition()
      setEvents(current => [...result.events, ...current])
      setHasEarlier(result.hasEarlier)
    } catch (failure) { setError(errorText(failure)) }
  }, [events, scroll, sessionId, state])

  const command = (task: Promise<unknown>) => { void task.catch(failure => setError(errorText(failure))) }

  const send = async () => {
    const content = draftContent(draft)
    if (!content.length) return
    setSending(true); setError(undefined)
    const sent = draft
    setDraft({ text: '', images: [] })
    setOutbox({ text: sent.text, images: sent.images.map(image => image.preview), after: held.current })
    scroll.toEnd()
    try {
      // A message sent while a task runs interrupts it, as in Paseo.
      await state.client.call('command', { kind: 'prompt', requestId: requestId(), sessionId, content, mode: entry?.state === 'idle' ? 'queue' : 'steer' })
    } catch (failure) {
      setOutbox(undefined)
      setDraft(sent)
      setError(ui('Not sent: {0}', { 0: errorText(failure) }))
    } finally { setSending(false) }
  }

  const stop = () => { haptic(); command(state.client.call('command', { kind: 'cancel', requestId: requestId(), sessionId })) }
  const selectModel = (model: ModelSelection) => {
    setOpen(undefined)
    if (entry) state.update({ ...entry, model })
    command(state.client.call('command', { kind: 'model', requestId: requestId(), sessionId, model }))
  }

  const title = entry?.title || ui('Untitled session')
  const running = entry !== undefined && entry.state !== 'idle'
  const status = entry ? statusOf(entry, -1) : undefined
  const model = entry?.model ?? choices?.default
  const effort = effortLabel(choices, model)
  const workspace = state.workspaceTitle(entry?.workspaceId)
  const pending = entry?.pending ?? []
  const pills = <>
    <Pill icon={icons.model} title={ui('Model')} label={modelLabel(choices, model)} open={open === 'model'} onClick={control && choices ? () => setOpen('model') : undefined} />
    {effort && <Pill icon={icons.brain} title={ui('Reasoning')} label={effort} open={open === 'effort'} onClick={control && model ? () => setOpen('effort') : undefined} />}
    {entry?.permission && <Pill icon={icons.shield} title={ui('Permission')} label={permissionLabel(entry.permission, choices)} />}
  </>
  const statusLabel = status === 'running' ? ui('Running') : status === 'waiting' ? ui('Needs you') : undefined
  return <div className="screen session">
    <header className="bar divided">
      <button className="icon" aria-label={ui('Back')} onClick={onBack}>{icons.back}</button>
      <button type="button" className="bar-title as-button" disabled={!control || !entry} onClick={() => setOpen('menu')}>
        <span className="title-line"><span className="ellipsis">{title}</span></span>
        <span className="subtitle ellipsis">
          {status && status !== 'idle' && status !== 'done' && <><StatusDot status={status} /><span className={`status-text ${status}`}>{statusLabel}</span><span className="sep">·</span></>}
          {[workspace, state.hub.name].filter(Boolean).join(' · ')}
        </span>
      </button>
      {control && entry && <button className="icon" aria-label={ui('More')} onClick={() => setOpen('menu')}>{icons.more}</button>}
    </header>
    <OfflineBanner state={state.client.state} error={state.client.error} name={state.hub.name} onRetry={() => state.client.reconnectNow()} />
    <div className="chat-body">
      <div className="scroll chat-scroll" ref={scroller} onScroll={scroll.onScroll}>
        <div className="timeline" ref={content}>
          <LoadEarlier root={scroller} more={hasEarlier && !loading} onLoad={earlier} />
          {loading && events.length === 0 && <Skeleton />}
          <Timeline events={events} draft={live} state={state} sessionId={sessionId} />
          {outbox && !delivered && <div className="msg user sending">
            {outbox.images.length > 0 && <div className="attachments">{outbox.images.map(url => <img key={url} className="thumb" src={url} alt="" />)}</div>}
            {outbox.text && <div className="md"><p>{outbox.text}</p></div>}
            <div className="sending-note">{ui('Sending…')}</div>
          </div>}
          {running && pending.length === 0 && <div className="working"><span className="spinner" />{ui('Working…')}</div>}
        </div>
      </div>
      <JumpToEnd visible={!scroll.atEnd} fresh={scroll.fresh} onClick={() => scroll.toEnd(true)} />
    </div>
    {pending.length > 0 && <div className="dock">
      {pending.map(item => <Pending key={item.id} item={item} events={events} state={state} sessionId={sessionId} control={control} onError={setError} />)}
    </div>}
    <Toast message={error} onClose={() => setError(undefined)} />
    {control
      ? <Composer draft={draft} onDraft={setDraft} onSend={() => void send()} onStop={stop} running={running} busy={sending} disabled={!online} pills={pills} />
      : <div className="readonly">{ui('This phone may only read sessions.')}</div>}
    {open === 'model' && <ModelSheet choices={choices} value={model} onPick={selectModel} onClose={() => setOpen(undefined)} />}
    {open === 'effort' && model && <EffortSheet choices={choices} value={model} onPick={selectModel} onClose={() => setOpen(undefined)} />}
    {open === 'menu' && entry && <SessionActions entry={entry} state={state} onClose={() => setOpen(undefined)} onRename={() => setOpen('rename')} onError={setError} onArchived={onBack} />}
    {open === 'rename' && entry && <Rename entry={entry} onClose={() => setOpen(undefined)} onSave={title => { setOpen(undefined); command(state.client.call('command', { kind: 'rename', requestId: requestId(), sessionId, title })) }} />}
  </div>
}

/** Rename and archive, from a session's title or its row in the list. */
export function SessionActions({ entry, state, onClose, onRename, onError, onArchived }: { entry: SessionEntry; state: HubState; onClose(): void; onRename(): void; onError(message: string): void; onArchived?(): void }) {
  const title = entry.title || ui('Untitled session')
  return <Sheet title={title} onClose={onClose}>
    <Option icon={icons.pencil} label={ui('Rename')} onClick={onRename} />
    <Option icon={entry.archived ? icons.unarchive : icons.archive} label={entry.archived ? ui('Unarchive') : ui('Archive')} onClick={() => {
      onClose(); haptic()
      void state.client.call('command', { kind: 'archive', requestId: requestId(), sessionId: entry.sessionId, archived: !entry.archived })
        .then(() => { if (!entry.archived) onArchived?.() }, failure => onError(errorText(failure)))
    }} />
  </Sheet>
}

export function Rename({ entry, onClose, onSave }: { entry: SessionEntry; onClose(): void; onSave(title: string): void }) {
  const [title, setTitle] = useState(entry.title ?? '')
  return <Sheet title={ui('Rename')} onClose={onClose}>
    <form className="sheet-form" onSubmit={event => { event.preventDefault(); if (title.trim()) onSave(title.trim()) }}>
      <input className="input" value={title} autoFocus enterKeyHint="done" onChange={event => setTitle(event.target.value)} />
      <div className="row-actions"><button type="button" className="button" onClick={onClose}>{ui('Cancel')}</button><button type="submit" className="button primary" disabled={!title.trim()}>{ui('Save')}</button></div>
    </form>
  </Sheet>
}

function Pending({ item, events, state, sessionId, control, onError }: { item: PendingInteraction; events: SyncedEvent[]; state: HubState; sessionId: string; control: boolean; onError(message: string): void }) {
  const [busy, setBusy] = useState(false)
  const run = async (task: () => Promise<unknown>) => {
    setBusy(true); haptic()
    try { await task() } catch (failure) { onError(errorText(failure)) } finally { setBusy(false) }
  }
  if (item.kind === 'approval') {
    const args = toolArguments(events, item.callId)
    const described = describeTool(item.toolName, args)
    const parsed = parseArgs(args)
    const detail = described.kind === 'command' ? (Array.isArray(parsed.command) ? parsed.command.join(' ') : String(parsed.command ?? parsed.cmd ?? ''))
      : described.target || ''
    const answer = (outcome: 'rejected' | 'allowed-once') => void run(() => state.client.call('command', { kind: 'approval', requestId: requestId(), sessionId, approvalId: item.id, outcome }))
    return <Approval title={ui('Approve {0}?', { 0: item.toolName })} text={item.reason && item.reason !== detail ? item.reason : undefined} detail={detail}
      actions={control && item.answerable ? [{ label: ui('Deny'), onClick: () => answer('rejected') }, { label: ui('Allow once'), primary: true, onClick: () => answer('allowed-once') }] : undefined} busy={busy} />
  }
  return <Questions item={item} control={control} busy={busy} onSubmit={answers => void run(() => state.client.call('command', { kind: 'answer', requestId: requestId(), sessionId, callId: item.callId, answers }))} />
}

/** A request to approve a tool call, with what it would run and large buttons to answer. */
export function Approval({ title, text, detail, actions, busy }: { title: string; text?: string; detail?: string; actions?: { label: string; primary?: boolean; onClick(): void }[]; busy: boolean }) {
  const [expanded, setExpanded] = useState(false)
  return <div className="dock-card">
    <div className="dock-title">{icons.warning}<span>{title}</span></div>
    {text && <div className="dock-text">{text}</div>}
    {detail && <pre className={`dock-pre${expanded ? ' expanded' : ''}`} onClick={() => setExpanded(!expanded)}>{detail}</pre>}
    {actions
      ? <div className={`dock-actions${actions.length > 2 ? ' stacked' : ''}`}>
        {actions.map((action, index) => <button key={index} type="button" className={`button big${action.primary ? ' primary' : ''}`} disabled={busy} onClick={action.onClick}>{action.label}</button>)}
      </div>
      : <div className="dock-text muted">{ui('Answer this on the computer.')}</div>}
  </div>
}

function Questions({ item, control, busy, onSubmit }: { item: Extract<PendingInteraction, { kind: 'question' }>; control: boolean; busy: boolean; onSubmit(answers: QuestionAnswer[]): void }) {
  const [selected, setSelected] = useState<Record<string, string[]>>({})
  const [custom, setCustom] = useState<Record<string, string>>({})
  const complete = item.questions.every(question => (selected[question.id]?.length ?? 0) > 0 || (custom[question.id] ?? '').trim())
  return <form className="dock-card" onSubmit={event => {
    event.preventDefault()
    onSubmit(item.questions.map(question => ({ id: question.id, selected: selected[question.id] ?? [], ...((custom[question.id] ?? '').trim() ? { custom: custom[question.id].trim() } : {}) })))
  }}>
    {item.questions.map(question => <fieldset key={question.id} className="question" disabled={!control || busy}>
      {question.header && <div className="dock-label">{question.header}</div>}
      <legend className="dock-title plain">{question.question}</legend>
      {question.detail && <div className="dock-text">{question.detail}</div>}
      <div className="choices" role={question.multiSelect ? 'group' : 'radiogroup'}>
        {question.options?.map(option => {
          const checked = selected[question.id]?.includes(option.label) ?? false
          return <label key={option.label} className="choice" data-checked={checked}>
            <input type={question.multiSelect ? 'checkbox' : 'radio'} name={`${item.id}-${question.id}`} checked={checked} onChange={() => setSelected(current => ({
              ...current, [question.id]: question.multiSelect ? (checked ? (current[question.id] ?? []).filter(label => label !== option.label) : [...(current[question.id] ?? []), option.label]) : [option.label],
            }))} />
            <span className={`choice-mark${question.multiSelect ? ' square' : ''}`}>{checked && icons.check}</span>
            <span className="choice-text"><span>{option.label}</span>{option.description && <span className="desc">{option.description}</span>}</span>
          </label>
        })}
      </div>
      <input className="input" placeholder={ui('Other answer')} value={custom[question.id] ?? ''} enterKeyHint="done" onChange={event => setCustom(current => ({ ...current, [question.id]: event.target.value }))} />
    </fieldset>)}
    {control
      ? <div className="dock-actions"><button type="submit" className="button big primary" disabled={busy || !complete}>{ui('Submit')}</button></div>
      : <div className="dock-text muted">{ui('Answer this on the computer.')}</div>}
  </form>
}
