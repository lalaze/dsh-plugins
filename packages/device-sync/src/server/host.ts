/**
 * The narrow part of DSH this plugin uses, behind one interface so the sync code can be tested without a host.
 * {@link dshHost} adapts DSH 0.2.1-rc.3's services: `sessionController` and `workspaceController` (cold reads, live
 * follow, prompt and cancel), `attachments`, `userQuestions`, and the `approval/request` event.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { QuestionAnswer } from '../shared/protocol.js'

export interface HostSessionSummary {
  sessionId: string
  updatedAt: number
  running: boolean
  blank: boolean
  parentSessionId?: string
  origin?: 'subagent'
  cwd?: string
  projections?: { kind: 'cached' | 'sequenced'; asOfSeq: number; values: Record<string, unknown> }
}
export interface HostEvent { type: string; seq: number; time: number; data: unknown; [key: string]: unknown }
export interface HostInspection { meta: { id: string; createdAt: number; cwd?: string; parentSession?: string; origin?: string }; events: readonly HostEvent[] }
export interface HostWorkspace { workspaceId: string; path: string; title: string; sessionIds: readonly string[] }
export interface HostWorkspaceState { items: HostWorkspace[]; archivedSessionIds: string[] }
export type HostFollowFrame =
  | { type: 'snapshot'; cursor: number; records: readonly { type: 'event'; event: HostEvent }[] }
  | { type: 'event'; event: HostEvent }
  | { type: 'assistant-stream'; frame: { type: 'start' | 'chunk' | 'end'; attemptId: string; chunk?: unknown; outcome?: { kind: string } } }
export type HostPromptPart = { type: 'text'; text: string } | { type: 'image'; mediaType: string; data: string; name?: string }
export interface HostImage { data: Uint8Array; mediaType: string }
export interface HostAttachmentRef { attachmentId: string; kind: 'image' | 'file'; mediaType?: string; name?: string; bytes?: number; [key: string]: unknown }

export interface ApprovalAsk {
  sessionId: string
  toolName: string
  callId?: string
  reason?: string
}
/**
 * Answers an approval from elsewhere while DSH's own answerers (open browsers) also get the question. `ask`
 * receives each question and returns a promise that settles with a remote answer, or never.
 */
export type ApprovalBridge = (ask: ApprovalAsk, signal: AbortSignal) => { answer: Promise<'allowed-once' | 'rejected'>; wait: boolean } | undefined

export interface HostApi {
  /** Whether the session services are present yet. */
  ready(): boolean
  listSessions(signal: AbortSignal): Promise<HostSessionSummary[]>
  inspect(sessionId: string, signal: AbortSignal): Promise<HostInspection>
  follow(sessionId: string, signal: AbortSignal): AsyncIterable<HostFollowFrame>
  prompt(input: { sessionId: string; requestId: string; mode: 'queue' | 'steer'; content: HostPromptPart[] }, signal: AbortSignal): Promise<void>
  cancel(sessionId: string): void
  create(workspaceId: string): Promise<string>
  answerQuestion(sessionId: string, callId: string, answers: QuestionAnswer[]): Promise<boolean>
  /** Open questions per session, from DSH's `userQuestions` projection. */
  questions(signal: AbortSignal): AsyncIterable<{ sessionId: string; active: unknown }>
  workspaces(signal: AbortSignal): AsyncIterable<HostWorkspaceState>
  readImage(ref: HostAttachmentRef, signal: AbortSignal): Promise<HostImage>
  readFile(ref: HostAttachmentRef, signal: AbortSignal): AsyncIterable<Uint8Array>
  /** Session list changes: an added, removed, or started or stopped session. */
  onSessionChange(listener: (sessionId: string) => void): () => void
  /** Route approval questions through `bridge`; DSH keeps asking its own answerers too. */
  bridgeApprovals(bridge: ApprovalBridge): () => void
}

type Dict = Record<string, unknown>
const asDict = (value: unknown): Dict => (typeof value === 'object' && value !== null ? value as Dict : {})

