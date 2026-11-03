/**
 * Remote Agents' background tasks for phones: remote CLI sessions that have no DSH conversation, read and steered
 * through its `remoteAgentsTasks` service. Its records are turned into the phone's smaller shapes here.
 */
import type { TaskCommand, TaskEntry, TaskItem, TaskPage, TaskPermission } from '../shared/protocol.js'

interface Cursor { epoch: string; seq: number }
interface RemoteTask {
  id: string; title: string; provider: string; model: string; host: string; cwd: string; status: TaskEntry['status']
  delegated: boolean; ownerSessionId?: string; archived: boolean; createdAt: string; updatedAt: string; error?: string; creator?: string; controller?: string
}
interface RemoteEntry { seqStart: number; seqEnd: number; timestamp: string; item: Record<string, unknown> & { type: string } }
interface RemotePage { epoch: string; entries: RemoteEntry[]; hasOlder: boolean; hasNewer: boolean; startCursor: Cursor | null; endCursor: Cursor | null }
interface RemotePermission {
  id: string; name: string; kind: string; title?: string; description?: string; input?: Record<string, unknown>; detail?: unknown
  actions?: { id: string; label: string; behavior: 'allow' | 'deny' }[]
}

/** Remote Agents' `remoteAgentsTasks` service, version 1. */
export interface RemoteTasksService {
  readonly tasksVersion: number
  list(): Promise<RemoteTask[]>
  detail(id: string, cursor?: Cursor, direction?: 'before' | 'after'): Promise<{ task: RemoteTask; permissions: RemotePermission[]; timeline: RemotePage | null }>
  send(id: string, messageId: string, text: string): Promise<void>
  stop(id: string): Promise<void>
  respond(id: string, requestId: string, answer: { behavior: 'allow' | 'deny'; selectedActionId?: string }): Promise<void>
  subscribe?(listener: () => void): () => void
}

/** Only a version this hub understands is used; an older Remote Agents has no tasks service at all. */
export const usableTasks = (service: unknown): RemoteTasksService | undefined =>
  (service as RemoteTasksService | undefined)?.tasksVersion === 1 ? service as RemoteTasksService : undefined

const MAX_DETAIL = 4000
/** Backend pages hold 100 entries, often a few words each while a reply streams: one phone page reads several. */
const PAGES = 5
const clip = (text: string, max = MAX_DETAIL) => (text.length > max ? `${text.slice(0, max)}\n…` : text)
const time = (value: string | undefined) => { const ms = value ? Date.parse(value) : NaN; return Number.isFinite(ms) ? ms : 0 }
/** Main-chat prompts carry earlier DSH messages ahead of the request; the phone shows what the user typed. */
const CONTEXT = /^Conversation context \(already occurred; do not repeat completed actions\):\n[\s\S]*?\n\nCurrent user request:\n/
const detailText = (value: unknown) => typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value, null, 2) ?? ''

export function taskEntry(task: RemoteTask): TaskEntry {
  return {
    id: task.id, title: task.title, provider: task.provider, model: task.model, host: task.host, cwd: task.cwd, status: task.status,
    delegated: task.delegated, archived: task.archived, createdAt: time(task.createdAt), updatedAt: time(task.updatedAt),
    ...(task.ownerSessionId ? { ownerSessionId: task.ownerSessionId } : {}), ...(task.error ? { error: clip(task.error, 1000) } : {}),
    ...(task.creator ? { creator: task.creator } : {}), ...(task.controller ? { controller: task.controller } : {}),
  }
}

/** History entries as phone items: a reply's streamed pieces become one item, and a tool call shows its latest state. */
export function taskItems(entries: readonly RemoteEntry[]): TaskItem[] {
  const items: TaskItem[] = [], tools = new Map<string, TaskItem>()
  for (const entry of entries) {
    const item = entry.item, at = time(entry.timestamp), previous = items.at(-1)
    switch (item.type) {
      case 'user_message': items.push({ seq: entry.seqStart, time: at, type: 'user', text: clip(String(item.text ?? '').replace(CONTEXT, ''), 20_000) }); break
      case 'assistant_message': case 'reasoning': {
        const type = item.type === 'assistant_message' ? 'assistant' : 'reasoning', text = String(item.text ?? '')
        if (!text) break
        if (previous?.type === type) previous.text = (previous.text ?? '') + text; else items.push({ seq: entry.seqStart, time: at, type, text })
        break
      }
      case 'tool_call': {
        const callId = String(item.callId ?? entry.seqStart), known = tools.get(callId)
        const next: TaskItem = { seq: entry.seqStart, time: at, type: 'tool', callId, name: typeof item.name === 'string' && item.name ? item.name : 'Tool',
          ...(typeof item.status === 'string' ? { status: item.status } : {}), text: clip(detailText(item.detail)) }
        if (known) Object.assign(known, next, { seq: known.seq, time: known.time }); else { tools.set(callId, next); items.push(next) }
        break
      }
      case 'error': items.push({ seq: entry.seqStart, time: at, type: 'error', text: clip(String(item.message ?? ''), 2000) }); break
      case 'interrupted': items.push({ seq: entry.seqStart, time: at, type: 'interrupted' }); break
      case 'turn_end': items.push({ seq: entry.seqStart, time: at, type: 'end', ...(typeof item.status === 'string' ? { status: item.status } : {}) }); break
      default: break
    }
  }
  return items
}

