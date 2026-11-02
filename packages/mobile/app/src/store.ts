/**
 * What the phone keeps: its own key, the computers it paired with, and which session updates it has seen. Each
 * computer's session list is kept up to date while connected.
 */
import { useSyncExternalStore } from 'react'
import { useEffect, useState } from 'react'
import { base64url, decodeOffer, fromBase64url, type ModelChoices, type SessionEntry, type TagState, type WorkspaceEntry } from '../../src/shared/protocol.js'
import { HubClient, hubFromOffer, nobleX25519, type Identity, type SavedHub } from './hub-client.js'

const KEY = 'dsh-mobile/v1'

interface Persisted {
  identity: { secretKey: string; publicKey: string }
  hubs: SavedHub[]
  /** Last event seen per `hubId/sessionId`, for marking finished work as new. */
  seen: Record<string, number>
  /** The computer notifications are on for; a browser holds one push key at a time. */
  pushHubId?: string
  view?: { archived?: boolean; subagents?: boolean; outside?: boolean }
}

function load(): Persisted {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? '') as Persisted
    if (value?.identity?.secretKey) return { ...value, seen: value.seen ?? {}, hubs: value.hubs ?? [] }
  } catch { /* first start */ }
  const keys = nobleX25519.generate() as Identity
  return { identity: { secretKey: base64url(keys.secretKey), publicKey: base64url(keys.publicKey) }, hubs: [], seen: {} }
}

export class HubState {
  readonly sessions = new Map<string, SessionEntry>()
  workspaces: WorkspaceEntry[] = []
  tags: TagState = { tags: [], assignments: {} }
  private cursor?: string
  private refreshing?: Promise<void>
  private again = false
  loaded = false

  constructor(readonly client: HubClient, private readonly changed: () => void, private readonly loadedEntries?: (entries: SessionEntry[]) => void) {
    client.subscribe(() => { if (client.state === 'online' && client.info?.phone) void this.refresh(); changed() })
    client.onNotice(message => { if ('n' in message && (message.n === 'changed' || message.n === 'paired')) void this.refresh() })
  }

  get hub() { return this.client.hub }

  refresh(): Promise<void> {
    if (this.refreshing) { this.again = true; return this.refreshing }
    this.refreshing = (async () => {
      try {
        do {
          this.again = false
          if (this.client.state !== 'online' || !this.client.info?.phone) return
          const changes = await this.client.call('sessions.changes', { since: this.cursor })
          // A cursor from before the computer restarted brings everything again.
          if (!this.cursor || this.cursor.split('.')[0] !== changes.cursor.split('.')[0]) this.sessions.clear()
          for (const entry of changes.sessions) { if (entry.removed) this.sessions.delete(entry.sessionId); else this.sessions.set(entry.sessionId, entry) }
          if (changes.workspaces) this.workspaces = changes.workspaces
          this.cursor = changes.cursor
          // Workspace Tags may be missing on that machine; then there are simply no tags.
          this.tags = await this.client.call('tags', undefined).catch(() => this.tags)
          this.loaded = true
          this.loadedEntries?.(changes.sessions)
          this.changed()
        } while (this.again)
      } catch { /* the next change or reconnect tries again */ }
      finally { this.refreshing = undefined }
    })()
    return this.refreshing
  }

  /** Apply an entry a live stream reported, ahead of the next list refresh. */
  update(entry: SessionEntry) { this.sessions.set(entry.sessionId, entry); this.changed() }

  private choices?: { at: number; value: Promise<ModelChoices> }
  /** Models and permission presets of this machine, fetched at most every five minutes. */
  models(): Promise<ModelChoices> {
    if (!this.choices || Date.now() - this.choices.at > 300_000) {
      const value = this.client.call('models', {})
      this.choices = { at: Date.now(), value }
      value.catch(() => { if (this.choices?.value === value) this.choices = undefined })
    }
    return this.choices.value
  }

  workspaceTitle(workspaceId: string | undefined): string | undefined {
    return this.workspaces.find(workspace => workspace.workspaceId === workspaceId)?.title
  }
}

