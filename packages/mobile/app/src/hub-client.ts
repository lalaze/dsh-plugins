/**
 * The phone's connection to one paired machine through its relay: handshake, requests, live streams, and
 * reconnecting. It runs in the browser and, for tests, in Node.
 */
import { x25519 } from '@noble/curves/ed25519.js'
import { Channel, phoneHandshake, type Ready, type X25519 } from '../../src/shared/channel.js'
import type { HubInfo, HubMessage, Method, Methods, Offer } from '../../src/shared/protocol.js'

export const nobleX25519: X25519 = {
  generate() { const secretKey = x25519.utils.randomSecretKey(); return { secretKey, publicKey: x25519.getPublicKey(secretKey) } },
  shared: (secretKey, publicKey) => x25519.getSharedSecret(secretKey, publicKey),
}

/** A machine this phone knows, as stored on the phone. */
export interface SavedHub {
  hubId: string
  name: string
  /** This machine's X25519 key from the pairing code. */
  key: string
  relay: string
  tls: boolean
  /** Present while pairing; dropped once the machine confirmed. */
  token?: string
  phoneId?: string
}

export interface Identity { secretKey: Uint8Array; publicKey: Uint8Array }

export type ConnectionState = 'connecting' | 'online' | 'offline' | 'unpaired'

export const hubFromOffer = (offer: Offer): SavedHub => ({ hubId: offer.server, name: offer.name, key: offer.key, relay: offer.relay, tls: offer.tls, token: offer.token })

export class RemoteError extends Error {
  override name = 'RemoteError'
  constructor(message: string, readonly code: string) { super(message) }
}

interface Pending { resolve(value: unknown): void; reject(error: Error): void }
interface Stream { method: Method; args: unknown; onFrame(frame: unknown): void; onRestart?(): void; id?: number; closed: boolean }

const PING_MS = 20_000
const RESPONSE_MS = 60_000

export class HubClient {
  state: ConnectionState = 'offline'
  error?: string
  info?: HubInfo
  private socket?: WebSocket
  private channel?: Channel
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly streams = new Set<Stream>()
  private readonly listeners = new Set<() => void>()
  private readonly notices = new Set<(message: HubMessage) => void>()
  private closed = true
  private attempt = 0
  private retry?: ReturnType<typeof setTimeout>
  private ping?: ReturnType<typeof setInterval>
  private readonly Socket: typeof WebSocket

  constructor(readonly hub: SavedHub, private readonly identity: Identity, options: { WebSocket?: typeof WebSocket; x25519?: X25519 } = {}) {
    this.Socket = options.WebSocket ?? globalThis.WebSocket
    this.x25519 = options.x25519 ?? nobleX25519
  }
  private readonly x25519: X25519

  /** State changes: connection, info. */
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  /** Notifications from the machine. */
  onNotice(listener: (message: HubMessage) => void): () => void { this.notices.add(listener); return () => { this.notices.delete(listener) } }
  private emit() { for (const listener of this.listeners) listener() }

  private set(state: ConnectionState, error?: string) { this.state = state; this.error = error; this.emit() }

  connect(): void {
    if (!this.closed) { if (this.state === 'offline') this.reconnectNow(); return }
    this.closed = false
    this.open()
  }

  /** Try again right away, as when the page becomes visible or the network returns. */
  reconnectNow(): void {
    if (this.closed || this.state === 'online' || this.state === 'connecting' || this.state === 'unpaired') return
    clearTimeout(this.retry); this.retry = undefined
    this.attempt = 0
    this.open()
  }

  close(): void {
    this.closed = true
    clearTimeout(this.retry); clearInterval(this.ping)
    this.socket?.close(1000, 'Closed')
    this.socket = undefined; this.channel = undefined
    this.fail(new RemoteError('Disconnected', 'offline'))
    this.set('offline')
  }

  private url(): string {
    const { relay, tls, hubId } = this.hub
    const [host, port] = relay.startsWith('[') ? [relay.slice(0, relay.indexOf(']') + 1), relay.slice(relay.indexOf(']') + 2)] : relay.split(':')
    return `${tls ? 'wss' : 'ws'}://${host}:${port || (tls ? 443 : 80)}/ws?${new URLSearchParams({ serverId: hubId, role: 'client', v: '2' })}`
  }

  private open(): void {
    if (this.closed) return
    this.set('connecting', this.error)
    let socket: WebSocket
    try { socket = new this.Socket(this.url()) } catch (error) { this.lost(`Could not connect: ${(error as Error).message}`); return }
    socket.binaryType = 'arraybuffer'
    this.socket = socket
    let handshake: Awaited<ReturnType<typeof phoneHandshake>> | undefined
    const timer = setTimeout(() => { if (this.socket === socket && !this.channel) socket.close(4001, 'No answer') }, 15_000)
    socket.onopen = async () => {
      handshake = await phoneHandshake(this.x25519, this.identity, this.hub.key)
      if (this.socket === socket) socket.send(JSON.stringify(handshake.hello))
    }
    socket.onmessage = async event => {
      if (this.socket !== socket) return
      if (!this.channel) {
        if (typeof event.data !== 'string' || !handshake) return
        try {
          const keys = await handshake.finish(JSON.parse(event.data) as Ready)
          this.channel = new Channel(keys, frame => { if (socket.readyState === socket.OPEN) socket.send(frame as Uint8Array<ArrayBuffer>) })
          clearTimeout(timer)
          await this.ready()
        } catch (error) { socket.close(4002, (error as Error).message.slice(0, 100)) }
        return
      }
      if (typeof event.data === 'string') return
      let message: HubMessage | undefined
      try { message = await this.channel.receive(new Uint8Array(event.data as ArrayBuffer)) as HubMessage | undefined }
      catch { socket.close(4002, 'Invalid frame'); return }
      if (message) this.handle(message)
    }
    let opened = false
    socket.addEventListener('open', () => { opened = true }, { once: true })
    const ended = (reason: string) => {
      clearTimeout(timer)
      if (this.socket !== socket) return
      this.socket = undefined; this.channel = undefined
      clearInterval(this.ping)
      this.fail(new RemoteError('The connection was lost', 'offline'))
      if (this.state === 'unpaired') return
      this.lost(reason)
    }
    socket.onclose = event => ended(event.reason || (event.code === 1006 ? 'Could not reach the relay' : `Disconnected (${event.code})`))
    // Some WebSocket implementations report a refused handshake only as an error.
    socket.onerror = () => { if (!opened) ended('Could not reach the relay') }
  }

