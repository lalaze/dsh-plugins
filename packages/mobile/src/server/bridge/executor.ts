/**
 * This machine's sessions and workspaces, described for paired phones, and the requests they may send. Only this
 * module reaches DSH's session API; nothing here writes a session log directly.
 */
import { randomUUID } from 'node:crypto'
import type { Command, CommandResult, LiveFrame, ModelSelection, PendingInteraction, PromptPart, SessionEntry, SyncedEvent, WorkspaceEntry } from '../../shared/protocol.js'
import { addToDraft, attachmentRefs, firstPrompt, modelOf, openApprovals, openQuestions, shareEvent, titleOf } from './events.js'
import type { ApprovalAsk, HostApi, HostAttachmentRef, HostInspection, HostSessionSummary, HostWorkspaceState } from './host.js'
import { AsyncQueue, sleep } from './queue.js'

export class CommandError extends Error {
  override name = 'CommandError'
  constructor(message: string, readonly status = 400) { super(message) }
}

/** What survives a restart: the last inspected position of each session, and handled request IDs. */
export interface ExecutorData {
  /** What the cached session facts were derived with; see {@link EXECUTOR_DATA_VERSION}. */
  version?: number
  sessions: Record<string, { updatedAt: number; running: boolean; lastSeq: number; title?: string; preview?: string; forkOf?: string; approvals?: PendingInteraction[]; model?: ModelSelection }>
  handled: Record<string, { at: number; result: CommandResult }>
  /** Reads made elsewhere taken into account: the read mark and how far this machine's session went at that moment. */
  reads?: Record<string, { mark: string; seq: number }>
}
/** Raise when the facts read from a session log change, so every session is read again. */
export const EXECUTOR_DATA_VERSION = 2
export const emptyExecutorData = (): ExecutorData => ({ version: EXECUTOR_DATA_VERSION, sessions: {}, handled: {} })

interface Entry extends SessionEntry { rev: number }
interface Approval { id: string; sessionId: string; toolName: string; callId?: string; reason?: string; askedAt: number; resolve(outcome: 'allowed-once' | 'rejected'): void }

const HANDLED_TTL = 7 * 24 * 3600_000
const MAX_TEXT = 200_000
const MAX_IMAGE_BASE64 = 14_000_000
const MAX_EVENTS_BYTES = 4_000_000
/** How often a running session is read again while nothing else announces its progress and a phone watches. */
const RUNNING_REREAD_MS = 2_000
/** The same with no phone connected, when only notifications depend on it. */
const RUNNING_REREAD_IDLE_MS = 10_000

export interface ExecutorOptions {
  host: HostApi
  data: ExecutorData
  save(): void
  /** Something a peer would fetch changed. */
  changed(): void
  /** Whether any paired phone could answer an approval now. */
  approvalPeers(): boolean
  /** Whether a phone is connected, so running sessions are worth reading often. */
  watched?(): boolean
  /** What marks a session as read as far as it goes on another computer or phone, if it is. */
  readMark?(sessionId: string): string | undefined
  log?(message: string): void
}

export class Executor {
  private readonly host: HostApi
  private readonly entries = new Map<string, Entry>()
  private workspaceState: HostWorkspaceState = { items: [], archivedSessionIds: [] }
  private workspaceRev = 0
  private rev = 0
  /** Identifies this process's change counter; a peer holding another epoch's cursor gets everything again. */
  readonly epoch = randomUUID().slice(0, 8)
  private readonly approvals = new Map<string, Approval>()
  private readonly questions = new Map<string, PendingInteraction[]>()
  private readonly inspected = new Map<string, { at: number; lastSeq: number; events: SyncedEvent[]; attachments: Set<string> }>()
  private readonly inflight = new Map<string, Promise<CommandResult>>()
  private readonly entryListeners = new Map<string, Set<(entry: SessionEntry) => void>>()
  private readonly anyEntryListeners = new Set<(entry: SessionEntry, previous: SessionEntry | undefined) => void>()
  private refreshing?: Promise<void>
  /** Sessions DSH reported as changed since they were last read. */
  private readonly dirty = new Set<string>()
  private again = false
  private readonly controller = new AbortController()

