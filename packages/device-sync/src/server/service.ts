/**
 * One machine's side of device sync: its identity and paired devices, the pairing handshake, a pull loop per paired
 * device, the requests it sends them, and the answers it gives them.
 *
 * Each machine pulls from the other; neither pushes data. A change on either side sends the other a small
 * notification so it pulls at once, and a timer pulls anyway in case a notification is lost.
 */
import { randomUUID } from 'node:crypto'
import { readdir, rm, stat } from 'node:fs/promises'
import type { Server } from 'node:http'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_GRANTS, PROTOCOL_VERSION, type Command, type CommandResult, type Grants, type LiveFrame, type LocalAction, type LocalStatus,
  type OutboxItem, type PairingStatus, type PeerStatus, type SessionEntry, type SyncedEvent, type WorkspaceEntry, parseWorkspaceRef,
} from '../shared/protocol.js'
import { attachmentRefs } from './events.js'
import { CommandError, emptyExecutorData, Executor, type ExecutorData } from './executor.js'
import { readJson, Serial, writeJsonAtomic } from './files.js'
import { emptyGroups, Groups, linkKey, type GroupsData, type Registers, type TagState } from './groups.js'
import type { HostApi } from './host.js'
import { defaultDeviceName, deviceIdOf, loadIdentity, nonce, pairingCode, sha256, type Identity } from './identity.js'
import { Blobs, Mirror, type AttachmentMeta } from './mirror.js'
import { sleep } from './queue.js'
import { createPeerServer, ndjson, PeerError, signedFetch, type InboundRequest, type InboundResult } from './transport.js'

interface PeerRecord {
  deviceId: string
  name: string
  publicKey: string
  endpoint: string
  pairedAt: number
  grantsToPeer: Grants
  grantsFromPeer: Grants
  paused?: boolean
  backupDone?: boolean
  lastSyncAt?: number
  version?: number
  unpairedAt?: number
}
interface PairingRecord {
  pairingId: string
  direction: 'incoming' | 'outgoing'
  deviceId: string
  name: string
  publicKey: string
  endpoint: string
  code: string
  confirmedHere: boolean
  confirmedThere: boolean
  expiresAt: number
  grantsHere: Grants
  grantsThere?: Grants
  rejected?: boolean
}
interface OutboxRecord extends OutboxItem { command: Command }
interface State {
  version: 1
  name: string
  peers: Record<string, PeerRecord>
  pairings: Record<string, PairingRecord>
  groups: GroupsData
  outbox: OutboxRecord[]
  executor: ExecutorData
}

/** dsh-workspace-tags' host service (0.1.10 and later). */
export interface WorkspaceTagsService {
  snapshot(): TagState
  replace(state: TagState): Promise<TagState>
  subscribe(listener: (state: TagState) => void): () => void
}

export interface ListenOptions {
  /** Address to bind; this machine's Tailscale IPv4 address when omitted. */
  host?: string
  port: number
  /** Address paired machines use to reach this one; `host:port` when omitted. */
  advertise?: string
  /** Accept peers from outside Tailscale and loopback. */
  anyNetwork?: boolean
}

export interface ServiceOptions {
  stateDir: string
  host: HostApi
  tags?: () => WorkspaceTagsService | undefined
  listen: ListenOptions
  /** Pull interval while a peer is online. */
  intervalMs?: number
  /** Images up to this size are fetched with their session; larger attachments when first opened. */
  autoDownloadBytes?: number
  log?(message: string): void
}

const PAIRING_TTL = 10 * 60_000
const MAX_BACKOFF = 60_000
const ONLINE_GRACE = 30_000
const MAX_ATTACHMENT_BYTES = 50_000_000
const BACKUPS_KEPT = 10

interface Link { online: boolean; lastSeenAt?: number; lastError?: string; backoff: number; timer?: ReturnType<typeof setTimeout>; pulling?: Promise<void>; again: boolean; remotePaused?: boolean }

export class HttpError extends Error {
  override name = 'HttpError'
  constructor(message: string, readonly status = 400) { super(message) }
}

/** This machine's Tailscale IPv4 address, if Tailscale is connected. */
export function tailscaleAddress(): string | undefined {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue
      const [a, b] = address.address.split('.').map(Number)
      if (a === 100 && b >= 64 && b <= 127) return address.address
    }
  }
  return undefined
}

const grantsOf = (value: unknown, fallback: Grants = DEFAULT_GRANTS): Grants => {
  const v = value as Partial<Grants> | undefined
  return { history: typeof v?.history === 'boolean' ? v.history : fallback.history, command: typeof v?.command === 'boolean' ? v.command : fallback.command }
}
const text = (value: unknown, label: string, max = 200): string => {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) throw new HttpError(`Invalid ${label}`)
  return value.trim()
}
const sameTags = (a: TagState, b: TagState) => JSON.stringify(a) === JSON.stringify(b)
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

export class DeviceSync {
  private readonly serial = new Serial()
  private saveTimer?: ReturnType<typeof setTimeout>
  private readonly links = new Map<string, Link>()
  private readonly mirrors = new Map<string, Mirror>()
  private readonly blobs: Blobs
  private readonly controller = new AbortController()
  private server?: Server
  private listenAddress?: string
  private listenError?: string
  private notifyTimer?: ReturnType<typeof setTimeout>
  private applyingTags = false
  private tagsUnsubscribe?: () => void
  private tagsService?: WorkspaceTagsService
  private readonly attachmentHashes = new Map<string, { sha256: string; bytes: number }>()
  readonly executor: Executor
  readonly groups: Groups

  private constructor(private readonly options: ServiceOptions, readonly identity: Identity, private readonly state: State) {
    this.blobs = new Blobs(join(options.stateDir, 'blobs'))
    this.groups = new Groups(state.groups, identity.deviceId, () => ({
      [identity.deviceId]: state.name, ...Object.fromEntries(Object.values(state.peers).map(peer => [peer.deviceId, peer.name])),
    }))
    this.executor = new Executor({
      host: options.host, data: state.executor,
      save: () => this.save(), changed: () => this.notifyPeers(),
      approvalPeers: () => Object.values(this.state.peers).some(peer => this.active(peer) && !peer.paused && peer.grantsToPeer.command && this.links.get(peer.deviceId)?.online),
      log: options.log,
    })
  }

