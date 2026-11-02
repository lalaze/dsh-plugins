import React, { useEffect, useRef, useState } from 'react'
import { remoteLabel, type Command, type CommandResult, type MirrorSessionView, type PeerStatus, type PendingInteraction, type QuestionAnswer, type SyncedEvent, type OutboxItem } from '../shared/protocol.js'
import { act, ApiError, followLive, loadStatus, requestId } from './api.js'
import { localizeError, ui } from './i18n.js'
import { openLocalSession } from './navigation.js'
import { Timeline } from './timeline.js'
import { reconnectLive } from './live.js'
import { canCommand, canInteract, continuation as continuationOf, isDefiniteRejection, mergeEvents } from './view-model.js'
import { deliveryMessage, SessionFacts, type Delivery } from './session-common.js'

/** Keyed by device/session by the caller: old fetches cannot populate another conversation. */
export function SessionViewer({ session, peer, outbox, continuation, refresh }: { session: MirrorSessionView; peer?: PeerStatus; outbox: OutboxItem[]; continuation?: Continuation; refresh(): Promise<void> }) {
  const [events, setEvents] = useState<SyncedEvent[]>([])
  const [draft, setDraft] = useState<{ text: string; reasoning: string }>()
  const [loadError, setLoadError] = useState(''), [loading, setLoading] = useState(true)
  const [liveError, setLiveError] = useState('')
  const [text, setText] = useState(''), [mode, setMode] = useState<'queue' | 'steer'>('queue')
  const [busy, setBusy] = useState(false), lock = useRef(false), alive = useRef(true)
  const [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [retry, setRetry] = useState<Command>()
  const allowed = canCommand(peer) && !session.removed && !session.archived
  const liveEnabled = peer?.connection === 'online' && !!peer.grantsFromPeer.history && !session.removed
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    let active = true, fetching = false, again = false, after = -1
    const controller = new AbortController()
    setDraft(undefined); setLiveError('')
    const load = async () => {
      if (fetching) { again = true; return }
      fetching = true
      try {
        do {
          again = false
          const result = await act<{ events: SyncedEvent[] }>({ action: 'events', deviceId: session.deviceId, sessionId: session.sessionId, after }, controller.signal)
          if (!active) return
          if (result.events.length) {
            after = result.events.reduce((max, e) => Math.max(max, e.seq), after)
            setEvents(old => mergeEvents(old, result.events))
          }
          setLoadError(''); setLoading(false)
        } while (again && active)
      } catch (e) { if (active) { setLoadError(localizeError(e)); setLoading(false) } } finally { fetching = false }
    }
    void load()
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void load() }, 2000)
    if (liveEnabled) {
      void reconnectLive(controller.signal, () => followLive(session.deviceId, session.sessionId, controller.signal, frame => {
        if (!active) return
        if (frame.type === 'error') throw new Error(frame.message)
        // A valid frame confirms recovery, independently of history polling.
        setLiveError('')
        if (frame.type === 'draft') setDraft(frame.done ? undefined : frame)
        if (frame.type === 'event' || frame.type === 'open') { setDraft(undefined); void load() }
      }), (failure, retrying) => {
        if (!active) return
        setDraft(undefined)
        setLiveError(ui(retrying ? 'Live connection interrupted: {0}. Reconnecting in 3 seconds…' : 'Live connection unavailable: {0}. Reopen the session after checking access.', { 0: localizeError(failure) }))
      })
    }
    return () => { active = false; clearInterval(timer); controller.abort() }
  }, [session.deviceId, session.sessionId, liveEnabled])

  const send = async (command: Command) => {
    if (lock.current || !allowed || (command.kind !== 'prompt' && !canInteract(peer))) return
    lock.current = true; setBusy(true); setError(''); setNotice('')
    try {
      // An uncertain browser response may have left a held request on the host. Never resend it implicitly.
      if (retry?.requestId === command.requestId) {
        const latest = await loadStatus()
        if (latest.outbox.some(item => item.requestId === command.requestId)) {
          if (alive.current) { setNotice(ui('Use Pending requests to send or discard this request.')); setRetry(undefined); if (command.kind === 'prompt') setText('') }
          await refresh(); return
        }
      }
      const result = await act<Delivery>({ action: 'command', deviceId: session.deviceId, command })
      if (alive.current) {
        setNotice(deliveryMessage(result))
        if (result.held || result.result) { setRetry(undefined); if (command.kind === 'prompt') setText('') }
        else setRetry(command)
      }
      await refresh()
    } catch (e) {
      if (alive.current) { setError(localizeError(e)); setRetry(isDefiniteRejection(e instanceof ApiError ? e.status : undefined) ? undefined : command) }
      await refresh()
    } finally { lock.current = false; if (alive.current) setBusy(false) }
  }
  return <div className="dsy-viewer"><header className="dsy-viewer-head"><h3>{session.title || session.sessionId}</h3><p className="dsy-hint">{ui('Executes on {0}, not on this machine.', { 0: peer?.name ?? session.deviceId })}</p><SessionFacts session={session} /></header>
    {loadError && <p className="dsy-error" role="alert">{loadError}</p>}
    {liveEnabled && liveError && <p className="dsy-error" role="status">{liveError}</p>}
    <div className="dsy-timeline" style={{ maxHeight: '60vh', minHeight: 120 }}>{loading ? <p>{ui('Loading…')}</p> : <Timeline events={events} draft={liveEnabled ? draft : undefined} deviceId={session.deviceId} sessionId={session.sessionId} />}</div>
    {!allowed && <p className="dsy-banner">{ui('Read-only: remote control must be allowed on the owning machine; paused, unpaired, archived or deleted sessions cannot be controlled here.')}</p>}
    {allowed && peer?.connection === 'offline' && <p className="dsy-banner">{ui('Offline: requests are held here until you explicitly send them again.')}</p>}
    {error && <p className="dsy-error" role="alert">{error}</p>}{notice && <p className="dsy-hint" role="status">{notice}</p>}
    {retry && <div className="dsy-banner"><p>{ui('Delivery uncertain. Check Pending requests first. Retrying uses the same request ID to prevent duplicate execution.')}</p><button type="button" className="dsy-btn" disabled={busy || !allowed || (retry.kind !== 'prompt' && !canInteract(peer)) || outbox.some(item => item.requestId === retry.requestId)} onClick={() => void send(retry)}>{ui('Retry same request')}</button>{outbox.some(item => item.requestId === retry.requestId) && <button type="button" className="dsy-btn" disabled={busy} onClick={() => { setRetry(undefined); if (retry.kind === 'prompt') setText(''); setNotice(ui('Use Pending requests to send or discard this request.')) }}>{ui('Manage in Pending requests')}</button>}</div>}
    {session.pending.map(p => <Interaction key={p.id} pending={p} disabled={!allowed || !canInteract(peer) || busy || !!retry} onSend={part => send({ ...part, requestId: requestId(), sessionId: session.sessionId } as Command)} />)}
    <form className="dsy-composer" onSubmit={e => { e.preventDefault(); if (text.trim() && !retry) void send({ kind: 'prompt', requestId: requestId(), sessionId: session.sessionId, content: [{ type: 'text', text }], mode }) }}>
      <textarea aria-label={ui('Write a message')} placeholder={ui('Write a message')} value={text} disabled={busy || !allowed || !!retry} onChange={e => setText(e.target.value)} />
      <div className="dsy-composer-bar"><label>{ui('While running')} <select className="dsy-input" value={mode} disabled={busy || !!retry} onChange={e => setMode(e.target.value as 'queue' | 'steer')}><option value="queue">{ui('Queue')}</option><option value="steer">{ui('Steer')}</option></select></label>
        <button type="submit" className="dsy-btn" data-kind="primary" disabled={busy || !allowed || !!retry || !text.trim()}>{ui(busy ? 'Sending…' : peer?.connection === 'offline' ? 'Hold request' : 'Send')}</button>
        <button type="button" className="dsy-btn" disabled={busy || !allowed || !canInteract(peer) || !!retry || session.state === 'idle'} onClick={() => void send({ kind: 'cancel', requestId: requestId(), sessionId: session.sessionId })}>{ui('Stop task')}</button></div>
    </form>
    {continuation && <ContinueHere session={session} continuation={continuation} />}
  </div>
}

