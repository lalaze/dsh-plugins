import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestContext } from 'node:test'
import type { QuestionAnswer } from '../src/shared/protocol.js'
import type { ApprovalBridge, HostApi, HostAttachmentRef, HostEvent, HostFollowFrame, HostSessionSummary, HostWorkspaceState } from '../src/server/host.js'
import { AsyncQueue } from '../src/server/queue.js'
import { DeviceSync, type WorkspaceTagsService } from '../src/server/service.js'
import type { TagState } from '../src/server/groups.js'

interface FakeSession { id: string; events: HostEvent[]; running: boolean; updatedAt: number; cwd: string; parent?: string }

/** A DSH host with sessions in memory. A prompt is answered at once by a scripted assistant. */
export class FakeHost implements HostApi {
  readonly sessions = new Map<string, FakeSession>()
  workspaceState: HostWorkspaceState = { items: [], archivedSessionIds: [] }
  readonly prompts: { sessionId: string; requestId: string; text: string }[] = []
  readonly cancels: string[] = []
  readonly answers: { sessionId: string; callId: string; answers: QuestionAnswer[] }[] = []
  readonly images = new Map<string, Uint8Array>()
  bridge?: ApprovalBridge
  /** When false, prompts stay running until {@link finish}. */
  autoReply = true
  private readonly changes = new Set<(id: string) => void>()
  private readonly follows = new Map<string, Set<AsyncQueue<HostFollowFrame>>>()
  private readonly workspaceFollowers = new Set<AsyncQueue<HostWorkspaceState>>()
  readonly questionQueues = new Set<AsyncQueue<{ sessionId: string; active: unknown }>>()
  private counter = 0

  ready() { return true }

  addWorkspace(workspaceId: string, title: string, path = `/work/${title}`) {
    this.workspaceState = { ...this.workspaceState, items: [...this.workspaceState.items, { workspaceId, title, path, sessionIds: [] }] }
    for (const queue of this.workspaceFollowers) queue.push(this.workspaceState)
  }

  addSession(id: string, workspaceId?: string, title?: string): FakeSession {
    const session: FakeSession = { id, events: [], running: false, updatedAt: Date.now(), cwd: '/work' }
    this.sessions.set(id, session)
    if (workspaceId) {
      this.workspaceState = { ...this.workspaceState, items: this.workspaceState.items.map(w => w.workspaceId === workspaceId ? { ...w, sessionIds: [id, ...w.sessionIds] } : w) }
      for (const queue of this.workspaceFollowers) queue.push(this.workspaceState)
    }
    if (title) this.append(id, 'session/title', { title, messageSeqs: [], source: { kind: 'user' } })
    this.emit(id)
    return session
  }

  append(id: string, type: string, data: unknown): HostEvent {
    const session = this.sessions.get(id)!
    const event: HostEvent = { type, seq: session.events.length, time: Date.now() + this.counter++, data }
    session.events.push(event)
    if (type === 'user/message') session.updatedAt = event.time
    for (const queue of this.follows.get(id) ?? []) queue.push({ type: 'event', event })
    return event
  }

  stream(id: string, frame: Extract<HostFollowFrame, { type: 'assistant-stream' }>['frame']) {
    for (const queue of this.follows.get(id) ?? []) queue.push({ type: 'assistant-stream', frame })
  }

  emit(id: string) { for (const listener of this.changes) listener(id) }

