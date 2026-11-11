/** Everything the plugin keeps, as JSON files in one folder. One writer: a second DSH manages through requests, not files. */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ACTIVE, defaultSettings, say, settingsFrom, type Assignment, type Settings, type Task } from './domain.js';
import type { Pool } from './pool.js';

/** Where the files are: this computer's disk now, a shared folder on a saved machine later. */
export interface Files {
  read(name: string): Promise<string | undefined>;
  write(name: string, text: string): Promise<void>;
}
export class LocalFiles implements Files {
  constructor(private readonly directory: string) {}
  async read(name: string): Promise<string | undefined> {
    try { return await readFile(join(this.directory, name), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  async write(name: string, text: string): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = join(this.directory, name), temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, text, { mode: 0o600 });
    await rename(temporary, target);
  }
}

const MAX_EVENTS = 200;
export class Store {
  settings: Settings = defaultSettings();
  pool: Pool = {};
  tasks: Record<string, Task> = {};
  /** Where bugs like earlier ones went, learned from accepted tasks; keys as in pool.ts. */
  memory: Record<string, Assignment> = {};
  /** Per source: when it was last fetched, and what went wrong if that failed. */
  fetch: Record<string, { at?: number; error?: string }> = {};
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly files: Files) {}

  private async load<T>(name: string, fallback: T): Promise<T> {
    const text = await this.files.read(name);
    if (text === undefined) return fallback;
    try { return JSON.parse(text) as T; }
    catch { throw new Error(`${name} in Autofix's folder is not valid JSON; fix or remove it`); }
  }
  async open(now = Date.now()): Promise<void> {
    const settings = await this.load<unknown>('settings.json', undefined);
    this.settings = settings === undefined ? defaultSettings() : settingsFrom(settings);
    this.pool = await this.load('pool.json', {});
    this.memory = await this.load('memory.json', {});
    const saved = await this.load<{ tasks?: Record<string, Task>; fetch?: Store['fetch'] }>('tasks.json', {});
    this.tasks = saved.tasks ?? {};
    this.fetch = saved.fetch ?? {};
    // A flow does not survive DSH stopping; what was under way is said to have stopped, and can be continued.
    let interrupted = false;
    for (const task of Object.values(this.tasks)) {
      if (!ACTIVE.includes(task.status)) continue;
      const accepting = task.status === 'accepting';
      task.status = accepting ? 'review' : 'stopped';
      task.error = say(accepting ? 'DSH stopped while this was being accepted. Check the repository before accepting again.' : 'DSH stopped while this task was running.');
      task.updatedAt = now; task.events.push({ at: now, said: task.error });
      interrupted = true;
    }
    if (interrupted) await this.saveTasks();
  }
  /** Writes run one at a time, so an earlier one cannot land after a later one. */
  private write(name: string, value: () => unknown): Promise<void> {
    const next = this.queue.then(() => this.files.write(name, `${JSON.stringify(value(), null, 2)}\n`));
    this.queue = next.catch(() => undefined);
    return next;
  }
  async saveSettings(settings: Settings): Promise<void> { this.settings = settings; await this.write('settings.json', () => this.settings); }
  savePool(): Promise<void> { return this.write('pool.json', () => this.pool); }
  saveMemory(): Promise<void> { return this.write('memory.json', () => this.memory); }
  saveTasks(): Promise<void> {
    for (const task of Object.values(this.tasks)) if (task.events.length > MAX_EVENTS) task.events = task.events.slice(-MAX_EVENTS);
    return this.write('tasks.json', () => ({ tasks: this.tasks, fetch: this.fetch }));
  }
}
