/** This plugin's state: one private JSON file, written atomically. */
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import type { Grants, PushPreferences, PushSubscriptionJson } from '../shared/protocol.js'
import { emptyExecutorData, type ExecutorData } from './bridge/executor.js'
import { generateVapidKeys, type VapidKeys } from './push.js'
import { nodeX25519 } from './x25519.js'

export interface PhoneRecord {
  id: string
  /** The phone's X25519 public key, base64url; it authenticates every connection. */
  key: string
  name: string
  platform?: string
  grants: Grants
  pairedAt: number
  lastSeen?: number
  push?: { subscription: PushSubscriptionJson; preferences: PushPreferences; since: number }
}

export interface State {
  version: 1
  hub: { id: string; secretKey: string; publicKey: string }
  settings: { name: string; relay: string; tls: boolean; appUrl: string }
  vapid: VapidKeys
  phones: Record<string, PhoneRecord>
  executor: ExecutorData
}

export function newState(defaults: Partial<State['settings']> = {}): State {
  const keys = nodeX25519.generate() as { secretKey: Uint8Array; publicKey: Uint8Array }
  return {
    version: 1,
    // The relay routes by this ID; the `srv_` form matches Paseo's.
    hub: { id: `srv_${randomBytes(9).toString('base64url')}`, secretKey: Buffer.from(keys.secretKey).toString('base64url'), publicKey: Buffer.from(keys.publicKey).toString('base64url') },
    settings: { name: defaults.name || hostname().replace(/\.local$/i, ''), relay: defaults.relay ?? '', tls: defaults.tls ?? true, appUrl: defaults.appUrl ?? '' },
    vapid: generateVapidKeys(),
    phones: {},
    executor: emptyExecutorData(),
  }
}

export class Store {
  private timer?: ReturnType<typeof setTimeout>
  private writing: Promise<void> = Promise.resolve()

  private constructor(private readonly file: string, readonly state: State) {}

  static async open(dir: string, defaults: Partial<State['settings']> = {}): Promise<Store> {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const file = join(dir, 'state.json')
    let state: State
    try {
      state = JSON.parse(await readFile(file, 'utf8')) as State
      if (state.version !== 1 || !state.hub?.secretKey) throw new Error(`Unsupported state in ${file}`)
      state.executor ??= emptyExecutorData()
      state.executor.sessions ??= {}; state.executor.handled ??= {}
      state.phones ??= {}
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      state = newState(defaults)
    }
    const store = new Store(file, state)
    await store.flush()
    return store
  }

  /** Write soon; several changes share one write. */
  save(): void {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => { void this.flush() }, 200)
  }

  flush(): Promise<void> {
    clearTimeout(this.timer); this.timer = undefined
    const text = JSON.stringify(this.state)
    this.writing = this.writing.then(async () => {
      const temporary = `${this.file}.${process.pid}.tmp`
      await writeFile(temporary, text, { mode: 0o600 })
      await rename(temporary, this.file)
    }).catch(error => { console.warn('[dsh-mobile] Could not save state', error) })
    return this.writing
  }
}