  finish(id: string, text: string) {
    const session = this.sessions.get(id)!
    this.append(id, 'assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] }, stream: [{ type: 'text-chunks', texts: [text] }] })
    this.append(id, 'turn/end', { turn: 1, reason: 'completed' })
    session.running = false
    this.emit(id)
  }

  async listSessions(): Promise<HostSessionSummary[]> {
    return [...this.sessions.values()].map(s => ({ sessionId: s.id, updatedAt: s.updatedAt, running: s.running, blank: s.events.length === 0, cwd: s.cwd }))
  }
  async inspect(id: string) {
    const session = this.sessions.get(id)
    if (!session) throw new Error('no session')
    return { meta: { id, createdAt: 0, cwd: session.cwd, ...(session.parent ? { parentSession: session.parent } : {}) }, events: [...session.events] }
  }
  follow(id: string, signal: AbortSignal): AsyncIterable<HostFollowFrame> {
    const queue = new AsyncQueue<HostFollowFrame>()
    const session = this.sessions.get(id)!
    queue.push({ type: 'snapshot', cursor: session.events.at(-1)?.seq ?? -1, records: [] })
    const set = this.follows.get(id) ?? new Set()
    set.add(queue); this.follows.set(id, set)
    signal.addEventListener('abort', () => { set.delete(queue); queue.close() }, { once: true })
    return queue
  }
  async prompt(input: { sessionId: string; requestId: string; content: { type: string; text?: string }[] }) {
    const text = input.content.map(part => part.text ?? '').join('')
    this.prompts.push({ sessionId: input.sessionId, requestId: input.requestId, text })
    const session = this.sessions.get(input.sessionId)!
    session.running = true
    this.append(input.sessionId, 'turn/start', { turn: 1 })
    this.append(input.sessionId, 'user/message', { id: `m${this.counter}`, role: 'user', content: input.content, source: { kind: 'user', rpcId: input.requestId } })
    this.emit(input.sessionId)
    if (this.autoReply) setTimeout(() => this.finish(input.sessionId, `Reply to ${text}`), 20)
  }
  cancel(id: string) { this.cancels.push(id) }
  async create(workspaceId: string) {
    const id = `created-${this.sessions.size + 1}`
    this.addSession(id, workspaceId)
    return id
  }
  async answerQuestion(sessionId: string, callId: string, answers: QuestionAnswer[]) { this.answers.push({ sessionId, callId, answers }); return true }
  questions(signal: AbortSignal) {
    const queue = new AsyncQueue<{ sessionId: string; active: unknown }>()
    this.questionQueues.add(queue)
    signal.addEventListener('abort', () => queue.close(), { once: true })
    return queue
  }
  ask(sessionId: string, active: unknown) { for (const queue of this.questionQueues) queue.push({ sessionId, active }) }
  workspaces(signal: AbortSignal) {
    const queue = new AsyncQueue<HostWorkspaceState>()
    queue.push(this.workspaceState)
    this.workspaceFollowers.add(queue)
    signal.addEventListener('abort', () => { this.workspaceFollowers.delete(queue); queue.close() }, { once: true })
    return queue
  }
  async readImage(ref: HostAttachmentRef) { return { data: this.images.get(ref.attachmentId) ?? new Uint8Array(), mediaType: ref.mediaType ?? 'image/png' } }
  async *readFile(ref: HostAttachmentRef) { yield this.images.get(ref.attachmentId) ?? new Uint8Array() }
  onSessionChange(listener: (id: string) => void) { this.changes.add(listener); return () => { this.changes.delete(listener) } }
  bridgeApprovals(bridge: ApprovalBridge) { this.bridge = bridge; return () => { this.bridge = undefined } }
}

/** dsh-workspace-tags' host service, in memory. */
export class FakeTags implements WorkspaceTagsService {
  state: TagState = { tags: [], assignments: {} }
  private readonly listeners = new Set<(state: TagState) => void>()
  snapshot() { return structuredClone(this.state) }
  async replace(state: TagState) { this.state = structuredClone(state); this.fire(); return this.snapshot() }
  subscribe(listener: (state: TagState) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  /** A user edit in the sidebar. */
  edit(change: (state: TagState) => void) { change(this.state); this.fire() }
  private fire() { for (const listener of this.listeners) listener(this.snapshot()) }
}

export interface Node { sync: DeviceSync; host: FakeHost; tags: FakeTags; dir: string; home: string; port: number; endpoint: string }

let nextPort = 47700 + Math.floor(Math.random() * 1000)

export async function node(t: TestContext, name: string, options: { dir?: string; port?: number } = {}): Promise<Node> {
  const dir = options.dir ?? await mkdtemp(join(tmpdir(), `device-sync-${name}-`))
  const host = new FakeHost(), tags = new FakeTags()
  const port = options.port ?? nextPort++, home = join(dir, 'dsh-home')
  const sync = await DeviceSync.open({ stateDir: dir, host, tags: () => tags, listen: { host: '127.0.0.1', port }, intervalMs: 150, dshHome: home })
  // After hooks run in the order they were added: close before the directory goes.
  t.after(() => sync.close())
  if (!options.dir) t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }))
  await sync.action({ action: 'rename', name })
  await sync.start()
  await waitFor(async () => Boolean((await sync.status()).listener.address))
  return { sync, host, tags, dir, home, port, endpoint: `127.0.0.1:${port}` }
}

/** The placeholder folder remote-agents creates for a remote workspace, at `remote-workspaces/<folder>`. */
export async function remoteWorkspace(n: Node, folder: string, meta: Record<string, unknown>): Promise<string> {
  const path = join(n.home, 'remote-workspaces', ...folder.split('/'))
  await mkdir(path, { recursive: true })
  await writeFile(join(path, '.dsh-remote-meta.json'), JSON.stringify(meta))
  return path
}

/** Pair two nodes, confirming on both, and wait until each lists the other as paired. */
export async function pair(a: Node, b: Node, grants = { a: { history: true, command: true }, b: { history: true, command: true } }) {
  const outgoing = await a.sync.action({ action: 'pair', endpoint: b.endpoint, grants: grants.a }) as { pairingId: string; code: string }
  const incoming = (await b.sync.status()).pairings.find(p => p.direction === 'incoming')!
  if (incoming.code !== outgoing.code) throw new Error('codes differ')
  await b.sync.action({ action: 'confirmPairing', pairingId: incoming.pairingId, grants: grants.b })
  await a.sync.action({ action: 'confirmPairing', pairingId: outgoing.pairingId })
  await waitFor(async () => (await a.sync.status()).peers.length === 1 && (await b.sync.status()).peers.length === 1)
}

export async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 8_000, label = 'condition'): Promise<void> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for ${label}`)
}