export function taskPermission(permission: RemotePermission): TaskPermission {
  const detail = detailText(permission.input && Object.keys(permission.input).length ? permission.input : permission.detail)
  return {
    id: permission.id, title: permission.title || permission.name,
    ...(permission.description ? { description: clip(permission.description, 1000) } : {}),
    ...(detail ? { detail: clip(detail, 2000) } : {}),
    // A question needs its answers chosen on the computer; the phone only offers the plain choices.
    actions: permission.kind === 'question' ? [] : (permission.actions?.length ? permission.actions : [
      { id: '', label: 'Deny', behavior: 'deny' as const }, { id: '', label: 'Allow', behavior: 'allow' as const },
    ]).map(({ id, label, behavior }) => ({ id, label, behavior })),
  }
}

/** One phone page: the newest entries, or those before or after a sequence number of the same history. */
export async function taskDetail(service: RemoteTasksService, args: { taskId: string; before?: number; after?: number; epoch?: string }) {
  const direction = args.after !== undefined ? 'after' as const : 'before' as const
  const start = args.after ?? args.before
  let cursor: Cursor | undefined = start !== undefined && args.epoch ? { epoch: args.epoch, seq: start } : undefined
  let first = await service.detail(args.taskId, cursor, direction)
  const entries = [...first.timeline?.entries ?? []]
  let page = first.timeline, reset = !!page && !!args.epoch && page.epoch !== args.epoch
  // A replaced history is read again from its newest entries.
  if (reset) { first = await service.detail(args.taskId); page = first.timeline; entries.splice(0, entries.length, ...page?.entries ?? []) }
  const { task, permissions } = first
  let hasOlder = page?.hasOlder ?? false, hasNewer = page?.hasNewer ?? false
  const forward = direction === 'after' && !reset
  for (let i = 1; page && i < PAGES && (forward ? hasNewer : hasOlder); i++) {
    cursor = forward ? page.endCursor ?? undefined : page.startCursor ?? undefined
    if (!cursor) break
    const next = (await service.detail(args.taskId, cursor, forward ? 'after' : 'before')).timeline
    if (!next || next.epoch !== page.epoch) break
    if (forward) { entries.push(...next.entries); hasNewer = next.hasNewer } else { entries.unshift(...next.entries); hasOlder = next.hasOlder }
    page = next
  }
  const result: TaskPage = {
    epoch: page?.epoch ?? '', items: taskItems(entries), hasOlder, hasNewer,
    ...(entries.length ? { first: entries[0].seqStart, last: entries.at(-1)!.seqEnd } : {}),
    ...(reset ? { reset: true } : {}),
  }
  return { task: taskEntry(task), permissions: permissions.map(taskPermission), page: result }
}

export async function taskCommand(service: RemoteTasksService, command: TaskCommand): Promise<void> {
  const taskId = String(command.taskId ?? '')
  if (!taskId) throw new Error('Choose a task')
  switch (command.kind) {
    case 'send': {
      const text = String(command.text ?? '').trim()
      if (!text) throw new Error('Enter a message')
      await service.send(taskId, String(command.requestId), text.slice(0, 100_000)); return
    }
    case 'stop': await service.stop(taskId); return
    case 'respond': {
      if (command.behavior !== 'allow' && command.behavior !== 'deny') throw new Error('Choose allow or deny')
      await service.respond(taskId, String(command.permissionId), { behavior: command.behavior, ...(command.actionId ? { selectedActionId: command.actionId } : {}) }); return
    }
    default: throw new Error('Unknown task command')
  }
}

/** What the task list shows; a change in it is worth telling phones about. */
export const tasksFingerprint = (tasks: readonly TaskEntry[]) => JSON.stringify(tasks.map(task => [task.id, task.title, task.status, task.archived, task.updatedAt, task.error ?? '', task.controller ?? '']))
