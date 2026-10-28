import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { identifier, record, remotePath, field, taskInput, providerSelection, RemoteError, type ChatProject, type HostConfig, type FinishedTurn, type Task, type TurnUsage } from './domain.js';

/** A relay to stop and delete on its SSH host once it is reachable. */
export interface RelayCleanup { hostId: string; relayId: string }
/**
 * `chatEfforts` maps a native chat model route to the reasoning effort its last conversation turn used;
 * `chatFast` lists the DSH conversations whose Codex turns run at the Fast speed.
 */
export interface State { version: 1; hosts: HostConfig[]; tasks: Task[]; mainChatProjects?: ChatProject[]; relayCleanups?: RelayCleanup[]; chatEfforts?: Record<string, string>; chatFast?: string[] }
export class Store {
  private state: State = { version: 1, hosts: [], tasks: [] };
  private writes = Promise.resolve();
  /** The file content this instance last read or wrote; undefined when the file did not exist. */
  private saved?: string;
  private closed = false;
  /** Listeners for the tokens each finished CLI turn used; the plugin forwards them to usage statistics. */
  readonly usageListeners = new Set<(taskId: string, usage: TurnUsage, turn: FinishedTurn) => void>();
  constructor(private readonly path: string) {}
  get directory(): string { return dirname(this.path); }
  async open(): Promise<void> {
    let text: string;
    try { text = await readFile(this.path, 'utf8'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
    this.saved = text;
    // A damaged registry must never be replaced with an empty one, losing agent identities.
    const value = record(JSON.parse(text));
    if (value.version !== 1 || !Array.isArray(value.hosts) || !Array.isArray(value.tasks)) throw new Error('Invalid remote agent registry');
    for (const raw of value.hosts) {
      const host = record(raw);
      identifier(host.id);
      if (typeof host.connection !== 'string' || typeof host.label !== 'string' || (host.password !== undefined && typeof host.password !== 'string') || (host.serverId !== undefined && typeof host.serverId !== 'string')) throw new Error('Invalid saved remote host');
      if (host.modelError !== undefined && typeof host.modelError !== 'string') throw new Error('Invalid saved host discovery error');
      if (host.enabledProviders !== undefined) host.enabledProviders = providerSelection(host.enabledProviders);
      if (host.catalog !== undefined) {
        const catalog = record(host.catalog); remotePath(catalog.cwd);
        if (typeof catalog.checkedAt !== 'string' || !Array.isArray(catalog.providers) || !catalog.providers.every(p => p && typeof p.id === 'string' && Array.isArray(p.models) && Array.isArray(p.modes))) throw new Error('Invalid saved host model catalog');
      }
    }
    for (const raw of value.tasks) {
      taskInput(raw);
      const task = record(raw);
      if (typeof task.serverId !== 'string' || typeof task.title !== 'string' || typeof task.createdAt !== 'string' || !['creating', 'ready', 'uncertain'].includes(String(task.state))) throw new Error('Invalid saved remote agent');
      if (task.relay !== undefined) identifier(record(task.relay).id);
    }
    if (value.relayCleanups !== undefined) {
      if (!Array.isArray(value.relayCleanups)) throw new Error('Invalid saved relay cleanups');
      for (const raw of value.relayCleanups) { const cleanup = record(raw); identifier(cleanup.hostId); identifier(cleanup.relayId); }
    }
    if (value.mainChatProjects !== undefined) {
      if (!Array.isArray(value.mainChatProjects)) throw new Error('Invalid saved chat projects');
      for (const raw of value.mainChatProjects) {
        const project = record(raw); identifier(project.id); identifier(project.hostId); field(project.label, 'project name', 100); remotePath(project.cwd);
        if (!Array.isArray(project.providers) || !project.providers.every(p => p && typeof p.id === 'string' && Array.isArray(p.models) && Array.isArray(p.modes))) throw new Error('Invalid saved chat project catalog');
      }
    }
    if (value.chatEfforts !== undefined && !Object.values(record(value.chatEfforts)).every(effort => typeof effort === 'string')) throw new Error('Invalid saved reasoning efforts');
    if (value.chatFast !== undefined && (!Array.isArray(value.chatFast) || !value.chatFast.every(id => typeof id === 'string'))) throw new Error('Invalid saved Fast conversations');
    this.state = { version: 1, hosts: value.hosts as HostConfig[], tasks: value.tasks as Task[], ...(value.mainChatProjects ? { mainChatProjects: value.mainChatProjects as ChatProject[] } : {}),
      ...(value.relayCleanups ? { relayCleanups: value.relayCleanups as RelayCleanup[] } : {}), ...(value.chatEfforts ? { chatEfforts: value.chatEfforts as Record<string, string> } : {}),
      ...(value.chatFast ? { chatFast: value.chatFast as string[] } : {}) };
  }
  snapshot(): State { return structuredClone(this.state); }
  /** Copies of the saved hosts, without cloning agent records. Lookups run on every dashboard poll. */
  hosts(): HostConfig[] { return structuredClone(this.state.hosts); }
  chatProjects(): ChatProject[] { return structuredClone(this.state.mainChatProjects ?? []); }
  /** The reasoning effort a native chat model route last used, if any. */
  /** Whether a DSH conversation's Codex turns use the Fast speed. */
  chatFast(sessionId: string): boolean { return this.state.chatFast?.includes(sessionId) ?? false; }
  chatEffort(route: string): string | undefined { return Object.hasOwn(this.state.chatEfforts ?? {}, route) ? this.state.chatEfforts![route] : undefined; }
  relayCleanups(hostId: string): RelayCleanup[] { return structuredClone((this.state.relayCleanups ?? []).filter(c => c.hostId === hostId)); }
  /** A copy of one saved agent record, without cloning the whole registry. */
  task(predicate: (task: Task) => boolean): Task | undefined { const found = this.state.tasks.find(predicate); return found && structuredClone(found); }
  tasks(predicate: (task: Task) => boolean): Task[] { return structuredClone(this.state.tasks.filter(predicate)); }
  /** Serialize read/modify/atomic-rename, including concurrent HTTP requests. */
  async update(change: (next: State) => void): Promise<void> {
    if (this.closed) return Promise.reject(new RemoteError('Remote agent state is closed', 503));
    const write = this.writes.then(async () => {
      const next = this.snapshot(); change(next);
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      // Never replace state another DSH instance wrote, for example after a plugin reload, with a stale snapshot.
      const current = await readFile(this.path, 'utf8').catch(e => { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; });
      if (current !== this.saved) throw new RemoteError('Remote agent state was changed by another DSH instance. Reload the plugin.', 409);
      const text = `${JSON.stringify(next, null, 2)}\n`, temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, text, { mode: 0o600, flag: 'wx' });
        await rename(temporary, this.path);
      } finally { await unlink(temporary).catch(() => {}); }
      this.state = next; this.saved = text;
    });
    this.writes = write.catch(() => {});
    return write;
  }
  async flush(): Promise<void> { await this.writes; }
  /** Finish queued writes, then refuse new ones: a closed instance must not overwrite its successor's state. */
  async close(): Promise<void> { this.closed = true; await this.writes; }
}