/** A machine's model choices once connected. */
export function useModels(state: HubState | undefined): ModelChoices | undefined {
  const [choices, setChoices] = useState<ModelChoices>()
  const online = state?.client.state === 'online' && state.client.info?.phone !== undefined
  useEffect(() => {
    if (!state || !online) return
    let live = true
    void state.models().then(value => { if (live) setChoices(value) }, () => {})
    return () => { live = false }
  }, [state, online])
  return choices
}

export class AppStore {
  private data = load()
  readonly identity: Identity = { secretKey: fromBase64url(this.data.identity.secretKey), publicKey: fromBase64url(this.data.identity.publicKey) }
  readonly hubs = new Map<string, HubState>()
  private readonly listeners = new Set<() => void>()
  private version = 0

  constructor() {
    for (const hub of this.data.hubs) this.attach(hub)
    this.save()
    if (typeof document !== 'undefined') {
      const wake = () => { if (document.visibilityState === 'visible') for (const state of this.hubs.values()) state.client.reconnectNow() }
      document.addEventListener('visibilitychange', wake)
      addEventListener('online', wake)
      addEventListener('pageshow', wake)
    }
  }

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  getSnapshot = () => this.version
  private emit = () => { this.version++; this.save(); for (const listener of this.listeners) listener() }

  private save() {
    this.data.hubs = [...this.hubs.values()].map(state => ({ ...state.hub }))
    localStorage.setItem(KEY, JSON.stringify(this.data))
  }

  private attach(hub: SavedHub): HubState {
    const state = new HubState(new HubClient(hub, this.identity), this.emit, entries => this.baseline(hub.hubId, entries))
    this.hubs.set(hub.hubId, state)
    state.client.connect()
    return state
  }

  /** Start pairing from a code or link; returns the computer's ID. */
  add(link: string): string {
    const offer = decodeOffer(link)
    if (offer.expires && Date.now() > offer.expires) throw new Error('This pairing code expired. Show a new one on the computer.')
    const existing = this.hubs.get(offer.server)
    if (existing) {
      if (existing.client.info?.phone) return offer.server
      existing.client.close()
      this.hubs.delete(offer.server)
    }
    // One pairing at a time: a newer code replaces any pairing that never completed.
    for (const [hubId, state] of this.hubs) if (state.hub.token !== undefined && !state.hub.phoneId) { state.client.close(); this.hubs.delete(hubId) }
    this.attach(hubFromOffer(offer))
    this.emit()
    return offer.server
  }

  remove(hubId: string) {
    const state = this.hubs.get(hubId)
    state?.client.close()
    this.hubs.delete(hubId)
    for (const key of Object.keys(this.data.seen)) if (key.startsWith(`${hubId}/`)) delete this.data.seen[key]
    if (this.data.pushHubId === hubId) delete this.data.pushHubId
    this.emit()
  }

  seen(hubId: string, sessionId: string): number { return this.data.seen[`${hubId}/${sessionId}`] ?? -1 }
  /**
   * A session this phone has not seen before counts as read up to where it is now, so only later progress marks it
   * Completed, as a finished turn nobody looked at does in DSH's sidebar.
   */
  private baseline(hubId: string, entries: SessionEntry[]) {
    for (const entry of entries) {
      const key = `${hubId}/${entry.sessionId}`
      if (this.data.seen[key] === undefined && !entry.removed) this.data.seen[key] = entry.state === 'idle' ? entry.lastSeq : 0
    }
  }
  markSeen(hubId: string, sessionId: string, seq: number) {
    if (this.seen(hubId, sessionId) >= seq) return
    this.data.seen[`${hubId}/${sessionId}`] = seq
    this.emit()
  }

  get pushHubId() { return this.data.pushHubId }
  set pushHubId(hubId: string | undefined) { if (hubId) this.data.pushHubId = hubId; else delete this.data.pushHubId; this.emit() }

  get view() { return this.data.view ?? {} }
  setView(view: Persisted['view']) { this.data.view = { ...this.data.view, ...view }; this.emit() }
}

export const store = new AppStore()
export const useStore = () => { useSyncExternalStore(store.subscribe, store.getSnapshot); return store }