  constructor(private readonly options: ExecutorOptions) { this.host = options.host }

  /** Follow DSH's session and workspace state until {@link close}. */
  start(): void {
    const signal = this.controller.signal
    const stopChanges = this.host.onSessionChange(sessionId => { if (sessionId) this.dirty.add(sessionId); this.schedule() })
    signal.addEventListener('abort', stopChanges, { once: true })
    void this.loop('workspaces', async () => {
      for await (const state of this.host.workspaces(signal)) {
        this.workspaceState = state
        this.workspaceRev = ++this.rev
        this.schedule()
        this.options.changed()
      }
    })
    void this.loop('questions', async () => {
      for await (const { sessionId, active } of this.host.questions(signal)) {
        const open = openQuestions(active)
        if (JSON.stringify(open.map(q => q.id)) === JSON.stringify((this.questions.get(sessionId) ?? []).map(q => q.id))) continue
        if (open.length) this.questions.set(sessionId, open); else this.questions.delete(sessionId)
        this.schedule()
      }
    })
    void (async () => {
      while (!signal.aborted) {
        await this.refresh().catch(error => this.options.log?.(`Could not read sessions: ${String(error)}`))
        // Running sessions are reread on their own cadence; idle ones only when DSH reports a change.
        const running = [...this.entries.values()].some(entry => entry.state !== 'idle')
        await sleep(running ? this.rereadMs() : 30_000, signal)
      }
    })()
  }

  close(): void { this.controller.abort() }

  private rereadMs(): number { return this.options.watched?.() === false ? RUNNING_REREAD_IDLE_MS : RUNNING_REREAD_MS }

  /** Every entry change, with the entry before it; for notifications. */
  onEntry(listener: (entry: SessionEntry, previous: SessionEntry | undefined) => void): () => void {
    this.anyEntryListeners.add(listener)
    return () => { this.anyEntryListeners.delete(listener) }
  }

  private async loop(label: string, body: () => Promise<void>): Promise<void> {
    const signal = this.controller.signal
    while (!signal.aborted) {
      try {
        if (this.host.ready()) await body()
      } catch (error) { if (!signal.aborted) this.options.log?.(`${label} stream ended: ${String(error)}`) }
      await sleep(this.host.ready() ? 2_000 : 5_000, signal)
    }
  }

  /** Read the session list again soon. */
  schedule(): void {
    if (this.refreshing) { this.again = true; return }
    void this.refresh().catch(error => this.options.log?.(`Could not read sessions: ${String(error)}`))
  }

  /** Bring every entry up to date with DSH. Concurrent calls share one pass, plus one more if asked during it. */
  refresh(): Promise<void> {
    if (this.refreshing) { this.again = true; return this.refreshing }
    this.refreshing = (async () => {
      try {
        do { this.again = false; await this.pass() } while (this.again && !this.controller.signal.aborted)
      } finally { this.refreshing = undefined }
    })()
    return this.refreshing
  }

  private async pass(): Promise<void> {
    if (!this.host.ready()) return
    const signal = this.controller.signal
    const summaries = await this.host.listSessions(signal)
    const membership = new Map<string, string>()
    for (const workspace of this.workspaceState.items) for (const id of workspace.sessionIds) membership.set(id, workspace.workspaceId)
    const archived = new Set(this.workspaceState.archivedSessionIds)
    const seen = new Set<string>()
    let changed = false
    const queue = [...summaries]
    const worker = async () => {
      for (let summary = queue.shift(); summary; summary = queue.shift()) {
        seen.add(summary.sessionId)
        try { if (await this.update(summary, membership.get(summary.sessionId), archived.has(summary.sessionId), signal)) changed = true }
        catch (error) { this.options.log?.(`Could not read session ${summary.sessionId}: ${String(error)}`) }
      }
    }
    await Promise.all(Array.from({ length: 4 }, worker))
    for (const entry of this.entries.values()) {
      if (seen.has(entry.sessionId) || entry.removed) continue
      this.put({ ...entry, removed: true, state: 'idle', pending: [] }); changed = true
      delete this.options.data.sessions[entry.sessionId]
      delete this.options.data.reads?.[entry.sessionId]
    }
    if (changed) { this.options.save(); this.options.changed() }
  }