  private lost(error: string) {
    if (this.closed) return
    this.set('offline', error)
    this.attempt++
    clearTimeout(this.retry)
    this.retry = setTimeout(() => { this.retry = undefined; this.open() }, Math.min(30_000, [1000, 2000, 5000, 10_000][this.attempt - 1] ?? 30_000))
  }

  private async ready(): Promise<void> {
    let info = await this.request('hub.info', undefined)
    if (!info.phone && !info.pairing && this.hub.token) info = await this.request('pair.request', { token: this.hub.token, name: deviceName(), platform: platform() })
    this.info = info
    if (info.phone) { this.hub.phoneId = info.phone.id; delete this.hub.token }
    this.attempt = 0
    clearInterval(this.ping)
    this.ping = setInterval(() => { void this.request('ping', undefined).catch(() => { /* the socket closes if it is gone */ }) }, PING_MS)
    this.set(info.phone || info.pairing ? 'online' : 'unpaired', info.phone || info.pairing ? undefined : 'This phone is not paired with this machine')
    if (!info.phone && !info.pairing) { this.socket?.close(1000, 'Not paired'); return }
    for (const stream of this.streams) this.start(stream, true)
  }

  private handle(message: HubMessage) {
    if ('n' in message) {
      if (message.n === 'paired') {
        this.info = message.info
        if (message.info.phone) { this.hub.phoneId = message.info.phone.id; delete this.hub.token }
        this.emit()
        for (const stream of this.streams) if (stream.id === undefined) this.start(stream, false)
      } else if (message.n === 'unpaired') {
        this.info = undefined
        this.set('unpaired', message.message)
      }
      for (const listener of this.notices) listener(message)
      return
    }
    if ('f' in message) { for (const stream of this.streams) if (stream.id === message.id) stream.onFrame(message.f); return }
    if ('end' in message) {
      for (const stream of this.streams) if (stream.id === message.id) { stream.id = undefined; if (message.e && !stream.closed) stream.onFrame({ type: 'error', message: message.e.message }) }
      return
    }
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    if ('e' in message) pending.reject(new RemoteError(message.e.message, message.e.code)); else pending.resolve(message.r)
  }

  private fail(error: Error) {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    for (const stream of this.streams) stream.id = undefined
  }

  private request<M extends Method>(method: M, args: Methods[M]['args']): Promise<Methods[M]['result']> {
    const channel = this.channel
    if (!channel) return Promise.reject(new RemoteError(this.error ?? 'Not connected', 'offline'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { if (this.pending.delete(id)) reject(new RemoteError('This machine did not answer in time', 'timeout')) }, RESPONSE_MS)
      this.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value as Methods[M]['result']) }, reject: error => { clearTimeout(timer); reject(error) } })
      void channel.send({ id, m: method, ...(args === undefined ? {} : { a: args }) }).catch(error => { if (this.pending.delete(id)) { clearTimeout(timer); reject(error) } })
    })
  }

  /** Call a method once connected and paired. */
  call<M extends Exclude<Method, 'session.live' | 'cancel' | 'ping'>>(method: M, args: Methods[M]['args']): Promise<Methods[M]['result']> {
    if (this.state !== 'online') return Promise.reject(new RemoteError(this.error ?? 'Not connected', 'offline'))
    return this.request(method, args)
  }

  /**
   * Follow a stream. It starts again after every reconnect, calling `onRestart` first, until the handle is closed.
   */
  follow(method: 'session.live', args: Methods['session.live']['args'], onFrame: (frame: unknown) => void, onRestart?: () => void): { close(): void } {
    const stream: Stream = { method, args, onFrame, onRestart, closed: false }
    this.streams.add(stream)
    if (this.state === 'online' && this.channel) this.start(stream, false)
    return {
      close: () => {
        stream.closed = true
        this.streams.delete(stream)
        if (stream.id !== undefined && this.channel) void this.request('cancel', { id: stream.id }).catch(() => {})
      },
    }
  }

  private start(stream: Stream, restart: boolean) {
    if (stream.closed || !this.channel || !this.info?.phone) return
    if (restart) stream.onRestart?.()
    const id = this.nextId++
    stream.id = id
    void this.channel.send({ id, m: stream.method, a: stream.args }).catch(() => {})
  }
}

function platform(): string | undefined {
  const agent = globalThis.navigator?.userAgent ?? ''
  if (/iPhone|iPad|iPod/.test(agent)) return 'iOS'
  if (/Android/.test(agent)) return 'Android'
  if (/Macintosh/.test(agent)) return 'macOS'
  if (/Windows/.test(agent)) return 'Windows'
  return agent ? 'Browser' : undefined
}

function deviceName(): string {
  const system = platform()
  return system === 'iOS' ? 'iPhone' : system === 'Android' ? 'Android phone' : system ? `${system} browser` : 'Phone'
}
