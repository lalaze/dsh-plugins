/**
 * Which session events reach a phone, and in what form. A phone reads and steers, it does not resume the session,
 * so it gets what a person reads (messages, tool calls and results, titles, confirmations) and not what only the
 * model needs: system prompts, request headers, and the token-by-token stream an assistant message contains in full.
 *
 * Adapted from dsh-device-sync's `server/events.ts`.
 */
import type { ModelSelection, PendingInteraction, SyncedEvent } from '../../shared/protocol.js'
import type { HostAttachmentRef, HostEvent } from './host.js'

const SHARED = new Set([
  'user/message', 'assistant/message', 'tool/call', 'tool/result', 'turn/start', 'turn/end',
  'session/title', 'approval/asked', 'approval/decided', 'model/selection', 'session/end-seed',
])

type Dict = Record<string, unknown>
const asDict = (value: unknown): Dict => (typeof value === 'object' && value !== null ? value as Dict : {})

/** The shared form of one event, or undefined when it stays on its machine. */
export function shareEvent(event: HostEvent): SyncedEvent | undefined {
  if (!SHARED.has(event.type)) return undefined
  let data = event.data
  if (event.type === 'assistant/message') {
    const { stream: _stream, ...rest } = asDict(data)
    data = rest
  }
  return { type: event.type, seq: event.seq, time: event.time, data }
}

/** Images and files a shared event refers to. */
export function attachmentRefs(event: SyncedEvent): HostAttachmentRef[] {
  const content = asDict(asDict(event.data).message).content ?? asDict(event.data).content
  if (!Array.isArray(content)) return []
  const refs: HostAttachmentRef[] = []
  for (const block of content) {
    const { type, attachment } = asDict(block)
    const ref = asDict(attachment)
    if ((type === 'image' || type === 'file') && typeof ref.attachmentId === 'string') {
      refs.push({ ...ref, attachmentId: ref.attachmentId, kind: type,
        mediaType: typeof ref.mediaType === 'string' ? ref.mediaType : undefined,
        name: typeof ref.name === 'string' ? ref.name : undefined,
        bytes: typeof ref.bytes === 'number' ? ref.bytes : undefined })
    }
  }
  return refs
}

/** The model of the latest `model/selection` in a log. */
export function modelOf(events: readonly { type: string; data: unknown }[]): ModelSelection | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type !== 'model/selection') continue
    const data = asDict(events[i].data), selection = data.provider ? data : asDict(data.selection ?? data.next ?? data.model)
    if (typeof selection.provider === 'string' && typeof selection.model === 'string') {
      return { provider: selection.provider, model: selection.model, ...(typeof selection.reasoningEffort === 'string' ? { reasoningEffort: selection.reasoningEffort } : {}) }
    }
  }
  return undefined
}

/** Text of the latest assistant message, for a notification. */
export function lastAssistantText(events: readonly { type: string; data: unknown }[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type !== 'assistant/message') continue
    const content = asDict(asDict(events[i].data).message).content
    const text = Array.isArray(content) ? content.map(block => (asDict(block).type === 'text' ? String(asDict(block).text ?? '') : '')).join('').trim() : ''
    if (text) return text
  }
  return undefined
}

/** Latest title in a log. */
export function titleOf(events: readonly { type: string; data: unknown }[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'session/title') {
      const title = asDict(events[i].data).title
      if (typeof title === 'string' && title.trim()) return title
    }
  }
  return undefined
}

/** Approvals asked in a log and not yet decided. They show as waiting even when this plugin cannot answer them. */
export function openApprovals(events: readonly { type: string; time: number; data: unknown }[]): PendingInteraction[] {
  const open = new Map<string, PendingInteraction>()
  for (const event of events) {
    // A turn that ended cannot still be waiting.
    if (event.type === 'turn/end') { open.clear(); continue }
    const data = asDict(event.data), id = typeof data.id === 'string' ? data.id : undefined
    if (!id) continue
    if (event.type === 'approval/asked') {
      open.set(id, { kind: 'approval', id, toolName: String(data.toolName ?? ''), askedAt: event.time, answerable: false,
        ...(typeof data.callId === 'string' ? { callId: data.callId } : {}), ...(typeof data.reason === 'string' ? { reason: data.reason } : {}) })
    } else if (event.type === 'approval/decided') open.delete(id)
  }
  return [...open.values()]
}

/** DSH `userQuestions.active` entries still open, in the shared form. */
export function openQuestions(active: unknown, now = Date.now()): PendingInteraction[] {
  if (!Array.isArray(active)) return []
  const result: PendingInteraction[] = []
  for (const item of active) {
    const call = asDict(item)
    if (typeof call.callId !== 'string' || !Array.isArray(call.questions) || (call.state !== undefined && call.state !== 'open')) continue
    const questions = call.questions.map(asDict).filter(q => typeof q.id === 'string' && typeof q.question === 'string').map(q => ({
      id: String(q.id), question: String(q.question),
      ...(typeof q.header === 'string' ? { header: q.header } : {}),
      ...(typeof q.detail === 'string' ? { detail: q.detail } : {}),
      ...(Array.isArray(q.options) ? { options: q.options.map(asDict).filter(o => typeof o.label === 'string').map(o => ({ label: String(o.label), ...(typeof o.description === 'string' ? { description: o.description } : {}) })) } : {}),
      ...(typeof q.multiSelect === 'boolean' ? { multiSelect: q.multiSelect } : {}),
    }))
    if (questions.length > 0) result.push({ kind: 'question', id: call.callId, callId: call.callId, questions, askedAt: now })
  }
  return result
}

/** Text of an assistant stream chunk, by kind. */
export function chunkText(chunk: unknown): { text?: string; reasoning?: string } {
  const value = asDict(chunk)
  if (value.type === 'text-delta' && typeof value.text === 'string') return { text: value.text }
  if (value.type === 'reasoning-delta' && typeof value.text === 'string') return { reasoning: value.text }
  if (value.type === 'text-chunks' && Array.isArray(value.texts)) return { text: value.texts.join('') }
  if (value.type === 'reasoning-chunks' && Array.isArray(value.texts)) return { reasoning: value.texts.join('') }
  return {}
}
