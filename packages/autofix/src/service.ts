/** The sources that hand bugs in, and what the board and the settings page can ask for. */
import { fail, itemFrom, itemKey, messageOf, settingsFrom, SOURCE_ID, type Assignment, type Autofix, type Item, type Message, type PoolItem, type Settings, type Source, type Task } from './domain.js';
import { MANUAL, type ManualInput, type ManualSource } from './manual.js';
import { ordered, refresh, suggest } from './pool.js';
import type { Store } from './store.js';
import type { FlowProgress } from './conversations.js';
import type { Tasks } from './tasks.js';
import type { Folders } from './folders.js';
import type { Workplaces } from './workplaces.js';

/** The sources loaded right now. A source's plugin may come and go while this one runs. */
export class Sources {
  private readonly loaded = new Map<string, Source>();
  constructor(private readonly changed: () => void = () => undefined) {}
  register(source: Source): () => void {
    if (!source || !SOURCE_ID.test(source.id) || typeof source.name !== 'string' || !source.name.trim()) throw new Error('A source needs an ID of lowercase letters, digits and dashes, and a name');
    this.loaded.set(source.id, source);
    this.changed();
    return () => { if (this.loaded.get(source.id) === source) { this.loaded.delete(source.id); this.changed(); } };
  }
  get(id: string): Source | undefined { return this.loaded.get(id); }
  list(): Source[] { return [...this.loaded.values()].sort((a, b) => a.name.localeCompare(b.name)); }
}

export interface ServiceHost {
  store: Store; tasks: Tasks; sources: Sources;
  /** The built-in source for bugs a person types in. */
  manual?: ManualSource;
  workplaces: Pick<Workplaces, 'projects' | 'inspect' | 'machine'>;
  /** The machines on which other DSHes can hand bugs to this one, when that is switched on. */
  relay?(): { label: string; routes: string[]; error?: string }[];
  folders: Pick<Folders, 'add' | 'repository'>;
  /** The plugins this one works through that are not running right now, by package name. */
  needs?(): string[];
  now?(): number;
}
export interface SourceView { id: string; name: string; unready?: Message; fetches: boolean; at?: number; error?: string; busy: boolean }
export interface PoolView extends PoolItem { sourceName: string }
export interface State {
  settings: Settings;
  /** Loaded sources; a bug whose source is not among them can still be read, not started or written back. */
  sources: SourceView[];
  pool: PoolView[];
  /** `progress` is the flow a task is in this very moment, when it runs here and can say. */
  tasks: (Task & { running: boolean; sourceName: string; progress?: FlowProgress })[];
  relay: { label: string; routes: string[]; error?: string }[];
  /** Plugins that are not running and without which repositories cannot be reached or fixes cannot run. */
  needs: string[];
}
const DIFF_LIMIT = 400_000;
const text = (value: unknown, what: string, max = 4000): string => {
  if (typeof value !== 'string' || value.length > max) throw new Error(`${what} is missing`);
  return value.trim();
};

/** `file` is the conversations' side of the service; the plugin adds it where it has the command. */
export class AutofixService implements Omit<Autofix, 'file'> {
  readonly version = 1 as const;
  private readonly fetching = new Map<string, Promise<{ added: number }>>();
  constructor(private readonly host: ServiceHost) {}
  private now(): number { return this.host.now?.() ?? Date.now(); }
  register(source: Source): () => void { return this.host.sources.register(source); }

