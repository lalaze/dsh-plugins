import { realpath } from 'node:fs/promises';
import nodePath from 'node:path';
import { FIELDS, FIELD_LIMIT, REMOTE_ANCHOR, type Conversations, type Field, type ProjectStatusEntry, type StatusAnswer } from './domain.js';
import { workplace, type RemoteWorktrees, type Workplace } from './git.js';
import { inspect, type Inspection } from './project.js';
import { parseStatus, serializeStatus, tidy } from './status-file.js';
import { StatusError, type StatusStore } from './store.js';

/** A conversation as DSH lists it, as far as it is read here. */
export interface SessionRow { sessionId?: string; cwd?: string; updatedAt?: number | string; blank?: boolean; parentSessionId?: string | null }

export interface ServiceOptions {
  /** The folder a conversation works in now. */
  cwd(sessionId: string): Promise<string | undefined>;
  /** dsh-remote-terminals' worktree service, when that plugin is there. */
  worktrees(): RemoteWorktrees | undefined;
  /** Every conversation of this DSH. */
  sessions(): Promise<SessionRow[]>;
  now?(): number;
}

/** How long one round of Git answers for a folder. The tab polls every few seconds, and nothing here changes that fast. */
const FACTS_TTL = 10_000;
const time = (value: unknown) => {
  const at = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(at) && at > 0 ? at : undefined;
};

export class ProjectStatusService {
  private readonly inspections = new Map<string, { at: number; value: Promise<{ place: Workplace; found: Inspection }> }>();
  private readonly now: () => number;
  constructor(private readonly store: StatusStore, private readonly options: ServiceOptions) { this.now = options.now ?? Date.now; }

  /** The status of the project a conversation works in. */
  async get(sessionId: string, signal?: AbortSignal): Promise<StatusAnswer> {
    return this.answer(await this.folderOf(sessionId), signal);
  }

  /**
   * Puts one field into the project's file, leaving the other three and the file's other sections as they are. The tab
   * saves as the user types and ticks, while agents edit the same file, so what is checked is the field alone: a change to
   * another one meanwhile is no conflict.
   * @param was - the field's text when the edit began; another text in the file by now means someone else wrote it.
   * @param language - of the headings, for a file that has none yet.
   */
  async save(sessionId: string, field: unknown, value: unknown, was: unknown, language: unknown, signal?: AbortSignal): Promise<StatusAnswer> {
    if (!FIELDS.includes(field as Field)) throw new StatusError('Invalid status');
    if (typeof value !== 'string' || value.length > FIELD_LIMIT || typeof was !== 'string') throw new StatusError('Invalid status');
    const name = field as Field, next = tidy(value), from = tidy(was);
    const folder = await this.folderOf(sessionId), { found: { project } } = await this.inspected(folder, signal);
    for (let attempt = 0; ; attempt++) {
      const current = await this.store.read(project.id), parsed = parseStatus(current.text);
      // Already there: the same save came twice, or someone wrote the same thing.
      if (parsed.fields[name] === next) break;
      if (parsed.fields[name] !== from) throw new StatusError('The status changed while you were editing', 409);
      const text = serializeStatus({ ...parsed, fields: { ...parsed.fields, [name]: next } }, language === 'zh' ? 'zh' : 'en', project.name);
      // A line that reads as a heading would leave the field for a section of its own, and come back with every save.
      if (parseStatus(text).fields[name] !== next) throw new StatusError('A line that starts with ## would begin another section');
      try { await this.store.write(project.id, text, current.revision); break; }
      catch (error) {
        // The file was written between the read and the write: look again, a few times.
        if (!(error instanceof StatusError && error.status === 409) || attempt >= 2) throw error;
      }
    }
    return this.answer(folder, signal);
  }

  /** For other plugins: the status of the project a folder belongs to. */
  async forFolder(folder: string, signal?: AbortSignal): Promise<ProjectStatusEntry> {
    const { project, fields, updatedAt } = await this.answer(folder, signal);
    return { project, fields, ...(updatedAt === undefined ? {} : { updatedAt }) };
  }

