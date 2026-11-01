/**
 * Host-to-host HTTP. Every request is signed with the sender's device key and names its target device; every
 * buffered response is signed by the target and bound to the request's nonce. Tailscale carries the traffic
 * encrypted between the two machines; the signatures make sure that the peer at the other end is the paired device,
 * not merely some machine on the same tailnet.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { isIP } from 'node:net'
import { nonce as newNonce, requestCanonical, responseCanonical, sha256, verifySignature, type Identity } from './identity.js'

export const HEADER = { from: 'x-dsync-from', to: 'x-dsync-to', time: 'x-dsync-time', nonce: 'x-dsync-nonce', signature: 'x-dsync-signature' } as const
const MAX_SKEW_MS = 5 * 60_000

export class PeerError extends Error {
  override name = 'PeerError'
  /** `status` 0 means the peer could not be reached. */
  constructor(message: string, readonly status: number) { super(message) }
  get unreachable() { return this.status === 0 }
}

/** A peer address as `host:port`, `[v6]:port` or a URL; returns its base URL. */
export function baseUrl(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/, '')
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  return `http://${trimmed}`
}

export interface SignedRequest { method: 'GET' | 'POST'; path: string; body?: unknown; to: string; timeoutMs?: number; signal?: AbortSignal }

/**
 * Send a signed request. The response must be signed by `verifyWith`: the peer's public key, or for a pairing
 * request, a function finding the key the response introduces.
 */
export async function signedFetch(identity: Identity, endpoint: string, request: SignedRequest, verifyWith: string | ((body: unknown) => string | undefined)): Promise<{ status: number; body: unknown; response: Response }> {
  const body = request.body === undefined ? '' : JSON.stringify(request.body)
  const time = String(Date.now()), id = newNonce()
  const headers: Record<string, string> = {
    [HEADER.from]: identity.deviceId, [HEADER.to]: request.to, [HEADER.time]: time, [HEADER.nonce]: id,
    [HEADER.signature]: identity.sign(requestCanonical(request.method, request.path, identity.deviceId, request.to, time, id, sha256(body))),
  }
  if (body) headers['content-type'] = 'application/json'
  // A timeout of 0 leaves a long-lived stream open until `signal` ends it.
  const signals = [...(request.timeoutMs === 0 ? [] : [AbortSignal.timeout(request.timeoutMs ?? 15_000)]), ...(request.signal ? [request.signal] : [])]
  let response: Response
  try {
    response = await fetch(`${baseUrl(endpoint)}${request.path}`, { method: request.method, headers, body: body || undefined, signal: AbortSignal.any(signals), redirect: 'error' })
  } catch (error) {
    if (request.signal?.aborted) throw error
    throw new PeerError(`Could not reach ${endpoint}: ${error instanceof Error ? (error.cause as Error | undefined)?.message ?? error.message : String(error)}`, 0)
  }
  // A stream is opened by a signed request and its frames travel over Tailscale's authenticated tunnel.
  if (response.ok && (response.headers.get('content-type') ?? '').startsWith('application/x-ndjson')) return { status: response.status, body: undefined, response }
  const text = await response.text()
  let parsed: unknown
  try { parsed = text ? JSON.parse(text) : undefined } catch { throw new PeerError('The peer sent an unreadable response', 502) }
  const key = typeof verifyWith === 'string' ? verifyWith : verifyWith(parsed)
  const signature = response.headers.get(HEADER.signature) ?? ''
  if (!key || !verifySignature(key, responseCanonical(response.status, id, sha256(text)), signature)) {
    throw new PeerError(response.ok ? 'The response was not signed by the paired device' : `HTTP ${response.status} from a device that is not the paired one`, 502)
  }
  if (!response.ok) {
    const message = typeof (parsed as { error?: unknown })?.error === 'string' ? (parsed as { error: string }).error : `HTTP ${response.status}`
    throw new PeerError(message, response.status)
  }
  return { status: response.status, body: parsed, response }
}

export interface InboundRequest {
  method: string
  path: string
  query: URLSearchParams
  /** Verified sender device ID; undefined for the unsigned pairing request. */
  from?: string
  body: unknown
  remoteAddress: string
  signal: AbortSignal
}
export type InboundResult =
  | { status: number; json: unknown }
  | { status: number; stream: AsyncIterable<unknown> }

export interface PeerServerOptions {
  identity: Identity
  /** Public key of a device allowed to send `path`, or undefined to refuse it. */
  keyFor(deviceId: string, path: string): string | undefined
  handle(request: InboundRequest): Promise<InboundResult>
  /** Accept connections from any address, not only Tailscale and loopback. For tests and unusual networks. */
  anyNetwork?: boolean
  maxBodyBytes?: number
  log?(message: string): void
}