  static async open(options: ServiceOptions): Promise<DeviceSync> {
    const identity = await loadIdentity(join(options.stateDir, 'identity.json'))
    const stored = await readJson<State>(join(options.stateDir, 'state.json'))
    const state: State = {
      version: 1, name: stored?.name || defaultDeviceName(), peers: stored?.peers ?? {}, pairings: {},
      groups: stored?.groups ?? emptyGroups(), outbox: (stored?.outbox ?? []).map(item => item.state === 'sending' ? { ...item, state: 'held' as const } : item),
      executor: { ...emptyExecutorData(), ...stored?.executor },
    }
    const sync = new DeviceSync(options, identity, state)
    for (const peer of Object.values(state.peers)) await sync.mirror(peer.deviceId)
    return sync
  }

  private log(message: string) { this.options.log?.(message) }

  /** Persist soon; writes are serialized and coalesced. */
  private save(): void {
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => { void this.flush() }, 100)
  }
  private flush(): Promise<void> {
    clearTimeout(this.saveTimer)
    const { pairings: _pairings, ...persisted } = this.state
    const snapshot = structuredClone(persisted)
    return this.serial.run(() => writeJsonAtomic(join(this.options.stateDir, 'state.json'), snapshot)).catch(error => this.log(`Could not save state: ${messageOf(error)}`))
  }

  private async mirror(deviceId: string): Promise<Mirror> {
    let mirror = this.mirrors.get(deviceId)
    if (!mirror) {
      mirror = new Mirror(deviceId, join(this.options.stateDir, 'mirrors', deviceId))
      await mirror.load()
      this.mirrors.set(deviceId, mirror)
    }
    return mirror
  }

  private active(peer: PeerRecord | undefined): peer is PeerRecord { return Boolean(peer && !peer.unpairedAt) }
  private link(deviceId: string): Link {
    let link = this.links.get(deviceId)
    if (!link) { link = { online: false, backoff: this.interval(), again: false }; this.links.set(deviceId, link) }
    return link
  }
  private interval() { return this.options.intervalMs ?? 5_000 }
  private endpoint() { return this.options.listen.advertise ?? (this.listenAddress ? `${this.listenAddress.includes(':') ? `[${this.listenAddress}]` : this.listenAddress}:${this.options.listen.port}` : '') }

  // ---------------------------------------------------------------- lifecycle

  async start(): Promise<void> {
    this.executor.start()
    void this.listenLoop()
    for (const peer of Object.values(this.state.peers)) if (this.active(peer)) this.schedule(peer.deviceId, 0)
    const stopApprovals = this.options.host.bridgeApprovals(this.executor.approvalBridge)
    this.controller.signal.addEventListener('abort', stopApprovals, { once: true })
    void this.tagsLoop()
  }

  async close(): Promise<void> {
    this.controller.abort()
    this.executor.close()
    this.tagsUnsubscribe?.()
    for (const link of this.links.values()) clearTimeout(link.timer)
    clearTimeout(this.notifyTimer)
    // A pull in progress may still be writing a mirror or a backup.
    await Promise.allSettled([...this.links.values()].map(link => link.pulling))
    await new Promise<void>(resolve => { if (this.server) this.server.close(() => resolve()); else resolve(); this.server?.closeAllConnections() })
    await this.flush()
  }

  /** Bind the peer listener to the Tailscale address, and rebind when the address appears or changes. */
  private async listenLoop(): Promise<void> {
    while (!this.controller.signal.aborted) {
      const host = this.options.listen.host ?? tailscaleAddress()
      if (host !== this.listenAddress || !this.server) {
        await new Promise<void>(resolve => { if (this.server) this.server.close(() => resolve()); else resolve(); this.server?.closeAllConnections() })
        this.server = undefined
        this.listenAddress = undefined
        if (!host) this.listenError = 'Tailscale is not connected on this machine, so paired devices cannot reach it.'
        else {
          const server = createPeerServer({
            identity: this.identity, anyNetwork: this.options.listen.anyNetwork, log: message => this.log(message),
            keyFor: (deviceId, path) => this.keyFor(deviceId, path), handle: request => this.handlePeer(request),
          })
          try {
            await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(this.options.listen.port, host, () => { server.off('error', reject); resolve() }) })
            this.server = server
            this.listenAddress = host
            this.listenError = undefined
          } catch (error) {
            this.listenError = (error as NodeJS.ErrnoException).code === 'EADDRINUSE'
              ? `Port ${this.options.listen.port} is already in use on ${host}.` : `Could not listen on ${host}: ${messageOf(error)}`
          }
        }
      }
      await sleep(30_000, this.controller.signal)
    }
  }

  /** Follow dsh-workspace-tags once it is there: its edits become group changes, merged groups are written back. */
  private async tagsLoop(): Promise<void> {
    while (!this.controller.signal.aborted) {
      const service = this.options.tags?.()
      if (service && service !== this.tagsService) {
        this.tagsUnsubscribe?.()
        this.tagsService = service
        this.tagsUnsubscribe = service.subscribe(state => { if (!this.applyingTags) this.observeTags(state) })
        this.observeTags(service.snapshot())
        await this.projectTags()
      } else if (service) {
        // A missed notification is caught here.
        this.observeTags(service.snapshot())
      } else this.tagsService = undefined
      await sleep(service ? 30_000 : 5_000, this.controller.signal)
    }
  }

  private observeTags(state: TagState): void {
    if (this.groups.observeLocal(state)) { this.executor.bump(); this.groupsRev = this.executor.revision(); this.save(); this.notifyPeers() }
  }
  private groupsRev = 0

  private async projectTags(): Promise<void> {
    const service = this.tagsService
    if (!service) return
    const next = this.groups.project()
    if (sameTags(next, service.snapshot())) { this.groups.projected(next); return }
    this.applyingTags = true
    try { this.groups.projected(await service.replace(next)) }
    catch (error) { this.log(`Could not save merged groups: ${messageOf(error)}`) }
    finally { this.applyingTags = false }
    this.save()
  }

  /** A local group edit that is not in dsh-workspace-tags (another machine's workspace, or a link). */
  private async groupsChanged(): Promise<void> {
    this.executor.bump(); this.groupsRev = this.executor.revision()
    this.save(); this.notifyPeers()
    await this.projectTags()
  }

  // ---------------------------------------------------------------- pulling

  private schedule(deviceId: string, delay: number): void {
    const link = this.link(deviceId)
    if (link.pulling) { link.again = true; return }
    clearTimeout(link.timer)
    link.timer = setTimeout(() => { void this.pull(deviceId) }, delay)
  }

  /** Fetch everything that changed on one paired machine. Never throws: failures are shown and retried later. */
  pull(deviceId: string): Promise<void> {
    const link = this.link(deviceId)
    if (link.pulling) { link.again = true; return link.pulling }
    clearTimeout(link.timer)
    link.pulling = (async () => {
      const peer = this.state.peers[deviceId]
      if (!this.active(peer) || peer.paused || this.controller.signal.aborted) return
      try {
        do { link.again = false; await this.pullOnce(peer, link) } while (link.again && !this.controller.signal.aborted)
        link.backoff = this.interval()
      } catch (error) {
        link.lastError = messageOf(error)
        if (error instanceof PeerError && error.unreachable) link.online = false
        link.backoff = Math.min(MAX_BACKOFF, link.backoff * 2)
      } finally {
        link.pulling = undefined
        if (!this.controller.signal.aborted && this.active(this.state.peers[deviceId])) {
          link.timer = setTimeout(() => { void this.pull(deviceId) }, link.again ? 0 : link.online ? this.interval() : link.backoff)
        }
      }
    })()
    return link.pulling
  }

  private request(peer: PeerRecord, method: 'GET' | 'POST', path: string, body?: unknown, extra: { timeoutMs?: number; signal?: AbortSignal } = {}) {
    const signal = extra.signal ? AbortSignal.any([extra.signal, this.controller.signal]) : this.controller.signal
    return signedFetch(this.identity, peer.endpoint, { method, path, body, to: peer.deviceId, timeoutMs: extra.timeoutMs, signal }, peer.publicKey)
  }

  private async pullOnce(peer: PeerRecord, link: Link): Promise<void> {
    const hello = (await this.request(peer, 'GET', '/v1/hello')).body as { name?: string; version?: number; grants?: Grants; paused?: boolean }
    link.online = true; link.lastSeenAt = Date.now()
    if (Math.floor(Number(hello.version)) !== PROTOCOL_VERSION) throw new Error(`${peer.name} runs an incompatible version of device sync; update both machines.`)
    if (typeof hello.name === 'string' && hello.name.trim()) peer.name = hello.name.trim().slice(0, 100)
    peer.version = hello.version
    peer.grantsFromPeer = grantsOf(hello.grants, peer.grantsFromPeer)
    link.remotePaused = hello.paused === true
    if (link.remotePaused) { link.lastError = `Sync is paused on ${peer.name}.`; this.save(); return }
    if (!peer.grantsFromPeer.history) { link.lastError = undefined; peer.lastSyncAt = Date.now(); this.save(); return }
    if (!peer.backupDone) { await this.backup(peer); peer.backupDone = true; this.save() }
    const mirror = await this.mirror(peer.deviceId)
    const query = mirror.cursor ? `?${new URLSearchParams({ since: mirror.cursor })}` : ''
    const changes = (await this.request(peer, 'GET', `/v1/changes${query}`)).body as { cursor: string; workspaces?: WorkspaceEntry[]; sessions: SessionEntry[]; groups?: Registers }
    if (changes.groups && this.groups.merge(peer.deviceId, changes.groups)) {
      this.executor.bump(); this.groupsRev = this.executor.revision()
      await this.projectTags()
    }
    await mirror.update({ cursor: changes.cursor, workspaces: changes.workspaces, sessions: changes.sessions ?? [] })
    for (const session of mirror.behind()) await this.pullEvents(peer, mirror, session.sessionId)
    peer.lastSyncAt = Date.now(); link.lastError = undefined
    this.save()
  }

  /** Fetch a session's events after the stored position, in pages, until caught up. */
  private async pullEvents(peer: PeerRecord, mirror: Mirror, sessionId: string, atLeast = 0): Promise<void> {
    for (let page = 0; page < 200; page++) {
      const after = mirror.session(sessionId)?.storedSeq ?? -1
      const query = new URLSearchParams({ after: String(after), limit: '500', ...(atLeast ? { atLeast: String(atLeast) } : {}) })
      const result = (await this.request(peer, 'GET', `/v1/sessions/${encodeURIComponent(sessionId)}/events?${query}`, undefined, { timeoutMs: 60_000 })).body as
        { events: SyncedEvent[]; through: number; hasMore: boolean }
      const metas: Record<string, AttachmentMeta> = {}
      for (const event of result.events) for (const ref of attachmentRefs(event)) metas[ref.attachmentId] = { kind: ref.kind, mediaType: ref.mediaType, name: ref.name, bytes: ref.bytes }
      await mirror.append(sessionId, result.events, result.through, metas)
      for (const [id, meta] of Object.entries(metas)) {
        if (meta.kind === 'image' && (meta.bytes ?? Infinity) <= (this.options.autoDownloadBytes ?? 1_000_000)) {
          await this.fetchAttachment(peer, mirror, sessionId, id).catch(error => this.log(`Could not fetch an image: ${messageOf(error)}`))
        }
      }
      if (!result.hasMore || result.through <= after) return
    }
  }

  /** Fetch one attachment unless its content is already stored, possibly for another session. */
  private async fetchAttachment(peer: PeerRecord, mirror: Mirror, sessionId: string, attachmentId: string): Promise<{ sha256: string; meta: AttachmentMeta }> {
    const known = mirror.attachment(sessionId, attachmentId)
    if (known?.sha256 && await this.blobs.has(known.sha256)) return { sha256: known.sha256, meta: known }
    const path = `/v1/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(attachmentId)}`
    const meta = (await this.request(peer, 'GET', `${path}?meta=1`, undefined, { timeoutMs: 60_000 })).body as { sha256: string; mediaType?: string; name?: string; bytes: number }
    if (!await this.blobs.has(meta.sha256)) {
      const full = (await this.request(peer, 'GET', path, undefined, { timeoutMs: 300_000 })).body as { data: string }
      const data = Buffer.from(full.data, 'base64')
      if (sha256(data) !== meta.sha256) throw new Error('An attachment arrived damaged')
      await this.blobs.put(data)
    }
    const stored: AttachmentMeta = { ...known, kind: known?.kind ?? 'file', sha256: meta.sha256, bytes: meta.bytes,
      ...(meta.mediaType ? { mediaType: meta.mediaType } : {}), ...(meta.name ? { name: meta.name } : {}) }
    await mirror.setAttachment(sessionId, attachmentId, stored)
    return { sha256: meta.sha256, meta: stored }
  }

  /** Tell paired machines to pull soon. */
  private notifyPeers(except?: string): void {
    clearTimeout(this.notifyTimer)
    this.notifyTimer = setTimeout(() => {
      for (const peer of Object.values(this.state.peers)) {
        if (!this.active(peer) || peer.paused || peer.deviceId === except || !peer.grantsToPeer.history) continue
        this.request(peer, 'POST', '/v1/notify', {}, { timeoutMs: 5_000 }).catch(() => {})
      }
    }, 200)
  }

  /** Copy what a first sync could change before it runs: tags, this plugin's state, and mirror indexes. */
  private async backup(peer: PeerRecord): Promise<void> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const dir = join(this.options.stateDir, 'backups', `${stamp}-${peer.deviceId.slice(0, 8)}`)
    const { pairings: _pairings, ...state } = this.state
    await writeJsonAtomic(join(dir, 'state.json'), state)
    if (this.tagsService) await writeJsonAtomic(join(dir, 'workspace-tags.json'), { version: 1, ...this.tagsService.snapshot() })
    for (const [id, mirror] of this.mirrors) await writeJsonAtomic(join(dir, `mirror-${id}.json`), mirror.snapshot())
    const all = (await this.backups()).sort((a, b) => b.at - a.at)
    for (const old of all.slice(BACKUPS_KEPT)) await rm(join(this.options.stateDir, 'backups', old.name), { recursive: true, force: true })
  }

  private async backups(): Promise<{ name: string; at: number }[]> {
    const dir = join(this.options.stateDir, 'backups')
    try {
      return await Promise.all((await readdir(dir)).map(async name => ({ name, at: (await stat(join(dir, name))).mtimeMs })))
    } catch { return [] }
  }

  // ---------------------------------------------------------------- pairing

  private keyFor(deviceId: string, path: string): string | undefined {
    const peer = this.state.peers[deviceId]
    if (this.active(peer)) return peer.publicKey
    if (path.startsWith('/v1/pair/')) return Object.values(this.state.pairings).find(p => p.deviceId === deviceId && p.expiresAt > Date.now())?.publicKey
    return undefined
  }

  private pairingView(p: PairingRecord): PairingStatus {
    return { pairingId: p.pairingId, direction: p.direction, deviceId: p.deviceId, name: p.name, endpoint: p.endpoint, code: p.code,
      confirmedHere: p.confirmedHere, confirmedThere: p.confirmedThere, expiresAt: p.expiresAt, grants: p.grantsHere }
  }

  private prunePairings() {
    for (const [id, pairing] of Object.entries(this.state.pairings)) if (pairing.expiresAt < Date.now()) delete this.state.pairings[id]
  }

  /** Ask the machine at `endpoint` to pair. Both users then compare the code and confirm on their own machine. */
  private async pair(endpoint: string, grants: Grants): Promise<PairingStatus> {
    this.prunePairings()
    if (!this.server) throw new HttpError(this.listenError ?? 'This machine is not reachable by paired devices yet.', 409)
    const mine = nonce()
    const { body } = await signedFetch(this.identity, endpoint, {
      method: 'POST', path: '/v1/pair/request', to: '',
      body: { deviceId: this.identity.deviceId, name: this.state.name, publicKey: this.identity.publicKey, nonce: mine, endpoint: this.endpoint(), version: PROTOCOL_VERSION },
    }, response => {
      const r = response as { publicKey?: unknown; deviceId?: unknown }
      return typeof r?.publicKey === 'string' && deviceIdOf(r.publicKey) === r.deviceId ? r.publicKey : undefined
    })
    const reply = body as { pairingId: string; deviceId: string; name: string; publicKey: string; nonce: string; version: number }
    if (reply.deviceId === this.identity.deviceId) throw new HttpError('That address is this machine.')
    if (Math.floor(reply.version) !== PROTOCOL_VERSION) throw new HttpError('The other machine runs an incompatible version of device sync.')
    if (this.active(this.state.peers[reply.deviceId])) throw new HttpError(`Already paired with ${reply.name}.`, 409)
    const pairing: PairingRecord = {
      pairingId: text(reply.pairingId, 'pairing'), direction: 'outgoing', deviceId: reply.deviceId, name: String(reply.name).slice(0, 100), publicKey: reply.publicKey,
      endpoint: endpoint.trim(), code: pairingCode(this.identity.publicKey, reply.publicKey, mine, String(reply.nonce)),
      confirmedHere: false, confirmedThere: false, expiresAt: Date.now() + PAIRING_TTL, grantsHere: grantsOf(grants),
    }
    this.state.pairings[pairing.pairingId] = pairing
    return this.pairingView(pairing)
  }

  private async confirmPairing(pairingId: string, grants: Grants | undefined): Promise<void> {
    this.prunePairings()
    const pairing = this.state.pairings[pairingId]
    if (!pairing || pairing.rejected) throw new HttpError('This pairing request has expired. Start again.', 404)
    if (grants) pairing.grantsHere = grantsOf(grants)
    pairing.confirmedHere = true
    if (pairing.direction === 'incoming') {
      if (pairing.confirmedThere) this.activate(pairing, pairing.grantsThere ?? DEFAULT_GRANTS)
      return
    }
    const { body } = await signedFetch(this.identity, pairing.endpoint, { method: 'POST', path: '/v1/pair/confirm', to: pairing.deviceId, body: { pairingId, grants: pairing.grantsHere } }, pairing.publicKey)
    this.settleOutgoing(pairing, body as { status: string; grants?: Grants })
    if (this.state.pairings[pairingId]) void this.waitForOtherSide(pairingId)
  }

  private settleOutgoing(pairing: PairingRecord, reply: { status: string; grants?: Grants }) {
    if (reply.status === 'active') this.activate(pairing, grantsOf(reply.grants))
    else if (reply.status === 'rejected') delete this.state.pairings[pairing.pairingId]
  }

  /** After confirming here, wait for the other user to confirm there. */
  private async waitForOtherSide(pairingId: string): Promise<void> {
    while (!this.controller.signal.aborted) {
      await sleep(2_000, this.controller.signal)
      const pairing = this.state.pairings[pairingId]
      if (!pairing || pairing.expiresAt < Date.now()) { delete this.state.pairings[pairingId]; return }
      try {
        const { body } = await signedFetch(this.identity, pairing.endpoint, { method: 'GET', path: `/v1/pair/status?${new URLSearchParams({ pairingId })}`, to: pairing.deviceId }, pairing.publicKey)
        this.settleOutgoing(pairing, body as { status: string; grants?: Grants })
      } catch (error) {
        if (error instanceof PeerError && error.status === 404) { delete this.state.pairings[pairingId]; return }
      }
    }
  }

  private activate(pairing: PairingRecord, grantsFromPeer: Grants): void {
    const old = this.state.peers[pairing.deviceId]
    this.state.peers[pairing.deviceId] = {
      deviceId: pairing.deviceId, name: pairing.name, publicKey: pairing.publicKey, endpoint: pairing.endpoint, pairedAt: Date.now(),
      grantsToPeer: pairing.grantsHere, grantsFromPeer, ...(old?.backupDone ? { backupDone: true } : {}),
    }
    delete this.state.pairings[pairing.pairingId]
    this.links.delete(pairing.deviceId)
    this.save()
    void this.mirror(pairing.deviceId).then(() => this.schedule(pairing.deviceId, 0))
  }

  private async unpair(deviceId: string, forgetHistory: boolean): Promise<void> {
    const peer = this.state.peers[deviceId]
    if (!peer) throw new HttpError('Unknown device', 404)
    // Tell the other machine first, while it still accepts this machine's signature.
    if (this.active(peer)) await this.request(peer, 'POST', '/v1/unpair', {}, { timeoutMs: 5_000 }).catch(() => {})
    this.forget(peer)
    this.state.outbox = this.state.outbox.filter(item => item.deviceId !== deviceId)
    if (forgetHistory) {
      await this.mirrors.get(deviceId)?.destroy()
      this.mirrors.delete(deviceId)
      delete this.state.peers[deviceId]
    }
    this.save()
  }

  private forget(peer: PeerRecord) {
    peer.unpairedAt = Date.now()
    this.groups.forgetPeer(peer.deviceId)
    const link = this.links.get(peer.deviceId)
    if (link) { clearTimeout(link.timer); link.online = false }
  }

  // ---------------------------------------------------------------- requests to paired machines

  private async sendCommand(peer: PeerRecord, command: Command): Promise<CommandResult> {
    let last: unknown
    // Retries reuse the request ID, so a request that arrived but whose answer was lost does not run twice.
    for (const delay of [0, 1_000, 3_000, 6_000]) {
      await sleep(delay, this.controller.signal)
      try {
        const result = (await this.request(peer, 'POST', '/v1/command', command, { timeoutMs: 60_000 })).body as CommandResult
        this.schedule(peer.deviceId, 300)
        return result
      } catch (error) {
        last = error
        if (!(error instanceof PeerError && error.unreachable)) throw error
      }
    }
    throw last
  }

  private summary(command: Command): string {
    if (command.kind === 'prompt' || command.kind === 'create') {
      const first = command.content.find(part => part.type === 'text')
      return first && first.type === 'text' ? first.text.slice(0, 120) : 'Image'
    }
    return command.kind === 'cancel' ? 'Stop' : command.kind === 'approval' ? (command.outcome === 'allowed-once' ? 'Allow' : 'Deny') : 'Answer'
  }

  /**
   * Send a request to the machine that executes the session. When that machine is offline the request is held, and
   * sent only once the user confirms it again; it is never run on this machine instead.
   */
  private async command(deviceId: string, command: Command): Promise<{ result?: CommandResult; held?: OutboxItem }> {
    if (deviceId === this.identity.deviceId) return { result: await this.executor.command(command) }
    const peer = this.state.peers[deviceId]
    if (!this.active(peer)) throw new HttpError('This device is no longer paired.', 404)
    if (peer.paused) throw new HttpError(`Sync with ${peer.name} is paused.`, 409)
    if (!peer.grantsFromPeer.command) throw new HttpError(`${peer.name} does not allow remote control from this machine. Allow it in Device sync settings on ${peer.name}.`, 403)
    const requestId = typeof command.requestId === 'string' && command.requestId ? command.requestId : randomUUID()
    const item: OutboxRecord = { requestId, deviceId, ...('sessionId' in command ? { sessionId: command.sessionId } : {}), kind: command.kind,
      summary: this.summary(command), createdAt: Date.now(), state: 'sending', command: { ...command, requestId } }
    this.state.outbox = [...this.state.outbox.filter(old => old.requestId !== requestId), item]
    if (!this.link(deviceId).online) {
      item.state = 'held'; item.error = `${peer.name} is offline.`; this.save()
      return { held: this.outboxView(item) }
    }
    return this.deliver(peer, item)
  }

  private async deliver(peer: PeerRecord, item: OutboxRecord): Promise<{ result?: CommandResult; held?: OutboxItem }> {
    item.state = 'sending'; delete item.error; this.save()
    try {
      const result = await this.sendCommand(peer, item.command)
      this.state.outbox = this.state.outbox.filter(old => old.requestId !== item.requestId)
      this.save()
      return { result }
    } catch (error) {
      if (error instanceof PeerError && error.unreachable) {
        this.link(peer.deviceId).online = false
        item.state = 'held'; item.error = `${peer.name} could not be reached.`; this.save()
        return { held: this.outboxView(item) }
      }
      this.state.outbox = this.state.outbox.filter(old => old.requestId !== item.requestId)
      this.save()
      throw new HttpError(messageOf(error), error instanceof PeerError && error.status >= 400 && error.status < 500 ? error.status : 502)
    }
  }

  private outboxView({ command: _command, ...item }: OutboxRecord): OutboxItem { return item }

  // ---------------------------------------------------------------- browser API

  async status(): Promise<LocalStatus> {
    this.prunePairings()
    const peers: PeerStatus[] = Object.values(this.state.peers).map(peer => {
      const link = this.links.get(peer.deviceId)
      const mirror = this.mirrors.get(peer.deviceId)
      const online = Boolean(link?.online && link.lastSeenAt && Date.now() - link.lastSeenAt < Math.max(ONLINE_GRACE, this.interval() * 3))
      return {
        deviceId: peer.deviceId, name: peer.name, endpoint: peer.endpoint, pairedAt: peer.pairedAt,
        connection: peer.unpairedAt ? 'unpaired' : peer.paused || link?.remotePaused ? 'paused' : online ? 'online' : 'offline',
        grantsToPeer: peer.grantsToPeer, grantsFromPeer: peer.grantsFromPeer,
        pending: (mirror?.behind().length ?? 0) + this.state.outbox.filter(item => item.deviceId === peer.deviceId).length,
        ...(peer.lastSyncAt ? { lastSyncAt: peer.lastSyncAt } : {}), ...(link?.lastSeenAt ? { lastSeenAt: link.lastSeenAt } : {}),
        ...(link?.lastError ? { lastError: link.lastError } : {}), ...(peer.version ? { version: peer.version } : {}),
      }
    })
    return {
      device: { deviceId: this.identity.deviceId, name: this.state.name },
      listener: { ...(this.server ? { address: this.endpoint() } : {}), ...(this.listenError ? { error: this.listenError } : {}) },
      peers,
      pairings: Object.values(this.state.pairings).filter(p => !p.rejected).map(p => this.pairingView(p)),
      workspaces: [
        { deviceId: this.identity.deviceId, items: this.executor.workspaceEntries() },
        ...[...this.mirrors.values()].map(mirror => ({ deviceId: mirror.deviceId, items: mirror.workspaces() })),
      ],
      sessions: [...this.mirrors.values()].flatMap(mirror => mirror.views()),
      groups: this.groups.view(Boolean(this.tagsService)),
      outbox: this.state.outbox.map(item => this.outboxView(item)),
      backups: await this.backups(),
    }
  }

  async action(input: LocalAction): Promise<unknown> {
    switch (input?.action) {
      case 'pair': return this.pair(text(input.endpoint, 'address', 300), grantsOf(input.grants))
      case 'confirmPairing': await this.confirmPairing(text(input.pairingId, 'pairing'), input.grants ? grantsOf(input.grants) : undefined); return { ok: true }
      case 'rejectPairing': {
        const pairing = this.state.pairings[text(input.pairingId, 'pairing')]
        if (pairing) {
          pairing.rejected = true
          await signedFetch(this.identity, pairing.endpoint, { method: 'POST', path: '/v1/pair/reject', to: pairing.deviceId, body: { pairingId: pairing.pairingId }, timeoutMs: 5_000 }, pairing.publicKey).catch(() => {})
          if (pairing.direction === 'outgoing') delete this.state.pairings[pairing.pairingId]
        }
        return { ok: true }
      }
      case 'setGrants': {
        const peer = this.requirePeer(input.deviceId)
        peer.grantsToPeer = grantsOf(input.grants, peer.grantsToPeer)
        this.save()
        await this.request(peer, 'POST', '/v1/grants', { grants: peer.grantsToPeer }, { timeoutMs: 5_000 }).catch(() => {})
        return { ok: true }
      }
      case 'pause': {
        const peer = this.requirePeer(input.deviceId)
        peer.paused = input.paused === true
        this.save()
        if (!peer.paused) this.schedule(peer.deviceId, 0)
        return { ok: true }
      }
      case 'retry': { const peer = this.requirePeer(input.deviceId); this.link(peer.deviceId).backoff = this.interval(); await this.pull(peer.deviceId); return { ok: true } }
      case 'unpair': await this.unpair(text(input.deviceId, 'device'), input.forgetHistory === true); return { ok: true }
      case 'rename': this.state.name = text(input.name, 'name', 100); this.save(); this.notifyPeers(); return { ok: true }
      case 'command': return this.command(text(input.deviceId, 'device'), input.command)
      case 'release': {
        const item = this.state.outbox.find(old => old.requestId === input.requestId)
        if (!item) throw new HttpError('This request was already sent or discarded.', 404)
        const peer = this.requirePeer(item.deviceId)
        return this.deliver(peer, item)
      }
      case 'discard': this.state.outbox = this.state.outbox.filter(old => old.requestId !== input.requestId); this.save(); return { ok: true }
      case 'hideSession': await (await this.mirror(text(input.deviceId, 'device'))).hide(text(input.sessionId, 'session'), input.hidden === true); return { ok: true }
      case 'events': {
        const mirror = this.mirrors.get(text(input.deviceId, 'device'))
        if (!mirror) throw new HttpError('Unknown device', 404)
        const sessionId = text(input.sessionId, 'session')
        if (!mirror.session(sessionId)) throw new HttpError('Unknown session', 404)
        return { events: await mirror.read(sessionId, { after: typeof input.after === 'number' ? input.after : undefined, last: typeof input.limit === 'number' ? Math.min(input.limit, 5_000) : undefined }) }
      }
      case 'assign': {
        const ref = text(input.workspaceRef, 'workspace', 300)
        if (!parseWorkspaceRef(ref)) throw new HttpError('Invalid workspace')
        if (!this.groups.tags().some(tag => tag.id === input.tagId)) throw new HttpError('This group no longer exists', 404)
        if (this.groups.set(`assign|${input.tagId}|${ref}`, input.assigned === true)) await this.groupsChanged()
        return { ok: true }
      }
      case 'link': {
        const a = parseWorkspaceRef(text(input.localRef, 'workspace', 300)), b = parseWorkspaceRef(text(input.remoteRef, 'workspace', 300))
        if (!a || !b || a.deviceId === b.deviceId) throw new HttpError('Link a workspace on this machine with one on another machine.')
        if (this.groups.set(linkKey(input.localRef, input.remoteRef), input.linked === true)) await this.groupsChanged()
        return { ok: true }
      }
      case 'resolveConflict': if (this.groups.resolve(text(input.key, 'conflict', 500), input.useOther === true)) await this.groupsChanged(); return { ok: true }
      default: throw new HttpError('Unknown action')
    }
  }

  private requirePeer(deviceId: unknown): PeerRecord {
    const peer = this.state.peers[text(deviceId, 'device')]
    if (!this.active(peer)) throw new HttpError('This device is no longer paired.', 404)
    return peer
  }

  /** Follow a mirrored session live, storing its events here as they arrive. */
  async *live(deviceId: string, sessionId: string, signal: AbortSignal): AsyncIterable<LiveFrame> {
    const peer = this.requirePeer(deviceId)
    const mirror = await this.mirror(deviceId)
    if (!mirror.session(sessionId)) throw new HttpError('Unknown session', 404)
    const { response } = await this.request(peer, 'GET', `/v1/sessions/${encodeURIComponent(sessionId)}/live`, undefined, { timeoutMs: 0, signal })
    for await (const value of ndjson(response)) {
      const frame = value as LiveFrame
      if (frame.type === 'open' && frame.lastSeq > (mirror.session(sessionId)?.storedSeq ?? -1)) await this.pullEvents(peer, mirror, sessionId, frame.lastSeq)
      else if (frame.type === 'event') {
        const stored = mirror.session(sessionId)?.storedSeq ?? -1
        if (stored >= frame.after) await mirror.append(sessionId, frame.event ? [frame.event] : [], frame.through)
        else await this.pullEvents(peer, mirror, sessionId, frame.through)
      } else if (frame.type === 'status') await mirror.status(frame.entry)
      yield frame
    }
  }

  /** An attachment of a mirrored session: from local storage, or fetched from its machine the first time. */
  async attachment(deviceId: string, sessionId: string, attachmentId: string): Promise<{ data: Buffer; mediaType: string; name?: string }> {
    const mirror = this.mirrors.get(deviceId)
    if (!mirror?.session(sessionId)) throw new HttpError('Unknown session', 404)
    const known = mirror.attachment(sessionId, attachmentId)
    if (!known) throw new HttpError('Unknown attachment', 404)
    let sha = known.sha256 && await this.blobs.has(known.sha256) ? known.sha256 : undefined
    let meta = known
    if (!sha) {
      const peer = this.requirePeer(deviceId)
      if (!this.link(deviceId).online) throw new HttpError(`${peer.name} is offline; this attachment has not been downloaded yet.`, 409)
      ;({ sha256: sha, meta } = await this.fetchAttachment(peer, mirror, sessionId, attachmentId))
    }
    return { data: await this.blobs.get(sha), mediaType: meta.mediaType ?? 'application/octet-stream', ...(meta.name ? { name: meta.name } : {}) }
  }

  // ---------------------------------------------------------------- answers to paired machines

  async handlePeer(request: InboundRequest): Promise<InboundResult> {
    try { return await this.routePeer(request) }
    catch (error) {
      const status = error instanceof HttpError || error instanceof CommandError ? error.status : 500
      if (status === 500) this.log(`Peer request ${request.path} failed: ${messageOf(error)}`)
      return { status, json: { error: status === 500 ? 'The request failed on this machine' : messageOf(error) } }
    }
  }

  private async routePeer(request: InboundRequest): Promise<InboundResult> {
    const { method, path, from = '' } = request
    const body = (request.body ?? {}) as Record<string, unknown>
    if (method === 'POST' && path === '/v1/pair/request') return { status: 200, json: this.incomingPairing(body, request.remoteAddress) }
    if (path.startsWith('/v1/pair/')) return { status: 200, json: this.pairingAnswer(method, path, from, body, request.query) }
    const peer = this.state.peers[from]
    if (!this.active(peer)) throw new HttpError('This device is not paired with this machine', 401)
    this.link(from).lastSeenAt = Date.now()
    if (path === '/v1/hello') return { status: 200, json: { deviceId: this.identity.deviceId, name: this.state.name, version: PROTOCOL_VERSION, grants: peer.grantsToPeer, ...(peer.paused ? { paused: true } : {}) } }
    if (method === 'POST' && path === '/v1/unpair') { this.forget(peer); this.save(); return { status: 200, json: { ok: true } } }
    if (method === 'POST' && path === '/v1/grants') { peer.grantsFromPeer = grantsOf(body.grants, peer.grantsFromPeer); this.save(); return { status: 200, json: { ok: true } } }
    if (peer.paused) throw new HttpError(`Sync is paused on ${this.state.name}`, 423)
    if (method === 'POST' && path === '/v1/notify') { this.link(from).online = true; this.schedule(from, 0); return { status: 200, json: { ok: true } } }
    if (method === 'POST' && path === '/v1/command') {
      if (!peer.grantsToPeer.command) throw new HttpError(`${this.state.name} does not allow remote control from ${peer.name}`, 403)
      return { status: 200, json: await this.executor.command(body as unknown as Command) }
    }
    if (!peer.grantsToPeer.history) throw new HttpError(`${this.state.name} does not share its history with ${peer.name}`, 403)
    if (method === 'GET' && path === '/v1/changes') {
      const since = request.query.get('since') ?? undefined
      const changes = this.executor.changes(since)
      return { status: 200, json: { ...changes, ...(this.groupsRev > this.executor.afterOf(since) || this.executor.afterOf(since) < 0 ? { groups: this.groups.registers() } : {}) } }
    }
    const match = /^\/v1\/sessions\/([^/]+)\/(events|live|attachments)(?:\/([^/]+))?$/.exec(path)
    if (method !== 'GET' || !match) throw new HttpError('Not found', 404)
    const sessionId = decodeURIComponent(match[1])
    if (match[2] === 'events') {
      const after = Number(request.query.get('after') ?? -1), limit = Math.min(Math.max(Number(request.query.get('limit') ?? 500), 1), 2_000)
      return { status: 200, json: await this.executor.events(sessionId, Number.isFinite(after) ? after : -1, limit, request.signal, Number(request.query.get('atLeast')) || 0) }
    }
    if (match[2] === 'live') {
      if (!this.executor.entry(sessionId)) throw new HttpError('Unknown session', 404)
      return { status: 200, stream: this.executor.live(sessionId, request.signal) }
    }
    const attachmentId = decodeURIComponent(match[3] ?? '')
    const ref = await this.executor.sharesAttachment(sessionId, attachmentId, request.signal)
    if (!ref) throw new HttpError('Unknown attachment', 404)
    const read = async () => {
      if (ref.kind === 'image') return (await this.options.host.readImage(ref, request.signal)).data
      const chunks: Uint8Array[] = []
      let size = 0
      for await (const chunk of this.options.host.readFile(ref, request.signal)) {
        size += chunk.length
        if (size > MAX_ATTACHMENT_BYTES) throw new HttpError('This attachment is too large to share', 413)
        chunks.push(chunk)
      }
      return Buffer.concat(chunks)
    }
    const cached = this.attachmentHashes.get(attachmentId)
    const meta = { mediaType: ref.mediaType, name: ref.name }
    if (request.query.get('meta') === '1' && cached) return { status: 200, json: { ...meta, ...cached } }
    const data = Buffer.from(await read())
    const hash = { sha256: sha256(data), bytes: data.length }
    this.attachmentHashes.set(attachmentId, hash)
    return { status: 200, json: { ...meta, ...hash, ...(request.query.get('meta') === '1' ? {} : { data: data.toString('base64') }) } }
  }

  private incomingPairing(body: Record<string, unknown>, remoteAddress: string) {
    this.prunePairings()
    const publicKey = text(body.publicKey, 'key', 200), deviceId = text(body.deviceId, 'device', 64)
    if (deviceIdOf(publicKey) !== deviceId) throw new HttpError('The device ID does not match its key', 401)
    if (deviceId === this.identity.deviceId) throw new HttpError('A machine cannot pair with itself')
    if (Math.floor(Number(body.version)) !== PROTOCOL_VERSION) throw new HttpError('Incompatible device sync version', 409)
    if (this.active(this.state.peers[deviceId])) throw new HttpError(`${this.state.name} is already paired with this machine. Unpair there first.`, 409)
    const incoming = Object.values(this.state.pairings).filter(p => p.direction === 'incoming')
    if (incoming.length >= 5) throw new HttpError('Too many pairing requests are waiting on this machine', 429)
    for (const old of incoming) if (old.deviceId === deviceId) delete this.state.pairings[old.pairingId]
    const mine = nonce()
    const host = remoteAddress.startsWith('::ffff:') ? remoteAddress.slice(7) : remoteAddress
    const advertised = typeof body.endpoint === 'string' && body.endpoint.trim() ? body.endpoint.trim().slice(0, 300) : `${host.includes(':') ? `[${host}]` : host}:${this.options.listen.port}`
    const pairing: PairingRecord = {
      pairingId: randomUUID(), direction: 'incoming', deviceId, name: text(body.name, 'name', 100), publicKey, endpoint: advertised,
      code: pairingCode(this.identity.publicKey, publicKey, mine, text(body.nonce, 'nonce', 100)),
      confirmedHere: false, confirmedThere: false, expiresAt: Date.now() + PAIRING_TTL, grantsHere: { ...DEFAULT_GRANTS },
    }
    this.state.pairings[pairing.pairingId] = pairing
    return { pairingId: pairing.pairingId, deviceId: this.identity.deviceId, name: this.state.name, publicKey: this.identity.publicKey, nonce: mine, version: PROTOCOL_VERSION }
  }

  private pairingAnswer(method: string, path: string, from: string, body: Record<string, unknown>, query: URLSearchParams) {
    const pairingId = String(body.pairingId ?? query.get('pairingId') ?? '')
    const pairing = this.state.pairings[pairingId]
    const peer = this.state.peers[from]
    // The other side asks after this one already activated the pairing.
    if (!pairing || pairing.deviceId !== from) {
      if (this.active(peer) && method === 'GET' && path === '/v1/pair/status') return { status: 'active', grants: peer.grantsToPeer }
      throw new HttpError('Unknown pairing request', 404)
    }
    if (method === 'POST' && path === '/v1/pair/reject') {
      if (pairing.direction === 'incoming') delete this.state.pairings[pairingId]; else pairing.rejected = true
      return { ok: true }
    }
    if (pairing.rejected) return { status: 'rejected' }
    if (method === 'POST' && path === '/v1/pair/confirm' && pairing.direction === 'incoming') {
      pairing.confirmedThere = true
      pairing.grantsThere = grantsOf(body.grants)
      if (pairing.confirmedHere) {
        const grants = pairing.grantsHere
        this.activate(pairing, pairing.grantsThere)
        return { status: 'active', grants }
      }
      return { status: 'pending' }
    }
    if (method === 'GET' && path === '/v1/pair/status') return { status: 'pending' }
    throw new HttpError('Not found', 404)
  }
}