  private async update(summary: HostSessionSummary, workspaceId: string | undefined, archived: boolean, signal: AbortSignal): Promise<boolean> {
    const id = summary.sessionId
    const cached = this.options.data.sessions[id]
    const hint = summary.projections?.kind === 'sequenced' ? summary.projections.asOfSeq : -1
    const recent = this.inspected.get(id)
    const dirty = this.dirty.delete(id)
    const stale = dirty || !cached || cached.updatedAt !== summary.updatedAt || cached.running !== summary.running || hint > cached.lastSeq
      || (summary.running && (!recent || Date.now() - recent.at >= this.rereadMs()))
    let info = cached
    if (stale) {
      const inspection = await this.host.inspect(id, signal)
      const record = this.remember(id, inspection)
      info = { updatedAt: summary.updatedAt, running: summary.running, lastSeq: record.lastSeq,
        title: titleOf(inspection.events), preview: firstPrompt(inspection.events), forkOf: summary.parentSessionId, approvals: openApprovals(inspection.events), model: modelOf(inspection.events) }
      this.options.data.sessions[id] = info
    }
    const values = summary.projections?.values ?? {}
    const projectedTitle = typeof values.title === 'string' ? values.title : (values.title as { title?: unknown } | null | undefined)?.title
    const selection = values.modelSelection as { next?: ModelSelection | null; lastUsed?: ModelSelection | null } | undefined
    const projectedModel = selection?.next ?? selection?.lastUsed ?? undefined
    const permission = (values.permissions as { currentValue?: unknown } | undefined)?.currentValue
    const pending: PendingInteraction[] = [
      ...[...this.approvals.values()].filter(a => a.sessionId === id).map(a => ({ kind: 'approval' as const, id: a.id, toolName: a.toolName, askedAt: a.askedAt, answerable: true,
        ...(a.callId ? { callId: a.callId } : {}), ...(a.reason ? { reason: a.reason } : {}) })),
      ...(info!.approvals ?? []).filter(a => a.kind === 'approval' && ![...this.approvals.values()].some(own => own.sessionId === id && own.callId !== undefined && own.callId === a.callId)),
      ...(this.questions.get(id) ?? []),
    ]
    const lastSeq = Math.max(info!.lastSeq, hint), mark = this.options.readMark?.(id)
    // A read counts once, at what the session shows when it is not running: later output here, also a turn of a DSH model
    // the shared history knows nothing of, is new. A turn followed from elsewhere is read when it has fully arrived.
    const reads = (this.options.data.reads ??= {})
    const newRead = mark !== undefined && !summary.running && reads[id]?.mark !== mark
    if (newRead) reads[id] = { mark, seq: lastSeq }
    const entry: SessionEntry = {
      sessionId: id, updatedAt: summary.updatedAt, lastSeq, archived,
      ...(reads[id] ? { readSeq: reads[id].seq } : {}),
      state: pending.length > 0 && summary.running ? 'waiting' : summary.running ? 'running' : 'idle',
      pending: summary.running ? pending : [],
      ...(workspaceId ? { workspaceId } : {}),
      ...(typeof projectedTitle === 'string' && projectedTitle ? { title: projectedTitle } : info!.title ? { title: info!.title } : info!.preview ? { title: info!.preview } : {}),
      ...(summary.cwd ? { cwd: summary.cwd } : {}),
      ...(info!.forkOf ? { forkOf: info!.forkOf } : {}),
      ...(summary.parentSessionId ? { parentSessionId: summary.parentSessionId } : {}),
      ...(summary.origin ? { origin: summary.origin } : {}),
      ...(projectedModel?.provider ? { model: projectedModel } : info!.model ? { model: info!.model } : {}),
      ...(typeof permission === 'string' && permission ? { permission } : {}),
      ...(summary.blank ? { blank: true } : {}),
    }
    return this.put(entry) || newRead
  }