  /** For other plugins: every project that has been opened in the tab, with what its file says now. */
  async list(): Promise<ProjectStatusEntry[]> {
    const entries: ProjectStatusEntry[] = [];
    for (const project of await this.store.projects()) {
      const stored = await this.store.read(project.id).catch(() => undefined);
      if (stored) entries.push({ project, fields: parseStatus(stored.text).fields, ...(stored.updatedAt === undefined ? {} : { updatedAt: stored.updatedAt }) });
    }
    return entries;
  }

  private async folderOf(sessionId: string): Promise<string> {
    const folder = await this.options.cwd(sessionId);
    if (!folder) throw new StatusError('This conversation has no folder', 404);
    return folder;
  }

  private inspected(folder: string, signal?: AbortSignal) {
    const known = this.inspections.get(folder), now = this.now();
    if (known && now - known.at < FACTS_TTL) return known.value;
    const value = (async () => {
      const place = await workplace(folder, REMOTE_ANCHOR.test(folder), this.options.worktrees(), signal);
      return { place, found: await inspect(place, signal) };
    })();
    const entry = { at: now, value };
    this.inspections.set(folder, entry);
    // A failure, or a request that was dropped, is not an answer to keep.
    value.catch(() => { if (this.inspections.get(folder) === entry) this.inspections.delete(folder); });
    for (const [key, old] of this.inspections) if (now - old.at >= FACTS_TTL && old !== entry) this.inspections.delete(key);
    return value;
  }

  private async answer(folder: string, signal?: AbortSignal): Promise<StatusAnswer> {
    const { place, found } = await this.inspected(folder, signal), { project } = found;
    const stored = await this.store.read(project.id), parsed = parseStatus(stored.text);
    void this.store.remember(project).catch(() => {});
    const conversations = await this.conversations(folder, place, found.checkouts).catch(() => undefined);
    return {
      project, fields: parsed.fields, more: parsed.extra.length > 0, revision: stored.revision,
      ...(stored.updatedAt === undefined ? {} : { updatedAt: stored.updatedAt }),
      // An agent on another machine cannot open a file kept on this one.
      ...(place.remote ? {} : { file: this.store.file(project.id) }),
      ...(found.facts ? { facts: found.facts } : {}), ...(found.factsError ? { factsError: found.factsError } : {}),
      ...(conversations ? { conversations } : {}),
    };
  }

  /**
   * Conversations started in the project's checkouts, or in a folder inside one. A remote workspace's conversations all
   * start in its one anchor folder on this computer.
   */
  private async conversations(folder: string, place: Workplace, checkouts: string[]): Promise<Conversations | undefined> {
    const rows = (await this.options.sessions()).filter(row => typeof row.cwd === 'string' && row.cwd && !row.blank && !row.parentSessionId);
    if (!rows.length) return undefined;
    const roots = place.remote ? [folder] : checkouts, resolved = new Map<string, string>(), sep = place.remote ? nodePath.sep : place.path.sep;
    const real = async (value: string) => {
      let known = resolved.get(value);
      if (known === undefined) resolved.set(value, known = place.remote ? value : await realpath(value).catch(() => value));
      return known;
    };
    const within = async (cwd: string) => {
      const target = await real(cwd);
      for (const root of roots) {
        const base = await real(root);
        if (target === base || target.startsWith(base.endsWith(sep) ? base : base + sep)) return true;
      }
      return false;
    };
    let count = 0, lastActive: number | undefined;
    for (const row of rows) {
      if (!await within(row.cwd!)) continue;
      count++;
      const at = time(row.updatedAt);
      if (at !== undefined && (lastActive === undefined || at > lastActive)) lastActive = at;
    }
    return { count, ...(lastActive === undefined ? {} : { lastActive }) };
  }
}
