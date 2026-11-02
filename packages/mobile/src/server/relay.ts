/**
 * This machine's side of a Paseo-compatible relay (protocol v2). The relay only routes bytes: it never sees the
 * keys, so everything a phone and this machine say is encrypted end to end on top of it (see `shared/channel.ts`).
 *
 * One control socket (`role=server`) tells this machine which phones are connected; for each one this machine opens
 * a data socket (`role=server&connectionId=…`) that the relay joins to the phone's socket. A phone connects with
 * `role=client`, and the relay picks its connection ID.
 */
import type { RelayState } from '../shared/protocol.js'

export interface RelayOptions {
  /** `host:port`; the port defaults to 443 with TLS and 80 without. */
  endpoint: string
  tls: boolean
  serverId: string
  /** A phone connected; `socket` is open and joined to it. */
  accept(socket: WebSocket, connectionId: string): void
  onState?(state: RelayState, error?: string): void
  log?(message: string): void
  WebSocket?: typeof WebSocket
  fetch?: typeof fetch
}

type ControlMessage = { type: 'sync'; connectionIds: string[] } | { type: 'connected' | 'disconnected'; connectionId: string } | { type: 'ping' | 'pong' }

/** How long a silent control socket is trusted before it is replaced, in case the connection died unnoticed. */
const CONTROL_SILENCE_MS = 5 * 60_000
const CONTROL_PING_MS = 25_000
const DATA_OPEN_TIMEOUT_MS = 15_000

export function relayUrl(endpoint: string, tls: boolean, query: Record<string, string>): string {
  const { host, port } = parseEndpoint(endpoint, tls)
  const url = new URL(`${tls ? 'wss' : 'ws'}://${host.includes(':') ? `[${host}]` : host}:${port}/ws`)
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
  return url.toString()
}

export function parseEndpoint(endpoint: string, tls: boolean): { host: string; port: number } {
  const text = endpoint.trim().replace(/^(wss?|https?):\/\//i, '').replace(/\/.*$/, '')
  if (!text) throw new Error('Enter the relay address')
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(text)
  const [host, port] = v6 ? [v6[1], v6[2]] : text.includes(':') && text.indexOf(':') === text.lastIndexOf(':') ? text.split(':') : [text, undefined]
  const number = port === undefined ? (tls ? 443 : 80) : Number(port)
  if (!host || !Number.isInteger(number) || number < 1 || number > 65535) throw new Error(`Invalid relay address: ${endpoint}`)
  return { host, port: number }
}

function parseControl(raw: unknown): ControlMessage | undefined {
  try {
    const value = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw as ArrayBuffer)) as Record<string, unknown>
    if (value.type === 'sync' && Array.isArray(value.connectionIds)) return { type: 'sync', connectionIds: value.connectionIds.filter((id): id is string => typeof id === 'string' && id.trim() !== '') }
    if ((value.type === 'connected' || value.type === 'disconnected') && typeof value.connectionId === 'string' && value.connectionId.trim()) return { type: value.type, connectionId: value.connectionId.trim() }
    if (value.type === 'ping' || value.type === 'pong') return { type: value.type }
  } catch { /* not a control message */ }
  return undefined
}

export class Relay {
  state: RelayState = 'off'
  error?: string
  since?: number
  private stopped = true
  private control?: WebSocket
  private readonly data = new Map<string, WebSocket>()
  private attempt = 0
  private retry?: ReturnType<typeof setTimeout>
  private keepalive?: ReturnType<typeof setInterval>
  private lastSeen = 0
  private readonly Socket: typeof WebSocket

