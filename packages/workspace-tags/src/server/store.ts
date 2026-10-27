import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { applyTagOperation, emptyTagState, parseTagState, type TagOperation, type TagState, type WorkspaceTag } from '../shared/tags.js'

/** Serialized atomic snapshots: a failed write leaves both the file and the in-memory state unchanged. */
export class TagStore {
  private state: TagState = emptyTagState()
  private queue: Promise<unknown> = Promise.resolve()
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

  apply(operation: TagOperation): Promise<{ state: TagState; tag?: WorkspaceTag }> {
    const task = this.queue.then(async () => {
      const result = applyTagOperation(this.state, operation, () => randomUUID())
      const temp = `${this.path}.${randomUUID()}.tmp`
      try {
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
        await writeFile(temp, JSON.stringify({ version: 1, ...result.state }, null, 2), { mode: 0o600, flag: 'wx' })
        await rename(temp, this.path)
        this.state = result.state
      } finally { await rm(temp, { force: true }).catch(() => {}) }
      return { ...result, state: structuredClone(result.state) }
    })
    this.queue = task.catch(() => {})
    return task
  }
}
