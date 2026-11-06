/** The models chosen in settings. Nothing about a running flow is saved: it ends with DSH. */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { combosFrom, roundsFrom, type Combo, type Setup } from './combos.js';
import { DEFAULT_ROUNDS } from './line.js';
import { routeFrom } from './routes.js';

/** `combos` stays absent until the first ones are saved, so an emptied list is not filled again. */
export interface FlowConfig extends Setup { combos?: Combo[] }

export function configFrom(value: unknown): FlowConfig {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const plan = routeFrom(raw.plan), implement = routeFrom(raw.implement), review = routeFrom(raw.review);
  return {
    ...(plan ? { plan } : {}), ...(implement ? { implement } : {}), ...(review ? { review } : {}),
    rounds: roundsFrom(raw.rounds),
    ...(Array.isArray(raw.combos) ? { combos: combosFrom(raw.combos) } : {}),
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

/** Flow results waiting for a conversation's next message, which can come after DSH restarts. */
const MAX_REPORTS = 50;
export class ReportStore {
  private reports = new Map<string, string>();
  constructor(private readonly file: string) {}
  async open(): Promise<void> {
    try { this.reports = new Map(Object.entries(JSON.parse(await readFile(this.file, 'utf8')) as Record<string, string>)); }
    catch { /* None yet, or unreadable: a missed result only costs context. */ }
  }
  /** Writes run one at a time, so an earlier one cannot land after a later one. */
  flush = (): Promise<void> => this.writes;
  private writes: Promise<void> = Promise.resolve();
  private persist(): void {
    const content = JSON.stringify(Object.fromEntries(this.reports));
    this.writes = this.writes.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${process.pid}.tmp`;
      await writeFile(temporary, content, { mode: 0o600 });
      await rename(temporary, this.file);
    }).catch(() => undefined); // The result still holds until DSH stops.
  }
  put(sessionId: string, report: string): void {
    this.reports.delete(sessionId); this.reports.set(sessionId, report);
    for (const oldest of this.reports.keys()) { if (this.reports.size <= MAX_REPORTS) break; this.reports.delete(oldest); }
    this.persist();
  }
  take(sessionId: string): string | undefined {
    const report = this.reports.get(sessionId);
    if (report !== undefined) { this.reports.delete(sessionId); this.persist(); }
    return report;
  }
}
