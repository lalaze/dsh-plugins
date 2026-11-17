import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { identifier, isLocalHost, LOCAL_CONNECTION, LOCAL_HOST_ID, record, remotePath, field, taskInput, providerSelection, PROVIDER_LABELS, RemoteError, type ChatProject, type HostConfig, type FinishedTurn, type Task, type TurnUsage } from '@dsh-plugins/remote-core/domain.js';

/** A relay to stop and delete on its SSH host once it is reachable. */
export interface RelayCleanup { hostId: string; relayId: string }
/**
 * `chatEfforts` maps a native chat model route to the reasoning effort of its last explicit picker selection;
 * `chatFast` lists the DSH conversations whose Codex turns run at the Fast speed.
 */
/**
 * What DSH shares with remote CLIs: MCP servers switched on (off by default), skills switched off (on by default),
 * and the secret that derives each task's bridge token.
 */
export interface SharingSettings { mcp?: Record<string, boolean>; skills?: Record<string, boolean>; secret?: string }
/**
 * What 0.2.139 to 0.2.142 also kept, `instance` and `sharedWithdrawals` for withdrawing sessions 0.2.138 and earlier shared
 * between DSH instances, is dropped on the next save: every DSH that shared is past that version now.
 */
export interface State { version: 1; hosts: HostConfig[]; tasks: Task[]; mainChatProjects?: ChatProject[]; relayCleanups?: RelayCleanup[]; chatEfforts?: Record<string, string>; chatFast?: string[]; sharing?: SharingSettings;
  /**
   * What 0.2.129 and earlier saved about TUI conversations. dsh-remote-terminals took them over and keeps them now; they
   * stay here untouched, so that it can find them on its first start and an older version still has them.
   */
  tuiSessions?: string[]; tuiDetails?: Record<string, unknown>; tuiLocalScroll?: boolean }
/**
 * Antigravity as 0.2.129 and earlier discovered it, through `agy models`: model IDs such as `gemini-3.8-flash-high` that
 * `agy acp` does not take. Only that integration gave a provider a `notice`. Hidden while Antigravity was missing, the
 * entry came back with 0.2.134 on machines left on all CLIs, offering models that fail when chosen.
 */
const oldAntigravity = (provider: { id: string; notice?: unknown }) => provider.id === 'antigravity' && provider.notice !== undefined;
/** A task as 0.2.138 and earlier saved it, when sessions were shared between DSH instances. */
type SavedTask = Task & { shared?: { imported?: unknown }; chat?: Task['chat'] & { history?: unknown } };
/**
 * 0.2.138 and earlier shared a host's sessions with the other DSH instances using its SSH account. This DSH keeps the
 * sessions it started and drops its copies of the ones another DSH started, which that DSH still has. Their saved output
 * stays on disk.
 */
