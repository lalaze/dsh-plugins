/**
 * Read-only copies of another machine's sessions, kept in this plugin's own storage and never in DSH's session store.
 *
 * Each session is an append-only file of shared events. Appends only take events after the stored position, and
 * reads drop repeated sequence numbers, so a retried or interrupted fetch can never show an event twice. Attachments
 * are stored once per content hash, whichever sessions refer to them.
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { MirrorSessionView, SessionEntry, SyncedEvent, WorkspaceEntry } from '../shared/protocol.js'
import { titleOf } from './events.js'
import { appendLines, readJson, Serial, writeAtomic, writeJsonAtomic } from './files.js'

export interface AttachmentMeta { kind: 'image' | 'file'; mediaType?: string; name?: string; bytes?: number; sha256?: string }
/** `storedSeq` is the last event held, or -1 before the first. */
interface MirrorSession extends SessionEntry { storedSeq: number; hidden?: boolean; localTitle?: string; attachments?: Record<string, AttachmentMeta> }
interface MirrorIndex { version: 1; cursor?: string; workspaces: WorkspaceEntry[]; sessions: Record<string, MirrorSession> }

const safeId = (id: string) => {
  if (!/^[\w.-]{1,200}$/.test(id)) throw new Error('Invalid identifier')
  return id
}

export class Mirror {
  private index: MirrorIndex = { version: 1, workspaces: [], sessions: {} }
  private readonly serial = new Serial()
  constructor(readonly deviceId: string, private readonly dir: string) {}

  async load(): Promise<void> {
    const stored = await readJson<MirrorIndex>(join(this.dir, 'index.json'))
    if (stored?.version === 1) this.index = { version: 1, cursor: stored.cursor, workspaces: stored.workspaces ?? [], sessions: stored.sessions ?? {} }
  }

  private save(): Promise<void> { return writeJsonAtomic(join(this.dir, 'index.json'), this.index) }

  get cursor(): string | undefined { return this.index.cursor }
  workspaces(): WorkspaceEntry[] { return this.index.workspaces }

  /** Apply one changes response, then remember its cursor. */
  update(changes: { cursor: string; workspaces?: WorkspaceEntry[]; sessions: SessionEntry[] }): Promise<void> {
    return this.serial.run(async () => {
      if (changes.workspaces) this.index.workspaces = changes.workspaces
      for (const entry of changes.sessions) {
        const id = safeId(entry.sessionId)
        const old = this.index.sessions[id]
        this.index.sessions[id] = { ...entry, storedSeq: old?.storedSeq ?? -1, ...(old?.hidden ? { hidden: true } : {}),
          ...(old?.localTitle ? { localTitle: old.localTitle } : {}), ...(old?.attachments ? { attachments: old.attachments } : {}) }
      }
      this.index.cursor = changes.cursor
      await this.save()
    })
  }

  /** Replace one entry's live status without touching its stored events. */
  status(entry: SessionEntry): Promise<void> {
    return this.serial.run(async () => {
      const old = this.index.sessions[safeId(entry.sessionId)]
      if (!old) return
      this.index.sessions[entry.sessionId] = { ...old, ...entry, storedSeq: old.storedSeq }
      await this.save()
    })
  }

  session(sessionId: string): MirrorSession | undefined { return this.index.sessions[sessionId] }

  /** Sessions whose executing machine has events this copy lacks. */
  behind(): MirrorSession[] { return Object.values(this.index.sessions).filter(s => !s.removed && s.lastSeq > s.storedSeq) }

  views(): MirrorSessionView[] {
    return Object.values(this.index.sessions).map(({ localTitle, attachments: _attachments, title, ...session }) => ({
      ...session, deviceId: this.deviceId, ...(title ?? localTitle ? { title: title ?? localTitle } : {}),
    }))
  }

