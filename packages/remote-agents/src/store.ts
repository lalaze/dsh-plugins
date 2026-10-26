import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { identifier, record, remotePath, field, taskInput, type ChatProject, type HostConfig, type Task } from './domain.js';

export interface State { version: 1; hosts: HostConfig[]; tasks: Task[]; mainChatProjects?: ChatProject[] }
export class Store {
  private state: State = { version: 1, hosts: [], tasks: [] };
  private writes = Promise.resolve();
  constructor(private readonly path: string) {}
  get directory(): string { return dirname(this.path); }
  async open(): Promise<void> {
    let text: string;
    try { text = await readFile(this.path, 'utf8'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
    // A damaged registry must never be replaced with an empty one, losing agent identities.
    const value = record(JSON.parse(text));
    if (value.version !== 1 || !Array.isArray(value.hosts) || !Array.isArray(value.tasks)) throw new Error('Invalid remote agent registry');
    for (const raw of value.hosts) {
      const host = record(raw);
      identifier(host.id);
      if (typeof host.connection !== 'string' || typeof host.label !== 'string' || (host.password !== undefined && typeof host.password !== 'string') || (host.serverId !== undefined && typeof host.serverId !== 'string')) throw new Error('Invalid saved remote host');
      if (host.modelError !== undefined && typeof host.modelError !== 'string') throw new Error('Invalid saved host discovery error');
      if (host.catalog !== undefined) {
        const catalog = record(host.catalog); remotePath(catalog.cwd);
        if (typeof catalog.checkedAt !== 'string' || !Array.isArray(catalog.providers) || !catalog.providers.every(p => p && typeof p.id === 'string' && Array.isArray(p.models) && Array.isArray(p.modes))) throw new Error('Invalid saved host model catalog');
      }
    }
    for (const raw of value.tasks) {
      taskInput(raw);
      const task = record(raw);
      if (typeof task.serverId !== 'string' || typeof task.title !== 'string' || typeof task.createdAt !== 'string' || !['creating', 'ready', 'uncertain'].includes(String(task.state))) throw new Error('Invalid saved remote agent');
    }
    if (value.mainChatProjects !== undefined) {
      if (!Array.isArray(value.mainChatProjects)) throw new Error('Invalid saved chat projects');
      for (const raw of value.mainChatProjects) {
        const project = record(raw); identifier(project.id); identifier(project.hostId); field(project.label, 'project name', 100); remotePath(project.cwd);
        if (!Array.isArray(project.providers) || !project.providers.every(p => p && typeof p.id === 'string' && Array.isArray(p.models) && Array.isArray(p.modes))) throw new Error('Invalid saved chat project catalog');
      }
    }
    this.state = { version: 1, hosts: value.hosts as HostConfig[], tasks: value.tasks as Task[], ...(value.mainChatProjects ? { mainChatProjects: value.mainChatProjects as ChatProject[] } : {}) };
  }
  snapshot(): State { return structuredClone(this.state); }
  /** Copies of the saved hosts, without cloning agent records. Lookups run on every dashboard poll. */
  hosts(): HostConfig[] { return structuredClone(this.state.hosts); }
  chatProjects(): ChatProject[] { return structuredClone(this.state.mainChatProjects ?? []); }
  /** A copy of one saved agent record, without cloning the whole registry. */
  task(predicate: (task: Task) => boolean): Task | undefined { const found = this.state.tasks.find(predicate); return found && structuredClone(found); }
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