function withoutSharing(saved: SavedTask[]): Task[] {
  const tasks = saved.filter(task => task.shared?.imported !== true);
  for (const task of tasks) {
    delete task.shared;
    if (task.chat) delete task.chat.history;
  }
  return tasks;
}
/** This computer's name as the local machine's label, `lalaze-mini.local` shown as `lalaze-mini`. */
export function localMachineLabel(name = hostname()): string {
  return name.replace(/\.local\.?$/i, '').trim().slice(0, 100) || 'This computer';
}
export class Store {
  private state: State = { version: 1, hosts: [], tasks: [] };
  private writes = Promise.resolve();
  /** The file content this instance last read or wrote; undefined when the file did not exist. */
  private saved?: string;
  private closed = false;
  /** Listeners for the tokens each finished CLI turn used; the plugin forwards them to usage statistics. */
  readonly usageListeners = new Set<(taskId: string, usage: TurnUsage, turn: FinishedTurn) => void>();
  /** Called after every saved change. */
  readonly changeListeners = new Set<() => void>();
  /** Machines whose saved model catalog lost Antigravity models from 0.2.129 or earlier on opening; see {@link oldAntigravity}. */
  readonly staleCatalogs = new Set<string>();
  /** `localMachine` adds this computer's machine ({@link LOCAL_HOST_ID}) when the saved state has none. */
  constructor(private readonly path: string, private readonly options: { localMachine?: boolean } = {}) {}
  get directory(): string { return dirname(this.path); }
  async open(): Promise<void> {
    await this.load();
    // Kept in memory until the next saved change writes it: opening never writes the registry.
    if (this.options.localMachine && process.platform !== 'win32' && !this.state.hosts.some(isLocalHost)) {
      this.state.hosts.unshift({ id: LOCAL_HOST_ID, label: localMachineLabel(), connection: LOCAL_CONNECTION });
    }
  }
  private async load(): Promise<void> {
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
      // A CLI this version does not have is dropped from a saved selection (Antigravity was missing from 0.2.130 to 0.2.133).
      if (Array.isArray(host.enabledProviders)) host.enabledProviders = host.enabledProviders.filter(id => Object.hasOwn(PROVIDER_LABELS, String(id)));
      if (host.enabledProviders !== undefined) host.enabledProviders = providerSelection(host.enabledProviders);
      if (host.catalog !== undefined) {
        const catalog = record(host.catalog); remotePath(catalog.cwd);
        if (typeof catalog.checkedAt !== 'string' || !Array.isArray(catalog.providers) || !catalog.providers.every(p => p && typeof p.id === 'string' && Array.isArray(p.models) && Array.isArray(p.modes))) throw new Error('Invalid saved host model catalog');
        if (catalog.providers.some(oldAntigravity)) { catalog.providers = catalog.providers.filter(p => !oldAntigravity(p)); this.staleCatalogs.add(host.id as string); }
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
    if (value.sharing !== undefined) {
      const sharing = record(value.sharing);
      for (const table of [sharing.mcp, sharing.skills]) if (table !== undefined && !Object.values(record(table)).every(shared => typeof shared === 'boolean')) throw new Error('Invalid saved sharing settings');
      if (sharing.secret !== undefined && (typeof sharing.secret !== 'string' || !/^[a-f0-9]{64}$/.test(sharing.secret))) throw new Error('Invalid saved sharing secret');
    }
    const tasks = withoutSharing(value.tasks as SavedTask[]);
    this.state = { version: 1, hosts: value.hosts as HostConfig[], tasks, ...(value.mainChatProjects ? { mainChatProjects: value.mainChatProjects as ChatProject[] } : {}),
      ...(value.relayCleanups ? { relayCleanups: value.relayCleanups as RelayCleanup[] } : {}), ...(value.chatEfforts ? { chatEfforts: value.chatEfforts as Record<string, string> } : {}),
      ...(value.chatFast ? { chatFast: value.chatFast as string[] } : {}), ...(value.sharing ? { sharing: value.sharing as SharingSettings } : {}),
      ...(Array.isArray(value.tuiSessions) ? { tuiSessions: value.tuiSessions as string[] } : {}), ...(value.tuiDetails ? { tuiDetails: value.tuiDetails as Record<string, unknown> } : {}),
      ...(typeof value.tuiLocalScroll === 'boolean' ? { tuiLocalScroll: value.tuiLocalScroll } : {}) };
  }
  snapshot(): State { return structuredClone(this.state); }
  /** Copies of the saved hosts, without cloning agent records. Lookups run on every dashboard poll. */
  hosts(): HostConfig[] { return structuredClone(this.state.hosts); }
  chatProjects(): ChatProject[] { return structuredClone(this.state.mainChatProjects ?? []); }
  /** A copy of the sharing settings; read for every shared tool listing and call. */
  sharing(): SharingSettings { return structuredClone(this.state.sharing ?? {}); }
  /** Whether a DSH conversation's Codex turns use the Fast speed. */
  chatFast(sessionId: string): boolean { return this.state.chatFast?.includes(sessionId) ?? false; }
  /** The reasoning effort last explicitly selected for a native chat model route, if any. */
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
      const text = `${JSON.stringify(next, null, 2)}\n`;
      // Compare persisted content, not just the in-memory state: open() may have migrated old fields.
      // Keep the stale-writer check above, but do not rewrite or publish an unchanged registry.
      if (text === this.saved) return;
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, text, { mode: 0o600, flag: 'wx' });
        await rename(temporary, this.path);
      } finally { await unlink(temporary).catch(() => {}); }
      this.state = next; this.saved = text;
      for (const listener of this.changeListeners) { try { listener(); } catch { /* A listener must not fail the saved change. */ } }
    });
    this.writes = write.catch(() => {});
    return write;
  }
  async flush(): Promise<void> { await this.writes; }
  /** Finish queued writes, then refuse new ones: a closed instance must not overwrite its successor's state. */
  async close(): Promise<void> { this.closed = true; await this.writes; }
}