  /**
   * Store events after the stored position; everything through `through` counts as held afterwards.
   * @returns the events that were new.
   */
  append(sessionId: string, events: readonly SyncedEvent[], through: number, attachments: Record<string, AttachmentMeta> = {}): Promise<SyncedEvent[]> {
    return this.serial.run(async () => {
      const session = this.index.sessions[safeId(sessionId)]
      if (!session) return []
      const fresh = events.filter(event => event.seq > session.storedSeq).sort((a, b) => a.seq - b.seq)
      await appendLines(this.logPath(sessionId), fresh.map(event => JSON.stringify(event)))
      session.storedSeq = Math.max(session.storedSeq, through, fresh.at(-1)?.seq ?? -1)
      const title = titleOf(fresh)
      if (title) session.localTitle = title
      for (const [id, meta] of Object.entries(attachments)) session.attachments = { ...session.attachments, [id]: { ...session.attachments?.[id], ...meta } }
      await this.save()
      return fresh
    })
  }

  /** Stored events in order, each sequence once, optionally after a position and up to a count from the end. */
  async read(sessionId: string, options: { after?: number; last?: number } = {}): Promise<SyncedEvent[]> {
    const path = this.logPath(safeId(sessionId))
    try { await access(path) } catch { return [] }
    const bySeq = new Map<number, SyncedEvent>()
    const lines = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity })
    for await (const line of lines) {
      if (!line.trim()) continue
      try {
        const event = JSON.parse(line) as SyncedEvent
        if (typeof event.seq === 'number' && event.seq > (options.after ?? -1) && !bySeq.has(event.seq)) bySeq.set(event.seq, event)
      } catch { /* a line cut short by a crash; the fetch after it repeats the event */ }
    }
    const events = [...bySeq.values()].sort((a, b) => a.seq - b.seq)
    return options.last ? events.slice(-options.last) : events
  }

  attachment(sessionId: string, attachmentId: string): AttachmentMeta | undefined { return this.index.sessions[sessionId]?.attachments?.[attachmentId] }

  setAttachment(sessionId: string, attachmentId: string, meta: AttachmentMeta): Promise<void> {
    return this.serial.run(async () => {
      const session = this.index.sessions[sessionId]
      if (!session) return
      session.attachments = { ...session.attachments, [attachmentId]: { ...session.attachments?.[attachmentId], ...meta } }
      await this.save()
    })
  }

  /** Hide a session here, or show it again. Nothing is deleted. */
  hide(sessionId: string, hidden: boolean): Promise<void> {
    return this.serial.run(async () => {
      const session = this.index.sessions[sessionId]
      if (!session) throw new Error('Unknown session')
      if (hidden) session.hidden = true; else delete session.hidden
      await this.save()
    })
  }

  /** Everything this copy stores, for a backup. */
  snapshot(): MirrorIndex { return structuredClone(this.index) }

  /** Delete the copy entirely, after the user chose to forget a machine's history. */
  destroy(): Promise<void> { return this.serial.run(() => rm(this.dir, { recursive: true, force: true })) }

  private logPath(sessionId: string) { return join(this.dir, 'sessions', `${safeId(sessionId)}.jsonl`) }
}

/** Attachment bytes stored by SHA-256, shared by every mirror. */
export class Blobs {
  constructor(private readonly dir: string) {}
  path(sha256: string) {
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('Invalid content hash')
    return join(this.dir, sha256.slice(0, 2), sha256)
  }
  async has(sha256: string): Promise<boolean> {
    try { await stat(this.path(sha256)); return true } catch { return false }
  }
  async put(data: Uint8Array): Promise<string> {
    const sha256 = createHash('sha256').update(data).digest('hex')
    if (!await this.has(sha256)) await writeAtomic(this.path(sha256), data)
    return sha256
  }
  get(sha256: string): Promise<Buffer> { return readFile(this.path(sha256)) }
  async count(): Promise<number> {
    try {
      let total = 0
      for (const shard of await readdir(this.dir)) total += (await readdir(join(this.dir, shard))).length
      return total
    } catch { return 0 }
  }
}

export async function ensureDir(path: string) { await mkdir(path, { recursive: true, mode: 0o700 }) }