/** Tailscale's IPv4 (100.64.0.0/10) and IPv6 (fd7a:115c:a1e0::/48) ranges, and loopback. */
export function isTailnetOrLoopback(address: string): boolean {
  const v4 = address.startsWith('::ffff:') ? address.slice(7) : address
  if (isIP(v4) === 4) {
    const [a, b] = v4.split('.').map(Number)
    return a === 127 || (a === 100 && b >= 64 && b <= 127)
  }
  const lower = address.toLowerCase()
  return lower === '::1' || lower.startsWith('fd7a:115c:a1e0:')
}

/** Nonces seen within the allowed clock skew; a repeated one is a replay. */
class NonceCache {
  private readonly seen = new Map<string, number>()
  add(id: string): boolean {
    const now = Date.now()
    if (this.seen.size > 10_000) for (const [key, until] of this.seen) if (until < now) this.seen.delete(key)
    if ((this.seen.get(id) ?? 0) > now) return false
    this.seen.set(id, now + 2 * MAX_SKEW_MS)
    return true
  }
}

export function createPeerServer(options: PeerServerOptions): Server {
  const nonces = new NonceCache()
  const max = options.maxBodyBytes ?? 16_000_000
  return createServer((req, res) => {
    void serve(req, res).catch(error => {
      options.log?.(`Peer request failed: ${String(error)}`)
      if (!res.headersSent) send(res, 500, { error: 'Internal error' }, '')
      else res.destroy()
    })
  })

  function send(res: ServerResponse, status: number, json: unknown, requestNonce: string) {
    const text = JSON.stringify(json)
    res.writeHead(status, {
      'content-type': 'application/json', 'cache-control': 'no-store',
      [HEADER.signature]: options.identity.sign(responseCanonical(status, requestNonce, sha256(text))),
    })
    res.end(text)
  }

  async function serve(req: IncomingMessage, res: ServerResponse) {
    const remoteAddress = req.socket.remoteAddress ?? ''
    if (!options.anyNetwork && !isTailnetOrLoopback(remoteAddress)) { res.writeHead(403).end(); return }
    const url = new URL(req.url ?? '/', 'http://peer')
    const method = req.method ?? 'GET'
    const requestNonce = String(req.headers[HEADER.nonce] ?? '')
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      size += (chunk as Buffer).length
      if (size > max) { send(res, 413, { error: 'Request is too large' }, requestNonce); req.destroy(); return }
      chunks.push(chunk as Buffer)
    }
    const raw = Buffer.concat(chunks).toString('utf8')
    const from = String(req.headers[HEADER.from] ?? ''), to = String(req.headers[HEADER.to] ?? ''), time = String(req.headers[HEADER.time] ?? '')
    const signature = String(req.headers[HEADER.signature] ?? '')
    const pathWithQuery = `${url.pathname}${url.search}`
    let body: unknown
    try { body = raw ? JSON.parse(raw) : undefined } catch { send(res, 400, { error: 'Invalid JSON' }, requestNonce); return }
    const pairingRequest = url.pathname === '/v1/pair/request' && method === 'POST'
    if (!/^[\w-]{16,64}$/.test(requestNonce) || !nonces.add(requestNonce)) { send(res, 401, { error: 'Missing or repeated request nonce' }, requestNonce); return }
    if (Math.abs(Date.now() - Number(time)) > MAX_SKEW_MS) { send(res, 401, { error: 'The clocks of the two machines differ by more than 5 minutes' }, requestNonce); return }
    // Not 421: fetch retries a misdirected request by itself, and the retry would repeat the nonce.
    if (to !== options.identity.deviceId && !(pairingRequest && to === '')) { send(res, 409, { error: 'This request is for another device' }, requestNonce); return }
    // A pairing request is signed with the key it introduces; the handler checks the key against the device ID.
    const key = pairingRequest ? String((body as { publicKey?: unknown })?.publicKey ?? '') : options.keyFor(from, url.pathname)
    if (!key || !verifySignature(key, requestCanonical(method, pathWithQuery, from, to, time, requestNonce, sha256(raw)), signature)) {
      send(res, 401, { error: 'This device is not paired with this machine' }, requestNonce); return
    }
    const abort = new AbortController()
    res.on('close', () => abort.abort())
    const result = await options.handle({ method, path: url.pathname, query: url.searchParams, from, body, remoteAddress, signal: abort.signal })
    if ('json' in result) { send(res, result.status, result.json, requestNonce); return }
    res.writeHead(result.status, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store', 'x-accel-buffering': 'no' })
    res.flushHeaders()
    try {
      for await (const frame of result.stream) {
        if (abort.signal.aborted) break
        res.write(`${JSON.stringify(frame)}\n`)
      }
    } finally { res.end() }
  }
}

/** Parse a newline-delimited JSON body as it arrives. */
export async function* ndjson(response: Response): AsyncIterable<unknown> {
  if (!response.body) return
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true })
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line) yield JSON.parse(line)
    }
  }
  if (buffer.trim()) yield JSON.parse(buffer)
}