  /** Store an entry; bump its revision when it differs. */
  private put(entry: SessionEntry): boolean {
    const old = this.entries.get(entry.sessionId)
    if (old) {
      const { rev: _rev, ...previous } = old
      if (JSON.stringify(previous) === JSON.stringify(entry)) return false
    }
    this.entries.set(entry.sessionId, { ...entry, rev: ++this.rev })
    for (const listener of this.entryListeners.get(entry.sessionId) ?? []) listener(entry)
    const before = old ? (({ rev: _rev, ...rest }) => rest)(old) : undefined
    for (const listener of this.anyEntryListeners) { try { listener(entry, before) } catch (error) { this.options.log?.(`Entry listener failed: ${String(error)}`) } }
    return true
  }

  private remember(sessionId: string, inspection: HostInspection) {
    const events: SyncedEvent[] = []
    const attachments = new Set<string>()
    for (const event of inspection.events) {
      const shared = shareEvent(event)
      if (!shared) continue
      events.push(shared)
      for (const ref of attachmentRefs(shared)) attachments.add(ref.attachmentId)
    }
    const record = { at: Date.now(), lastSeq: inspection.events.at(-1)?.seq ?? -1, events, attachments }
    this.inspected.set(sessionId, record)
    // A few sessions' worth; long logs are reread when needed.
    while (this.inspected.size > 12) this.inspected.delete(this.inspected.keys().next().value!)
    return record
  }

  private async read(sessionId: string, atLeast: number, signal: AbortSignal) {
    const recent = this.inspected.get(sessionId)
    if (recent && recent.lastSeq >= atLeast && Date.now() - recent.at < RUNNING_REREAD_MS) return recent
    return this.remember(sessionId, await this.host.inspect(sessionId, signal))
  }

  /** The revision a cursor stands for; -1 for a cursor from another process or none. */
  afterOf(since: string | undefined): number {
    const [epoch, value] = (since ?? '').split('.')
    return epoch === this.epoch && value !== '' && Number.isFinite(Number(value)) ? Number(value) : -1
  }

  /** Changes since a cursor from {@link changes}; an unknown cursor means everything. */
  changes(since: string | undefined): { cursor: string; workspaces?: WorkspaceEntry[]; sessions: SessionEntry[] } {
    const after = this.afterOf(since)
    const sessions = [...this.entries.values()].filter(entry => entry.rev > after).map(({ rev: _rev, ...entry }) => entry)
    return {
      cursor: `${this.epoch}.${this.rev}`,
      sessions,
      ...(this.workspaceRev > after ? { workspaces: this.workspaceEntries() } : {}),
    }
  }

  /** The cursor {@link changes} would return now. */
  cursor(): string { return `${this.epoch}.${this.rev}` }

  workspaceEntries(): WorkspaceEntry[] {
    return this.workspaceState.items.map((item, order) => ({ workspaceId: item.workspaceId, title: item.title, path: item.path, sessionIds: [...item.sessionIds], order }))
  }

  entry(sessionId: string): SessionEntry | undefined {
    const entry = this.entries.get(sessionId)
    if (!entry || entry.removed) return undefined
    const { rev: _rev, ...rest } = entry
    return rest
  }