  constructor(private readonly options: RelayOptions) { this.Socket = options.WebSocket ?? globalThis.WebSocket }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.connect()
  }

  stop(): void {
    this.stopped = true
    clearTimeout(this.retry); clearInterval(this.keepalive)
    this.control?.close(1000, 'Stopped')
    this.control = undefined
    for (const socket of this.data.values()) socket.close(1000, 'Stopped')
    this.data.clear()
    this.set('off')
  }

  /** Phones connected right now through this relay. */
  get connections(): number { return this.data.size }

  private set(state: RelayState, error?: string) {
    if (this.state !== state) this.since = Date.now()
    this.state = state; this.error = error
    this.options.onState?.(state, error)
  }

  private url(query: Record<string, string> = {}) {
    return relayUrl(this.options.endpoint, this.options.tls, { serverId: this.options.serverId, role: 'server', v: '2', ...query })
  }

  private connect(): void {
    if (this.stopped) return
    let url: string
    try { url = this.url() } catch (error) { this.set('offline', (error as Error).message); return }
    if (this.state !== 'online') this.set('connecting', this.error)
    const socket = new this.Socket(url)
    socket.binaryType = 'arraybuffer'
    this.control = socket
    let opened = false
    socket.onopen = () => {
      if (this.control !== socket) return
      opened = true; this.attempt = 0; this.lastSeen = Date.now()
      this.set('online')
      clearInterval(this.keepalive)
      this.keepalive = setInterval(() => {
        if (this.control !== socket) return
        if (Date.now() - this.lastSeen > CONTROL_SILENCE_MS) { socket.close(4000, 'Silent'); return }
        // Paseo relays answer a JSON ping; any message counts as a sign of life.
        try { socket.send(JSON.stringify({ type: 'ping', ts: Date.now() })) } catch { /* closing */ }
      }, CONTROL_PING_MS)
    }
    socket.onmessage = event => {
      if (this.control !== socket) return
      this.lastSeen = Date.now()
      const message = parseControl(event.data)
      if (!message) return
      if (message.type === 'ping') { try { socket.send(JSON.stringify({ type: 'pong', ts: Date.now() })) } catch { /* closing */ } }
      else if (message.type === 'sync') for (const id of message.connectionIds) this.open(id)
      else if (message.type === 'connected') this.open(message.connectionId)
      else if (message.type === 'disconnected') { this.data.get(message.connectionId)?.close(1000, 'Phone disconnected'); this.data.delete(message.connectionId) }
    }
    const ended = (reason?: string) => {
      if (this.control !== socket) return
      this.control = undefined
      clearInterval(this.keepalive)
      if (this.stopped) return
      if (opened) { this.set('offline', reason ? `The relay closed the connection: ${reason}` : undefined); this.schedule() }
      else void this.diagnose().then(error => { if (!this.stopped) { this.set('offline', error); this.schedule() } })
    }
    socket.onclose = event => ended(event.reason)
    // Node's WebSocket reports a refused handshake as an error with no close event after it.
    socket.onerror = () => { if (!opened) { ended(); try { socket.close() } catch { /* never opened */ } } }
  }

  private schedule(): void {
    if (this.stopped || this.retry) return
    this.attempt++
    this.retry = setTimeout(() => { this.retry = undefined; this.connect() }, Math.min(30_000, 1000 * this.attempt))
  }

  /** WebSocket errors carry no reason; ask the relay over HTTP why it refused, for a useful message. */
  private async diagnose(): Promise<string> {
    const url = this.url().replace(/^ws/, 'http')
    try {
      const response = await (this.options.fetch ?? fetch)(url, { signal: AbortSignal.timeout(10_000), redirect: 'manual' })
      if (response.status === 403 || response.status === 401) return `The relay refused this machine (HTTP ${response.status}). It may only accept server IDs it knows; allow ${this.options.serverId} on the relay.`
      if (response.status === 404) return 'The relay has no /ws endpoint at this address (HTTP 404).'
      return `Could not connect to the relay (HTTP ${response.status}).`
    } catch (error) {
      const cause = (error as { cause?: { message?: string; code?: string } }).cause
      return `Could not reach the relay: ${cause?.code ?? cause?.message ?? (error as Error).message}`
    }
  }

  private open(connectionId: string): void {
    if (this.stopped || this.data.has(connectionId)) return
    let socket: WebSocket
    try { socket = new this.Socket(this.url({ connectionId })) } catch (error) { this.options.log?.(`Could not open a phone connection: ${(error as Error).message}`); return }
    socket.binaryType = 'arraybuffer'
    this.data.set(connectionId, socket)
    const timeout = setTimeout(() => { if (socket.readyState !== socket.OPEN) socket.close() }, DATA_OPEN_TIMEOUT_MS)
    socket.addEventListener('open', () => { clearTimeout(timeout); this.options.accept(socket, connectionId) }, { once: true })
    const ended = () => { clearTimeout(timeout); if (this.data.get(connectionId) === socket) this.data.delete(connectionId) }
    socket.addEventListener('close', ended, { once: true })
    socket.addEventListener('error', () => { if (socket.readyState !== socket.OPEN) ended() }, { once: true })
  }
}
