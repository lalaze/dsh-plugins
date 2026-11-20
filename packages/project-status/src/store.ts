import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FILE_LIMIT, NO_REVISION, type ProjectInfo } from './domain.js';

/** `status` answers the request with it; the message is a sentence the tab can show. */
export class StatusError extends Error { constructor(message: string, readonly status = 400) { super(message); } }

export interface StoredStatus { text: string; revision: string; updatedAt?: number }
type Index = Record<string, { name: string; root: string; git: boolean; machine?: string }>;

const revisionOf = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);

/**
 * Status files, one per project, in a folder of the DSH host. The files are the record: agents edit them with their own
 * tools while the tab is open, so nothing read here is kept, and a save names the text it started from. Beside them
 * `index.json` remembers which project each file belongs to, for listing them without a conversation in each.
 */
export class StatusStore {
  private queue: Promise<unknown> = Promise.resolve();
  private index: Index | undefined;
  constructor(private readonly directory: string) {}

  file(id: string): string { return join(this.directory, 'projects', `${id}.md`); }

  async read(id: string): Promise<StoredStatus> {
    const file = this.file(id);
    try {
      const info = await stat(file);
      if (info.size > FILE_LIMIT) throw new StatusError('The status file is too large to show', 413);
      const text = await readFile(file, 'utf8');
      return { text, revision: revisionOf(text), updatedAt: info.mtimeMs };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { text: '', revision: NO_REVISION };
      throw error;
    }
  }

  /** @param base - the revision the new text was made from; another one in the file means someone wrote meanwhile. */
  write(id: string, text: string, base: string): Promise<StoredStatus> {
    return this.queued(async () => {
      const current = await this.read(id);
      if (current.revision !== base) throw new StatusError('The status changed while you were editing', 409);
      await this.replace(this.file(id), text, join(this.directory, 'projects'));
      return this.read(id);
    });
  }

  /** Notes which project a file is for. Nothing is written when it is already known as it is. */
  remember(project: ProjectInfo): Promise<void> {
    return this.queued(async () => {
      const index = await this.loadIndex(), { id, ...entry } = project, known = index[id];
      if (known && known.name === entry.name && known.root === entry.root && known.git === entry.git && known.machine === entry.machine) return;
      const next = { ...index, [id]: entry };
      await this.replace(join(this.directory, 'index.json'), `${JSON.stringify(next, null, 2)}\n`, this.directory);
      this.index = next;
    });
  }

  async projects(): Promise<ProjectInfo[]> {
    return Object.entries(await this.loadIndex()).map(([id, entry]) => ({ id, ...entry }));
  }

  private async loadIndex(): Promise<Index> {
    if (this.index) return this.index;
    let index: Index = {};
    try {
      const value: unknown = JSON.parse(await readFile(join(this.directory, 'index.json'), 'utf8'));
      if (value && typeof value === 'object' && !Array.isArray(value)) index = value as Index;
    } catch { /* Missing or unreadable: it is rebuilt as projects are opened. */ }
    return this.index = index;
  }

  /** Whole or not at all: a reader never sees half a file, and a failed write leaves the old one. */
  private async replace(file: string, text: string, directory: string): Promise<void> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      await writeFile(temp, text, { mode: 0o600, flag: 'wx' });
      await rename(temp, file);
    } finally { await rm(temp, { force: true }); }
  }

  /** One write at a time, so a check against the file and the write after it are not interleaved with another's. */
  private queued<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => {});
    return run;
  }
}