  state(): State {
    const { store, tasks, sources } = this.host, name = (id: string) => sources.get(id)?.name ?? id;
    return {
      settings: store.settings,
      sources: sources.list().map(source => {
        const unready = source.unready?.();
        return { id: source.id, name: source.name, ...(unready ? { unready } : {}), fetches: !!source.fetch, ...store.fetch[source.id], busy: this.fetching.has(source.id) };
      }),
      pool: ordered(store.pool).map(entry => ({ ...entry, sourceName: name(entry.item.source) })),
      tasks: Object.values(store.tasks).sort((a, b) => b.updatedAt - a.updatedAt).map(task => this.view(task)),
      relay: this.host.relay?.() ?? [],
      needs: this.host.needs?.() ?? [],
    };
  }
  /** One task as the board shows it, for a card that follows only that one. */
  task(key: unknown): State['tasks'][number] | undefined {
    const task = this.host.store.tasks[text(key, 'The bug', 300)];
    return task && this.view(task);
  }
  private view(task: Task): State['tasks'][number] {
    const { tasks, sources } = this.host, progress = tasks.progress(task.key);
    return { ...task, running: tasks.running(task.key), sourceName: sources.get(task.item.source)?.name ?? task.item.source, ...(progress ? { progress } : {}) };
  }
  async saveSettings(raw: unknown): Promise<void> { const next: Settings = settingsFrom(raw); await this.host.store.saveSettings(next); }
  projects(signal?: AbortSignal) { return this.host.workplaces.projects(signal); }
  /** A folder on the computer DSH runs on, as a project to choose. Its repository may already be one under another folder. */
  async addFolder(path: unknown, signal?: AbortSignal) {
    const { folders } = this.host, added = await folders.add(text(path, 'The folder', 4096));
    const projects = await this.projects(signal), local = projects.filter(project => project.location.kind === 'local');
    let project = local.find(entry => entry.path === added.folder);
    if (!project) for (const entry of local) if (await folders.repository(entry.folder) === added.repository) { project = entry; break; }
    if (!project) throw fail('DSH did not add {folder} as a workspace', { folder: added.folder });
    return { project: project.path, projects, remotes: added.remotes };
  }
  /** A project's branches and package folders, for assigning a bug. */
  async project(path: string, globs: readonly string[], signal?: AbortSignal): Promise<{ name: string; defaultBase: string | null; branches: string[]; packages: string[] }> {
    const detail = await this.host.workplaces.inspect(text(path, 'The project', 4096), signal);
    let packages: string[] = [];
    const patterns = globs.filter(glob => /^[\w.@/-]*\*[\w.@/-]*$/u.test(glob) && !glob.split('/').includes('..'));
    if (patterns.length) {
      const machine = await this.host.workplaces.machine(path, signal);
      const [listed] = await machine.git([{ argv: ['ls-files', '--', ...patterns.map(glob => `${glob}/package.json`)] }], { reads: true, signal });
      packages = listed.code === 0 ? listed.stdout.split('\n').map(line => line.trim().replace(/\/package\.json$/u, '')).filter(Boolean).sort() : [];
    }
    return { name: detail.name, defaultBase: detail.defaultBase, branches: detail.branches.map(branch => branch.name), packages };
  }