  /**
   * A page of shared events, in order. With `after`, the events following it (`hasMore` when the page filled up);
   * otherwise the latest events before `before` (or the end), for reading a long conversation from its end
   * (`hasEarlier` when older ones remain).
   */
  async events(sessionId: string, page: { after?: number; before?: number; limit: number }, signal: AbortSignal): Promise<{ events: SyncedEvent[]; lastSeq: number; hasMore: boolean; hasEarlier: boolean }> {
    if (!this.entry(sessionId)) throw new CommandError('Unknown session', 404)
    const record = await this.read(sessionId, this.entries.get(sessionId)!.lastSeq, signal)
    const limit = Math.max(1, Math.min(page.limit, 500))
    if (page.after !== undefined) {
      const events: SyncedEvent[] = []
      let bytes = 0, hasMore = false
      for (const event of record.events) {
        if (event.seq <= page.after) continue
        const size = JSON.stringify(event).length
        if (events.length >= limit || (events.length > 0 && bytes + size > MAX_EVENTS_BYTES)) { hasMore = true; break }
        events.push(event); bytes += size
      }
      return { events, lastSeq: record.lastSeq, hasMore, hasEarlier: record.events.some(event => event.seq <= page.after!) }
    }
    const before = page.before ?? Number.POSITIVE_INFINITY
    const events: SyncedEvent[] = []
    let bytes = 0, index = record.events.length - 1
    while (index >= 0 && record.events[index].seq >= before) index--
    for (; index >= 0; index--) {
      const event = record.events[index], size = JSON.stringify(event).length
      if (events.length >= limit || (events.length > 0 && bytes + size > MAX_EVENTS_BYTES)) break
      events.unshift(event); bytes += size
    }
    return { events, lastSeq: record.lastSeq, hasMore: false, hasEarlier: index >= 0 }
  }

  /** Whether an attachment appears in what this session shares; others are never served. */
  async sharesAttachment(sessionId: string, attachmentId: string, signal: AbortSignal): Promise<HostAttachmentRef | undefined> {
    if (!this.entry(sessionId)) return undefined
    const record = await this.read(sessionId, this.entries.get(sessionId)!.lastSeq, signal)
    if (!record.attachments.has(attachmentId)) return undefined
    for (const event of record.events) for (const ref of attachmentRefs(event)) if (ref.attachmentId === attachmentId) return ref
    return undefined
  }

  /**
   * Follow one session live. The first frame is `open`; each `event` frame says which event came before it, so a
   * mirror can tell whether it missed one in between.
   */
  live(sessionId: string, signal: AbortSignal): AsyncIterable<LiveFrame> {
    const queue = new AsyncQueue<LiveFrame>()
    const entry = this.entry(sessionId)
    if (!entry) { queue.push({ type: 'error', message: 'Unknown session' }); queue.close(); return queue }
    queue.push({ type: 'open', lastSeq: entry.lastSeq, entry })
    const listeners = this.entryListeners.get(sessionId) ?? new Set()
    const onEntry = (next: SessionEntry) => queue.push({ type: 'status', entry: next })
    listeners.add(onEntry); this.entryListeners.set(sessionId, listeners)
    const ping = setInterval(() => queue.push({ type: 'ping' }), 15_000)
    const stop = () => {
      clearInterval(ping); listeners.delete(onEntry)
      if (listeners.size === 0) this.entryListeners.delete(sessionId)
      queue.close()
    }
    signal.addEventListener('abort', stop, { once: true })
    void (async () => {
      let previous: number | undefined
      const drafts = new Map<string, { text: string; reasoning: string; sent: number; timer?: ReturnType<typeof setTimeout> }>()
      const flush = (attemptId: string, done = false) => {
        const draft = drafts.get(attemptId)
        if (!draft) return
        clearTimeout(draft.timer); draft.timer = undefined
        // A reply with nothing to read yet, as at a block's start, leaves the phone's "working" line alone.
        if (!done && !draft.text && !draft.reasoning) return
        draft.sent = Date.now()
        // The latest 64 KB is enough to watch a long answer being written.
        queue.push({ type: 'draft', attemptId, text: draft.text.slice(-65_536), reasoning: draft.reasoning.slice(-16_384), ...(done ? { done: true } : {}) })
        if (done) drafts.delete(attemptId)
      }
      try {
        for await (const frame of this.host.follow(sessionId, signal)) {
          if (frame.type === 'snapshot') {
            previous = frame.cursor
            // A phone that opens or reconnects during a reply gets what was written of it so far.
            const active = frame.assistantStream?.activeAttempt
            if (active) {
              const draft = { text: '', reasoning: '', sent: 0 }
              for (const record of active.stream) addToDraft(draft, record)
              drafts.set(active.attemptId, draft)
              flush(active.attemptId)
            }
            continue
          }
          if (frame.type === 'event') {
            const after = previous ?? frame.event.seq - 1
            previous = frame.event.seq
            const shared = shareEvent(frame.event)
            queue.push({ type: 'event', after, through: frame.event.seq, ...(shared ? { event: shared } : {}) })
            if (frame.event.type === 'turn/end' || frame.event.type === 'approval/asked' || frame.event.type === 'approval/decided') this.schedule()
            continue
          }
          const stream = frame.frame
          if (stream.type === 'start') drafts.set(stream.attemptId, { text: '', reasoning: '', sent: 0 })
          else if (stream.type === 'chunk') {
            const draft = drafts.get(stream.attemptId) ?? { text: '', reasoning: '', sent: 0 }
            drafts.set(stream.attemptId, draft)
            addToDraft(draft, stream.chunk)
            if (Date.now() - draft.sent > 200) flush(stream.attemptId)
            else draft.timer ??= setTimeout(() => flush(stream.attemptId), 200)
          } else if (stream.type === 'end') flush(stream.attemptId, true)
        }
      } catch (error) {
        if (!signal.aborted) queue.push({ type: 'error', message: error instanceof Error ? error.message : String(error) })
      } finally { for (const draft of drafts.values()) clearTimeout(draft.timer); stop() }
    })()
    return queue
  }

