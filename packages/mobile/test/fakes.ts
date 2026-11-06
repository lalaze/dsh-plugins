import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestContext } from 'node:test'
import { WebSocketServer, type WebSocket as Ws } from 'ws'
import type { ModelChoices, ModelSelection, QuestionAnswer } from '../src/shared/protocol.js'
import type { ApprovalBridge, HostApi, HostAttachmentRef, HostEvent, HostFollowFrame, HostSessionSummary, HostWorkspaceState } from '../src/server/bridge/host.js'
import { AsyncQueue } from '../src/server/bridge/queue.js'
import { Hub } from '../src/server/hub.js'

interface FakeSession { id: string; events: HostEvent[]; running: boolean; updatedAt: number; cwd: string; parent?: string }

/** A DSH host with sessions in memory. A prompt is answered at once by a scripted assistant unless `autoReply` is off. */
export class FakeHost implements HostApi {
  readonly sessions = new Map<string, FakeSession>()
  workspaceState: HostWorkspaceState = { items: [], archivedSessionIds: [] }
  readonly prompts: { sessionId: string; requestId: string; text: string; mode: string }[] = []
  readonly cancels: string[] = []
  readonly answers: { sessionId: string; callId: string; answers: QuestionAnswer[] }[] = []
  readonly selections: { sessionId: string; model: ModelSelection }[] = []
  readonly created: { workspaceId: string; permission?: string }[] = []
  readonly images = new Map<string, Uint8Array>()
  bridge?: ApprovalBridge
  autoReply = true
  /** The reply being written in a session, as DSH reports it to a follower that joins during it. */
  readonly activeAttempts = new Map<string, { attemptId: string; stream: unknown[] }>()
  private readonly changes = new Set<(id: string) => void>()
  private readonly follows = new Map<string, Set<AsyncQueue<HostFollowFrame>>>()
  private readonly workspaceFollowers = new Set<AsyncQueue<HostWorkspaceState>>()
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
    session.updatedAt = Date.now() + this.counter++
    this.emit(id)
  }

  async listSessions(): Promise<HostSessionSummary[]> {
    return [...this.sessions.values()].map(s => ({ sessionId: s.id, updatedAt: s.updatedAt, running: s.running, blank: s.events.length === 0, cwd: s.cwd, ...(s.parent ? { parentSessionId: s.parent } : {}) }))
  }
  async inspect(id: string) {
    const session = this.sessions.get(id)
    if (!session) throw new Error('no session')
    return { events: [...session.events] }
  }
  follow(id: string, signal: AbortSignal): AsyncIterable<HostFollowFrame> {
    const queue = new AsyncQueue<HostFollowFrame>()
    const session = this.sessions.get(id)!
    const activeAttempt = this.activeAttempts.get(id)
    queue.push({ type: 'snapshot', cursor: session.events.at(-1)?.seq ?? -1, records: [], ...(activeAttempt ? { assistantStream: { activeAttempt } } : {}) })
    const set = this.follows.get(id) ?? new Set()
    set.add(queue); this.follows.set(id, set)
    signal.addEventListener('abort', () => { set.delete(queue); queue.close() }, { once: true })
    return queue
  }
  async prompt(input: { sessionId: string; requestId: string; mode: string; content: { type: string; text?: string }[] }) {
    const text = input.content.map(part => part.text ?? '').join('')
    this.prompts.push({ sessionId: input.sessionId, requestId: input.requestId, text, mode: input.mode })
    const session = this.sessions.get(input.sessionId)!
    session.running = true
    this.append(input.sessionId, 'turn/start', { turn: 1 })
    this.append(input.sessionId, 'user/message', { id: `m${this.counter}`, role: 'user', content: input.content, source: { kind: 'user', rpcId: input.requestId } })
    this.emit(input.sessionId)
    if (this.autoReply) setTimeout(() => this.finish(input.sessionId, `Reply to ${text}`), 20)
  }
  cancel(id: string) { this.cancels.push(id) }
  async create(workspaceId: string, permission?: string) {
    this.created.push({ workspaceId, ...(permission ? { permission } : {}) })
    const id = `created-${this.sessions.size + 1}`
    this.addSession(id, workspaceId)
    return id
  }
  async modelChoices(): Promise<ModelChoices> {
    return { default: { provider: 'deepseek', model: 'chat' }, groups: [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'chat', name: 'Chat', efforts: [{ id: 'high', name: 'High' }] }] }], permissions: [{ value: 'workspace-write', name: 'Workspace write' }], defaultPermission: 'workspace-write' }
  }
  async selectModel(sessionId: string, model: ModelSelection) { this.selections.push({ sessionId, model }); this.append(sessionId, 'model/selection', model) }
  async archive(sessionId: string, archived: boolean) {
    const ids = new Set(this.workspaceState.archivedSessionIds)
    if (archived) ids.add(sessionId); else ids.delete(sessionId)
    this.workspaceState = { ...this.workspaceState, archivedSessionIds: [...ids] }
    for (const queue of this.workspaceFollowers) queue.push(this.workspaceState)
  }
  async rename(sessionId: string, title: string) { this.append(sessionId, 'session/title', { title, messageSeqs: [], source: { kind: 'user' } }); this.emit(sessionId) }
  async answerQuestion(sessionId: string, callId: string, answers: QuestionAnswer[]) { this.answers.push({ sessionId, callId, answers }); return true }
  questions(signal: AbortSignal) {
    const queue = new AsyncQueue<{ sessionId: string; active: unknown }>()
    signal.addEventListener('abort', () => queue.close(), { once: true })
    return queue
  }
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