/** Adapt the running DSH host. Services are looked up on each call, so they may arrive after this plugin. */
export function dshHost(ctx: Context): HostApi {
  const get = (name: string) => ctx.get(name) as any
  const sessions = () => {
    const service = get('sessionController')
    if (!service) throw new Error('DSH sessions are not available yet')
    return service
  }
  return {
    ready: () => Boolean(get('sessionController') && get('workspaceController')),
    async listSessions(signal) {
      const value = await sessions().list({}, signal)
      return (asDict(value).items as HostSessionSummary[] | undefined) ?? []
    },
    async inspect(sessionId, signal) { return await sessions().inspect(sessionId, signal) as HostInspection },
    follow(sessionId, signal) {
      return sessions().follow({ address: { kind: 'session', sessionId }, assistantStream: true, maxMessages: 1 }, signal) as AsyncIterable<HostFollowFrame>
    },
    async prompt(input, signal) {
      await sessions().prompt({ requestId: input.requestId, sessionId: input.sessionId, mode: input.mode, content: input.content }, signal)
    },
    cancel(sessionId) { sessions().cancel({ sessionId }) },
    async create(workspaceId) { return (await sessions().create({ workspaceId })).sessionId as string },
    async answerQuestion(sessionId, callId, answers) {
      const service = get('userQuestions')
      if (typeof service?.answer !== 'function') throw new Error('This DSH version cannot answer questions from another machine')
      return await service.answer(sessionId, callId, { answers }) !== false
    },
    async *questions(signal) {
      for await (const frame of sessions().control(signal) as AsyncIterable<Dict>) {
        if (frame.type === 'baseline') {
          for (const [sessionId, baseline] of Object.entries(asDict(asDict(frame.value).projections))) {
            yield { sessionId, active: asDict(asDict(asDict(baseline).values).userQuestions).active }
          }
        } else if (frame.type === 'projection' && frame.key === 'userQuestions') {
          yield { sessionId: String(frame.sessionId), active: asDict(frame.value).active }
        }
      }
    },
    async *workspaces(signal) {
      const controller = get('workspaceController')
      if (!controller) throw new Error('DSH workspaces are not available yet')
      let state: HostWorkspaceState = { items: [], archivedSessionIds: [] }
      for await (const frame of controller.follow(signal) as AsyncIterable<Dict>) {
        const items = new Map(state.items.map(item => [item.workspaceId, item]))
        switch (frame.type) {
          case 'baseline': case 'replace': {
            const value = asDict(frame.value)
            state = { items: (value.items as HostWorkspace[] | undefined) ?? [], archivedSessionIds: (value.archivedSessionIds as string[] | undefined) ?? [] }
            break
          }
          case 'upsert': {
            const workspace = frame.workspace as HostWorkspace
            if (!items.has(workspace.workspaceId)) state = { ...state, items: [...state.items, workspace] }
            else state = { ...state, items: state.items.map(item => item.workspaceId === workspace.workspaceId ? workspace : item) }
            break
          }
          case 'remove': state = { ...state, items: state.items.filter(item => item.workspaceId !== frame.workspaceId) }; break
          case 'order': {
            const order = frame.workspaceIds as string[]
            state = { ...state, items: order.map(id => items.get(id)).filter((item): item is HostWorkspace => Boolean(item)) }
            break
          }
          case 'archived': state = { ...state, archivedSessionIds: frame.archivedSessionIds as string[] }; break
          default: continue
        }
        yield state
      }
    },
    async readImage(ref, signal) {
      const stored = asDict(await get('attachments').readImage(ref, signal))
      const data = stored.data instanceof Uint8Array ? stored.data : typeof stored.data === 'string' ? Buffer.from(stored.data, 'base64') : new Uint8Array()
      return { data, mediaType: String(stored.mediaType ?? ref.mediaType ?? 'application/octet-stream') }
    },
    readFile(ref, signal) { return get('attachments').readFileStream(ref, signal) },
    onSessionChange(listener) {
      const disposers = ['api-session/added', 'api-session/removed', 'api-session/status', 'api-session/activity'].map(event =>
        ctx.on(event as never, ((value: unknown) => { listener(typeof value === 'string' ? value : String(asDict(value).sessionId)) }) as never))
      return () => { for (const dispose of disposers) dispose() }
    },
    bridgeApprovals(bridge) { return bridgeApprovalEvent(ctx, bridge) },
  }
}

/**
 * Take part in DSH's `approval/request` waterfall without taking it over.
 *
 * The waterfall passes one request object along the chain, so a listener cannot give the answerers after it a
 * different cancellation signal. To withdraw the question from open browsers when another machine answers first,
 * this listener runs the chain again itself with a copy of the request whose signal it controls, and marks the copy
 * so it passes straight through when it reaches this listener. Any failure falls back to the unchanged chain.
 */
export function bridgeApprovalEvent(ctx: Context, bridge: ApprovalBridge): () => void {
  const copies = new WeakSet<object>()
  const listener = async function (this: unknown, request: Dict, next: () => Promise<string>): Promise<string> {
    if (copies.has(request)) return next()
    const agent = asDict(request.agent), sessionId = typeof agent.id === 'string' ? agent.id : undefined
    if (!sessionId || typeof request.toolName !== 'string') return next()
    const withdraw = new AbortController()
    const upstream = request.signal instanceof AbortSignal ? request.signal : undefined
    const signal = upstream ? AbortSignal.any([upstream, withdraw.signal]) : withdraw.signal
    let remote: ReturnType<ApprovalBridge>
    try {
      remote = bridge({ sessionId, toolName: request.toolName, callId: typeof request.callId === 'string' ? request.callId : undefined,
        reason: typeof request.reason === 'string' ? request.reason : undefined }, signal)
    } catch { remote = undefined }
    if (!remote) return next()
    const copy = { ...request, signal }
    copies.add(copy)
    const waterfall = ctx.waterfall as unknown as (...args: unknown[]) => Promise<string>
    const local = Promise.resolve().then(() => waterfall.call(ctx, this, 'approval/request', copy, () => Promise.resolve('unavailable')))
      .catch(() => 'unavailable')
    try {
      const first = await Promise.race([local.then(outcome => ({ from: 'local' as const, outcome })), remote.answer.then(outcome => ({ from: 'remote' as const, outcome }))])
      // No browser could answer here: wait for the other machine only when it is there to answer.
      if (first.from === 'local' && first.outcome === 'unavailable' && remote.wait && !signal.aborted) {
        return await Promise.race([remote.answer, new Promise<string>(resolve => signal.addEventListener('abort', () => resolve('cancelled'), { once: true }))])
      }
      return first.outcome
    } finally { withdraw.abort() }
  }
  return ctx.on('approval/request' as never, listener as never, true as never) as unknown as () => void
}
