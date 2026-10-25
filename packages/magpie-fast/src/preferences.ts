import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { record } from './config.js';

export function validSessionId(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9:_-]{1,256}$/.test(value); }
export class Preferences {
  private entries = new Map<string, boolean>();
  private pending = Promise.resolve();
  constructor(private readonly path: string) {}
  async load() {
    let data: unknown;
    try { data = JSON.parse(await readFile(this.path, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    const stored = record(data);
    if (stored?.version !== 1 || !Array.isArray(stored.sessions) || stored.sessions.length > 10000) throw new Error("Invalid GPT Fast preferences file");
    const entries = new Map<string, boolean>();
    for (const row of stored.sessions) {
      if (!Array.isArray(row) || row.length !== 2 || !validSessionId(row[0]) || typeof row[1] !== 'boolean') throw new Error("Invalid GPT Fast session record");
      entries.set(row[0], row[1]);
    }
    this.entries = entries;
  }
  get(sessionId: string, fallback: boolean) { return this.entries.get(sessionId) ?? fallback; }
  set(sessionId: string, enabled: boolean): Promise<void> {
    if (!validSessionId(sessionId)) return Promise.reject(new Error("Invalid session"));
    const operation = this.pending.then(async () => {
      const entries = new Map(this.entries); entries.delete(sessionId); entries.set(sessionId, enabled);
      while (entries.size > 10000) entries.delete(entries.keys().next().value!);
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      await mkdir(dirname(this.path), { recursive: true });
      try {
        await writeFile(temporary, JSON.stringify({ version: 1, sessions: [...entries] }), { mode: 0o600, flag: 'wx' });
        await rename(temporary, this.path); this.entries = entries;
      } finally { await unlink(temporary).catch(() => {}); }
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
  idle() { return this.pending; }
}
const shared = new Map<string, { refs: number; store: Preferences; ready: Promise<Preferences> }>();
export function acquirePreferences(path: string) {
  let entry = shared.get(path);
  if (!entry) { const store = new Preferences(path); entry = { refs: 0, store, ready: store.load().then(() => store) }; shared.set(path, entry); }
  entry.refs++;
  const captured = entry; let released = false;
  return { ready: captured.ready, release: () => {
    if (released) return; released = true; captured.refs--;
    void captured.ready.catch(() => {}).then(() => captured.store.idle()).finally(() => {
      if (!captured.refs && shared.get(path) === captured) shared.delete(path);
    });
  } };
}
