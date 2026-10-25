import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { identifier, record, taskInput, type HostConfig, type Task } from './domain.js';

export interface State { version: 1; hosts: HostConfig[]; tasks: Task[] }
export class Store {
  private state: State = { version: 1, hosts: [], tasks: [] };
  private writes = Promise.resolve();
  constructor(private readonly path: string) {}
  get directory(): string { return dirname(this.path); }
  async open(): Promise<void> {
    let text: string;
    try { text = await readFile(this.path, 'utf8'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
    // A damaged registry must never be replaced with an empty one, losing task identities.
    const value = record(JSON.parse(text));
    if (value.version !== 1 || !Array.isArray(value.hosts) || !Array.isArray(value.tasks)) throw new Error('Invalid remote task registry');
    for (const raw of value.hosts) {
      const host = record(raw);
      identifier(host.id);
      if (typeof host.connection !== 'string' || typeof host.label !== 'string' || (host.password !== undefined && typeof host.password !== 'string') || (host.serverId !== undefined && typeof host.serverId !== 'string')) throw new Error('Invalid saved remote host');
    }
    for (const raw of value.tasks) {
      taskInput(raw);
      const task = record(raw);
      if (typeof task.serverId !== 'string' || typeof task.title !== 'string' || typeof task.createdAt !== 'string' || !Array.isArray(task.submissions) || !['creating', 'ready', 'uncertain'].includes(String(task.state))) throw new Error('Invalid saved remote task');
    }
    this.state = value as unknown as State;
  }
  snapshot(): State { return structuredClone(this.state); }
  /** Serialize read/modify/atomic-rename, including concurrent HTTP requests. */
  async update(change: (next: State) => void): Promise<void> {
    const write = this.writes.then(async () => {
      const next = this.snapshot(); change(next);
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
        await rename(temporary, this.path);
      } finally { await unlink(temporary).catch(() => {}); }
      this.state = next;
    });
    this.writes = write.catch(() => {});
    return write;
  }
  async flush(): Promise<void> { await this.writes; }
}