/**
 * A relay speaking Paseo's protocol v2, in memory: a control socket per server ID, one data socket per phone, and
 * phone frames held until the machine's data socket joins. `allow` mimics a relay that only admits known IDs.
 */
export class FakeRelay {
  readonly server: Server
  private readonly wss = new WebSocketServer({ noServer: true })
  private readonly controls = new Map<string, Ws>()
  private readonly clients = new Map<string, { serverId: string; socket: Ws; held: { data: Buffer; binary: boolean }[] }>()
  private readonly data = new Map<string, Ws>()
  allow?: (serverId: string) => boolean
  port = 0

  constructor() {
    this.server = createServer((req, res) => { res.writeHead(this.allowed(req.url) ? 426 : 403).end(this.allowed(req.url) ? 'Expected WebSocket upgrade' : 'Forbidden\n') })
    this.server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://relay')
      if (url.pathname !== '/ws' || !this.allowed(req.url)) { socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'); return }
      this.wss.handleUpgrade(req, socket, head, ws => this.join(ws, url))
    })
  }

  private allowed(raw?: string) {
    const serverId = new URL(raw ?? '/', 'http://relay').searchParams.get('serverId') ?? ''
    return !this.allow || this.allow(serverId)
  }

  async listen(): Promise<string> {
    await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve))
    this.port = (this.server.address() as { port: number }).port
    return `ws://127.0.0.1:${this.port}`
  }

  async close() {
    for (const ws of this.wss.clients) ws.terminate()
    await new Promise<void>(resolve => this.server.close(() => resolve()))
  }

  /** Drop every phone connection, as a relay restart would. */
  dropPhones() { for (const { socket } of this.clients.values()) socket.terminate() }

  private join(ws: Ws, url: URL) {
    const serverId = url.searchParams.get('serverId') ?? '', role = url.searchParams.get('role'), connectionId = url.searchParams.get('connectionId')
    if (role === 'server' && !connectionId) {
      this.controls.get(serverId)?.close(1008, 'Replaced by new connection')
      this.controls.set(serverId, ws)
      ws.send(JSON.stringify({ type: 'sync', connectionIds: [...this.clients].filter(([, c]) => c.serverId === serverId).map(([id]) => id) }))
      ws.on('message', raw => { try { if (JSON.parse(String(raw)).type === 'ping') ws.send(JSON.stringify({ type: 'pong' })) } catch { /* ignore */ } })
      ws.on('close', () => { if (this.controls.get(serverId) === ws) this.controls.delete(serverId) })
      return
    }
    if (role === 'server' && connectionId) {
      const client = this.clients.get(connectionId)
      if (!client) { ws.close(1008, 'Unknown connection'); return }
      this.data.set(connectionId, ws)
      for (const frame of client.held.splice(0)) ws.send(frame.data, { binary: frame.binary })
      ws.on('message', (data, binary) => client.socket.send(data as Buffer, { binary }))
      ws.on('close', () => { if (this.data.get(connectionId) === ws) { this.data.delete(connectionId); client.socket.close(1012, 'Server disconnected') } })
      return
    }
    const id = `conn_${randomBytes(6).toString('hex')}`
    const client = { serverId, socket: ws, held: [] as { data: Buffer; binary: boolean }[] }
    this.clients.set(id, client)
    ws.on('message', (data, binary) => {
      const target = this.data.get(id)
      if (target) target.send(data as Buffer, { binary }); else client.held.push({ data: data as Buffer, binary })
    })
    ws.on('close', () => {
      this.clients.delete(id)
      this.data.get(id)?.close(1001, 'Client disconnected')
      this.controls.get(serverId)?.send(JSON.stringify({ type: 'disconnected', connectionId: id }))
    })
    this.controls.get(serverId)?.send(JSON.stringify({ type: 'connected', connectionId: id }))
  }
}

export interface TestHub { hub: Hub; host: FakeHost; relay: FakeRelay; dir: string }

export async function startHub(t: TestContext, options: { fetch?: typeof fetch; tasks?: () => unknown } = {}): Promise<TestHub> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mobile-'))
  const relay = new FakeRelay()
  const address = await relay.listen()
  const host = new FakeHost()
  const hub = await Hub.open({ stateDir: dir, host, version: '0.0.0-test', ...(options.tasks ? { tasks: options.tasks } : {}), defaults: { name: 'Test Mac', relay: address, appUrl: 'https://phone.example/app/' }, fetch: options.fetch })
  t.after(async () => { await hub.close(); await relay.close(); await rm(dir, { recursive: true, force: true }) })
  await hub.start()
  await waitFor(() => hub.status().relay.state === 'online', 5000, 'relay online')
  return { hub, host, relay, dir }
}

export async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 8_000, label = 'condition'): Promise<void> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`Timed out waiting for ${label}`)
}