  /** Bugs into the pool. New ones like earlier ones (same title prefix, or same project of the source) get the same place straight away. */
  private async merge(sourceId: string, raw: readonly unknown[], complete: boolean): Promise<{ added: number }> {
    const { store } = this.host, items: Item[] = raw.map(entry => itemFrom(entry, sourceId)), merged = refresh(store.pool, sourceId, items, this.now(), complete);
    for (const entry of Object.values(merged.pool)) {
      if (entry.item.source !== sourceId || entry.assignment || entry.dismissed || entry.stale || store.pool[entry.key]) continue;
      const known = suggest(merged.pool, entry.item, store.memory);
      if (known && store.settings.routes.some(route => route.id === known.routeId)) entry.assignment = { ...known };
    }
    store.pool = merged.pool;
    await store.savePool();
    return { added: merged.added };
  }
  async submit(sourceId: string, items: readonly Item[]): Promise<{ added: number }> {
    if (!this.host.sources.get(sourceId)) throw new Error('Register the source before handing bugs in');
    if (!Array.isArray(items) || items.length > 2000) throw new Error('Hand in at most 2000 bugs at a time');
    return this.merge(sourceId, items, false);
  }
  /** Asks one source, or every source that can be asked and is set up. One failing does not stop the others. */
  async fetch(sourceId?: string): Promise<{ added: number }> {
    const { sources, store } = this.host;
    const wanted = sourceId ? [sources.get(sourceId)].filter((source): source is Source => !!source) : sources.list().filter(source => source.fetch && !source.unready?.());
    if (sourceId && !wanted.length) throw new Error('This source is not loaded');
    let added = 0, failure: unknown;
    await Promise.all(wanted.map(async source => {
      let running = this.fetching.get(source.id);
      if (!running) {
        running = (async () => {
          try {
            if (!source.fetch) throw new Error(`${source.name} hands bugs in by itself; it cannot be asked`);
            const result = await this.merge(source.id, await source.fetch(), true);
            store.fetch[source.id] = { at: this.now() };
            return result;
          } catch (error) {
            store.fetch[source.id] = { ...(store.fetch[source.id]?.at ? { at: store.fetch[source.id].at } : {}), error: error instanceof Error ? error.message : String(error) };
            throw error;
          } finally { this.fetching.delete(source.id); await store.saveTasks().catch(() => undefined); }
        })();
        this.fetching.set(source.id, running);
      }
      // Not `added += (await …)`: that reads the sum before waiting, and the sources answer in any order.
      try { const result = await running; added += result.added; } catch (error) { failure ??= error; }
    }));
    if (failure && (sourceId || wanted.length === 1)) throw failure;
    return { added };
  }
  /** A bug a person typed, with its pictures, into the pool; `assignment` says where it goes, as assigning it would. */
  async createManual(input: ManualInput & { assignment?: { routeId?: unknown; branch?: unknown; package?: unknown } | null }): Promise<{ key: string }> {
    if (!this.host.manual) throw new Error('Typing bugs in is not available');
    const item = await this.host.manual.create(input), key = itemKey(item);
    try {
      await this.merge(MANUAL, [item], false);
      if (input.assignment?.routeId) await this.assign(key, input.assignment);
    } catch (error) {
      // Half a bug is worse than none: the person still has what they typed and can try again.
      delete this.host.store.pool[key];
      await this.host.store.savePool().catch(() => undefined);
      await this.host.manual.discard(item).catch(() => undefined);
      throw error;
    }
    return { key };
  }
  /** Throws a bug away for good. Only what no source will hand in again: otherwise the next fetch brings it back. */
  async discard(key: unknown): Promise<void> {
    const entry = this.entry(key), source = this.host.sources.get(entry.item.source);
    if (source?.fetch && !entry.stale) throw new Error(`${source.name} still lists this bug; ignore it instead`);
    if (this.host.store.tasks[entry.key] && this.host.store.tasks[entry.key].status !== 'done') throw new Error('This bug has a task; remove the task first');
    delete this.host.store.pool[entry.key];
    await this.host.store.savePool();
    await source?.discard?.(entry.item).catch(() => undefined);
  }
  private entry(key: unknown): PoolItem {
    const entry = this.host.store.pool[text(key, 'The bug', 300)];
    if (!entry) throw new Error('This bug is not in the pool; fetch again');
    return entry;
  }
  async assign(key: unknown, input: { routeId?: unknown; branch?: unknown; package?: unknown } | null): Promise<void> {
    const entry = this.entry(key);
    if (!input) delete entry.assignment;
    else {
      const route = this.host.store.settings.routes.find(candidate => candidate.id === input.routeId);
      if (!route) throw new Error('Choose a repository');
      const branch = text(input.branch ?? '', 'The branch', 200) || route.defaultBranch, where = typeof input.package === 'string' ? input.package.trim().replace(/\/+$/u, '') : '';
      if (!branch) throw new Error('Choose a branch');
      if (where.startsWith('/') || where.split('/').includes('..')) throw new Error('The package is a folder inside the repository');
      const assignment: Assignment = { routeId: route.id, branch, ...(where ? { package: where } : {}) };
      entry.assignment = assignment;
    }
    await this.host.store.savePool();
  }
  async dismiss(key: unknown, dismissed: boolean): Promise<void> {
    const entry = this.entry(key);
    if (dismissed) entry.dismissed = true; else delete entry.dismissed;
    await this.host.store.savePool();
  }
  /** What the fix changed since it left the base branch, for reading before accepting. */
  async diff(key: unknown, signal?: AbortSignal): Promise<{ stat: string; patch: string; truncated: boolean }> {
    const task = this.host.store.tasks[text(key, 'The bug', 300)];
    if (!task?.workspacePath) throw new Error('This task has no worktree');
    const route = this.host.store.settings.routes.find(candidate => candidate.id === task.routeId), base = `refs/remotes/${route?.pushRemote ?? 'origin'}/${task.baseBranch}`;
    const machine = await this.host.workplaces.machine(task.workspacePath, signal);
    const [stat, patch] = await machine.git([{ argv: ['diff', '--no-color', '--stat=120', `${base}...HEAD`] }, { argv: ['diff', '--no-color', '--no-ext-diff', `${base}...HEAD`] }], { reads: true, signal });
    if (patch.code !== 0) throw new Error(`Git could not show the changes: ${(patch.stderr || stat.stderr).trim().slice(-500)}`);
    return { stat: stat.stdout, patch: patch.stdout.slice(0, DIFF_LIMIT), truncated: patch.stdout.length > DIFF_LIMIT };
  }
}
export { itemKey, messageOf };