  /**
   * Run a request from a paired machine, or from this one. A request ID that already succeeded returns the same
   * result without running again, so a retry after a lost response is harmless.
   */
  command(command: Command): Promise<CommandResult> {
    const requestId = typeof command?.requestId === 'string' ? command.requestId.trim() : ''
    if (!/^[\w.:-]{8,128}$/.test(requestId)) return Promise.reject(new CommandError('Invalid request ID'))
    const done = this.options.data.handled[requestId]
    if (done) return Promise.resolve(done.result)
    const running = this.inflight.get(requestId)
    if (running) return running
    const task = this.run({ ...command, requestId } as Command).then(result => {
      this.options.data.handled[requestId] = { at: Date.now(), result }
      for (const [id, handled] of Object.entries(this.options.data.handled)) if (Date.now() - handled.at > HANDLED_TTL) delete this.options.data.handled[id]
      this.options.save()
      return result
    }).finally(() => this.inflight.delete(requestId))
    this.inflight.set(requestId, task)
    return task
  }

  private async run(command: Command): Promise<CommandResult> {
    const signal = AbortSignal.timeout(60_000)
    if (!this.host.ready()) throw new CommandError('DSH is still starting on this machine', 503)
    if (command.kind === 'create') {
      if (!this.workspaceState.items.some(item => item.workspaceId === command.workspaceId)) throw new CommandError('Unknown workspace', 404)
      const content = promptContent(command.content)
      const model = command.model === undefined ? undefined : modelSelection(command.model)
      const permission = typeof command.permission === 'string' && command.permission ? command.permission.slice(0, 200) : undefined
      const sessionId = await this.host.create(command.workspaceId, permission)
      if (model) await this.host.selectModel(sessionId, model)
      await this.host.prompt({ sessionId, requestId: `${command.requestId}:first`, mode: 'queue', content }, signal)
      this.schedule()
      return { ok: true, sessionId }
    }
    const sessionId = typeof command.sessionId === 'string' ? command.sessionId : ''
    if (!this.entry(sessionId)) throw new CommandError('This session is not on this machine', 404)
    switch (command.kind) {
      case 'prompt':
        await this.host.prompt({ sessionId, requestId: command.requestId, mode: command.mode === 'steer' ? 'steer' : 'queue', content: promptContent(command.content) }, signal)
        break
      case 'cancel': this.host.cancel(sessionId); break
      case 'archive': await this.host.archive(sessionId, command.archived === true); break
      case 'rename': {
        const title = typeof command.title === 'string' ? command.title.trim().slice(0, 200) : ''
        if (!title) throw new CommandError('Enter a title')
        await this.host.rename(sessionId, title)
        break
      }
      case 'model': await this.host.selectModel(sessionId, modelSelection(command.model)); break
      case 'approval': {
        const approval = this.approvals.get(command.approvalId)
        if (!approval || approval.sessionId !== sessionId) throw new CommandError('This confirmation is no longer pending', 409)
        if (command.outcome !== 'allowed-once' && command.outcome !== 'rejected') throw new CommandError('Invalid answer')
        approval.resolve(command.outcome)
        // Withdraw it now rather than when DSH's chain finishes, so it cannot be answered twice.
        this.approvals.delete(approval.id)
        break
      }
      case 'answer': {
        if (!Array.isArray(command.answers)) throw new CommandError('Invalid answer')
        const answers = command.answers.map(a => ({ id: String(a.id), selected: Array.isArray(a.selected) ? a.selected.map(String) : [], ...(typeof a.custom === 'string' ? { custom: a.custom } : {}) }))
        if (!await this.host.answerQuestion(sessionId, String(command.callId), answers)) throw new CommandError('This question is no longer open', 409)
        break
      }
      default: throw new CommandError('Unknown request')
    }
    this.schedule()
    return { ok: true, sessionId }
  }

