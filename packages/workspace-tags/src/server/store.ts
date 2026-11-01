import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { applyTagOperation, emptyTagState, parseTagState, type TagOperation, type TagState, type WorkspaceTag } from '../shared/tags.js'

/** Serialized atomic snapshots: a failed write leaves both the file and the in-memory state unchanged. */
export class TagStore {
  private state: TagState = emptyTagState()
  private queue: Promise<unknown> = Promise.resolve()
  private readonly listeners = new Set<(state: TagState) => void>()
  /**
   * Changes on each saved state. Starts from a per-process random epoch, so a client polling with a revision from
   * before a host restart always reloads.
   */
  private counter = 0
  private readonly epoch = randomUUID().slice(0, 8)
  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    let raw: string
    try { raw = await readFile(this.path, 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    let value: unknown
    try { value = JSON.parse(raw) }
    catch {
      // Keep the unreadable file for inspection and start empty rather than blocking the sidebar.
      const kept = `${this.path}.unreadable-${Date.now()}`
      await rename(this.path, kept)
      console.warn(`[dsh-workspace-tags] ${this.path} was not valid JSON; moved it to ${kept}`)
      return
    }
    this.state = parseTagState(value)
  }

  snapshot(): TagState { return structuredClone(this.state) }

  /** Opaque value that changes whenever the saved state does. */
  revision(): string { return `${this.epoch}-${this.counter}` }

  /** Called after each saved change, with the new state. */
  subscribe(listener: (state: TagState) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  apply(operation: TagOperation): Promise<{ state: TagState; tag?: WorkspaceTag }> {
    return this.write(state => applyTagOperation(state, operation, () => randomUUID()))
  }

  /**
   * Save a whole state at once, for host plugins that merge tags from elsewhere (dsh-device-sync). The state is
   * normalized like a stored file, so invalid tags and assignments are dropped rather than saved.
   */
  replace(next: TagState): Promise<{ state: TagState }> {
    return this.write(() => ({ state: parseTagState(next) }))
  }

  private write<T extends { state: TagState }>(change: (state: TagState) => T): Promise<T> {
    const task = this.queue.then(async () => {
      const result = change(this.state)
      const temp = `${this.path}.${randomUUID()}.tmp`
      try {
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
        await writeFile(temp, JSON.stringify({ version: 1, ...result.state }, null, 2), { mode: 0o600, flag: 'wx' })
        await rename(temp, this.path)
        this.state = result.state
        this.counter++
      } finally { await rm(temp, { force: true }).catch(() => {}) }
      for (const listener of this.listeners) {
        try { listener(structuredClone(this.state)) } catch (error) { console.warn('[dsh-workspace-tags] A tag listener failed', error) }
      }
      return { ...result, state: structuredClone(result.state) }
    })
    this.queue = task.catch(() => {})
    return task
  }
}