type Continuation = NonNullable<ReturnType<typeof continuationOf>>
/** Carry an SSH workspace's conversation on in this machine's workspace for the same directory. */
function ContinueHere({ session, continuation }: { session: MirrorSessionView; continuation: Continuation }) {
  const [note, setNote] = useState(''), [busy, setBusy] = useState(false), lock = useRef(false), alive = useRef(true)
  const [error, setError] = useState(''), [notice, setNotice] = useState('')
  // The request whose outcome is unknown; trying again reuses it, so at most one conversation is started.
  const pending = useRef<string>(), [uncertain, setUncertain] = useState(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const { local, remote } = continuation
  if (!local) return <section className="dsy-continue"><h4>{ui('Continue on this machine')}</h4>
    <p className="dsy-hint">{ui('This machine has no workspace for {0} yet. Add this SSH machine under Settings → Remote agents; it then brings in the remote workspaces shared on that machine.', { 0: remoteLabel(remote) })}</p></section>
  const start = async () => {
    if (lock.current) return
    lock.current = true; setBusy(true); setError(''); setNotice('')
    const id = pending.current ??= requestId()
    try {
      const result = await act<CommandResult>({ action: 'continueHere', requestId: id, deviceId: session.deviceId, sessionId: session.sessionId, workspaceId: local.workspaceId, ...(note.trim() ? { note } : {}) })
      pending.current = undefined
      const opened = !!result.sessionId && openLocalSession(result.sessionId)
      if (alive.current) { setUncertain(false); setNote(''); setNotice(ui(opened ? 'Started in {0} on this machine.' : 'Started in {0} on this machine. Open it from the sidebar.', { 0: local.title })) }
    } catch (e) {
      const definite = isDefiniteRejection(e instanceof ApiError ? e.status : undefined)
      if (definite) pending.current = undefined
      if (alive.current) { setError(localizeError(e)); setUncertain(!definite) }
    } finally { lock.current = false; if (alive.current) setBusy(false) }
  }
  return <section className="dsy-continue" aria-label={ui('Continue on this machine')}><h4>{ui('Continue on this machine')}</h4>
    <p className="dsy-hint">{ui('Starts a new conversation in {0} on this machine, with this conversation’s history. The original conversation is not changed.', { 0: local.title })}</p>
    {session.storedSeq < session.lastSeq && <p className="dsy-warn">{ui('Part of this conversation has not been copied here yet; only what is shown above is included.')}</p>}
    <textarea aria-label={ui('What next (optional)')} placeholder={ui('What should happen next? (optional)')} value={note} disabled={busy || uncertain} onChange={e => setNote(e.target.value)} />
    {error && <p className="dsy-error" role="alert">{error}</p>}{notice && <p className="dsy-hint" role="status">{notice}</p>}
    {uncertain && <p className="dsy-hint">{ui('No confirmation arrived. Trying again sends the same request, so at most one conversation is started.')}</p>}
    <div className="dsy-actions" style={{ justifyContent: 'flex-start' }}><button type="button" className="dsy-btn" data-kind="primary" disabled={busy} onClick={() => void start()}>{ui(busy ? 'Starting…' : uncertain ? 'Try again' : 'Continue here')}</button></div>
  </section>
}

type AnswerCommand = { kind: 'approval'; approvalId: string; outcome: 'allowed-once' | 'rejected' } | { kind: 'answer'; callId: string; answers: QuestionAnswer[] }
function Interaction({ pending, disabled, onSend }: { pending: PendingInteraction; disabled: boolean; onSend(command: AnswerCommand): Promise<void> }) {
  const [answers, setAnswers] = useState<Record<string, QuestionAnswer>>({})
  if (pending.kind === 'approval') return <section className="dsy-pending"><h4>{ui('Asked to approve {0}', { 0: pending.toolName })}</h4>{pending.reason && <p className="dsy-msg-text">{pending.reason}</p>}
    {!pending.answerable && <p>{ui('This confirmation must be answered on the owning machine.')}</p>}
    <div className="dsy-actions">{(['allowed-once', 'rejected'] as const).map(outcome => <button key={outcome} type="button" className="dsy-btn" disabled={disabled || !pending.answerable} onClick={() => void onSend({ kind: 'approval', approvalId: pending.id, outcome })}>{ui(outcome === 'allowed-once' ? 'Allow once' : 'Reject')}</button>)}</div>
  </section>
  return <form className="dsy-pending" onSubmit={e => { e.preventDefault(); void onSend({ kind: 'answer', callId: pending.callId, answers: pending.questions.map(q => answers[q.id] ?? { id: q.id, selected: [] }) }) }}>
    {pending.questions.map(q => { const a = answers[q.id] ?? { id: q.id, selected: [] }; return <fieldset key={q.id} disabled={disabled}><legend>{q.header || q.question}</legend>{q.header && <p>{q.question}</p>}{q.detail && <p className="dsy-hint">{q.detail}</p>}
      {q.options?.map(o => <label key={o.label} className="dsy-check"><input type={q.multiSelect ? 'checkbox' : 'radio'} name={`${pending.id}:${q.id}`} checked={a.selected.includes(o.label)} onChange={e => setAnswers(old => ({ ...old, [q.id]: { ...a, selected: q.multiSelect ? e.target.checked ? [...a.selected, o.label] : a.selected.filter(s => s !== o.label) : [o.label] } }))} /><span>{o.label}{o.description && <span className="dsy-hint"> — {o.description}</span>}</span></label>)}
      <label>{ui('Custom answer')}<input className="dsy-input" value={a.custom ?? ''} onChange={e => setAnswers(old => ({ ...old, [q.id]: { ...a, custom: e.target.value } }))} /></label>
    </fieldset> })}
    <button className="dsy-btn" type="submit" disabled={disabled || pending.questions.some(q => !answers[q.id]?.selected.length && !answers[q.id]?.custom?.trim())}>{ui('Submit answers')}</button>
  </form>
}