  /** The approval bridge: offer each question to paired machines that may answer it. */
  readonly approvalBridge = (ask: ApprovalAsk, signal: AbortSignal) => {
    if (!this.options.approvalPeers()) return undefined
    const id = randomUUID()
    const answer = new Promise<'allowed-once' | 'rejected'>(resolve => {
      this.approvals.set(id, { id, sessionId: ask.sessionId, toolName: ask.toolName, callId: ask.callId, reason: ask.reason, askedAt: Date.now(), resolve })
    })
    signal.addEventListener('abort', () => { this.approvals.delete(id); this.schedule() }, { once: true })
    this.schedule()
    return { answer, wait: true }
  }
}

function modelSelection(value: unknown): ModelSelection {
  const model = value as Record<string, unknown> | undefined
  if (typeof model?.provider !== 'string' || typeof model.model !== 'string' || !model.provider || !model.model) throw new CommandError('Choose a model')
  return { provider: model.provider.slice(0, 200), model: model.model.slice(0, 500), ...(typeof model.reasoningEffort === 'string' && model.reasoningEffort ? { reasoningEffort: model.reasoningEffort.slice(0, 100) } : {}) }
}

function promptContent(parts: unknown): PromptPart[] {
  if (!Array.isArray(parts) || parts.length === 0 || parts.length > 20) throw new CommandError('Write a message')
  let text = 0
  const content: PromptPart[] = []
  for (const part of parts) {
    const value = part as Record<string, unknown>
    if (value?.type === 'text' && typeof value.text === 'string') { text += value.text.length; content.push({ type: 'text', text: value.text }) }
    else if (value?.type === 'image' && typeof value.data === 'string' && typeof value.mediaType === 'string' && /^image\/(png|jpeg|gif|webp)$/.test(value.mediaType)) {
      if (value.data.length > MAX_IMAGE_BASE64) throw new CommandError('Images are at most 10 MB')
      content.push({ type: 'image', mediaType: value.mediaType, data: value.data, ...(typeof value.name === 'string' ? { name: value.name.slice(0, 200) } : {}) })
    } else throw new CommandError('Unsupported message content')
  }
  if (text > MAX_TEXT) throw new CommandError('The message is too long')
  if (!content.some(part => part.type === 'image' || part.text.trim() !== '')) throw new CommandError('Write a message')
  return content
}
