/** The models chosen in settings, results waiting to be told, and the cards of flows still running. */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { combosFrom, roundsFrom, type Combo, type Setup } from './combos.js';
import { DEFAULT_ROUNDS } from './line.js';
import { routeFrom } from './routes.js';
import type { CardState } from './shared.js';

/**
 * `combos` stays absent until the first ones are saved, so an emptied list is not filled again. `worktree` is where a
 * typed /flow runs unless its line says otherwise: in a worktree of its own, through Autofix, instead of in the conversation.
 */
export interface FlowConfig extends Setup { combos?: Combo[]; worktree?: boolean }

export function configFrom(value: unknown): FlowConfig {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const plan = routeFrom(raw.plan), implement = routeFrom(raw.implement), review = routeFrom(raw.review);
  return {
    ...(plan ? { plan } : {}), ...(implement ? { implement } : {}), ...(review ? { review } : {}),
    rounds: roundsFrom(raw.rounds),
    ...(Array.isArray(raw.combos) ? { combos: combosFrom(raw.combos) } : {}),
    ...(raw.worktree === true ? { worktree: true } : {}),
  };
}
export class FlowStore {
  config: FlowConfig = { rounds: DEFAULT_ROUNDS };
  constructor(private readonly path: string) {}
  async open(): Promise<void> {
    try { this.config = configFrom(JSON.parse(await readFile(this.path, 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  async save(next: FlowConfig): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
    this.config = next;
  }
}

/** A small map kept in one JSON file, oldest entries dropped first. Writes run one at a time, so an earlier one cannot land after a later one. */
class JsonMap<T> {
  protected entries = new Map<string, T>();
  constructor(private readonly file: string, private readonly limit: number) {}
  async open(): Promise<void> {
    try { this.entries = new Map(Object.entries(JSON.parse(await readFile(this.file, 'utf8')) as Record<string, T>)); }
    catch { /* None yet, or unreadable: only something shown or told is lost. */ }
  }
  flush = (): Promise<void> => this.writes;
  private writes: Promise<void> = Promise.resolve();
  protected persist(): void {
    const content = JSON.stringify(Object.fromEntries(this.entries));
    this.writes = this.writes.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${process.pid}.tmp`;
      await writeFile(temporary, content, { mode: 0o600 });
      await rename(temporary, this.file);
    }).catch(() => undefined); // What is in memory still holds until DSH stops.
  }
  get(key: string): T | undefined { return this.entries.get(key); }
  put(key: string, value: T): void {
    this.entries.delete(key); this.entries.set(key, value);
    for (const oldest of this.entries.keys()) { if (this.entries.size <= this.limit) break; this.entries.delete(oldest); }
    this.persist();
  }
  delete(key: string): void { if (this.entries.delete(key)) this.persist(); }
}

/** Flow results waiting for a conversation's next message, which can come after DSH restarts. */
export class ReportStore extends JsonMap<string> {
  constructor(file: string) { super(file, 50); }
  take(sessionId: string): string | undefined {
    const report = this.get(sessionId);
    if (report !== undefined) this.delete(sessionId);
    return report;
  }
}

/**
 * The card of a flow that is still running, by its command. A finished card is saved in the chat itself; a card whose
 * DSH stopped never finishes, so this is what it can still show afterwards: the steps it got through.
 */
export class CardStore extends JsonMap<CardState> {
  constructor(file: string) { super(file, 50); }
}
