import { realpath } from 'node:fs/promises';
import nodePath from 'node:path';
import { FIELD_LIMIT, GOAL_LIMIT, PARTS, REMOTE_ANCHOR, TITLE_LIMIT, type Change, type Conversations, type GoalRef, type ProjectStatusEntry, type StatusAnswer } from './domain.js';
import { workplace, type RemoteWorktrees, type Workplace } from './git.js';
import { inspect, type Inspection } from './project.js';
import { parseStatus, serializeStatus, shown, tidy, tidyTitle, type ParsedGoal, type ParsedStatus } from './status-file.js';
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

const text = (value: unknown, limit = FIELD_LIMIT): string => {
  if (typeof value !== 'string' || value.length > limit) throw new StatusError('Invalid status');
  return value;
};
const titleOf = (value: unknown): string => {
  const title = tidyTitle(text(value, TITLE_LIMIT));
  if (!title) throw new StatusError('Invalid status');
  return title;
};
const refOf = (value: unknown): GoalRef => {
  const ref = value as { title?: unknown; nth?: unknown } | null;
  if (!ref || typeof ref !== 'object') throw new StatusError('Invalid status');
  const nth = ref.nth ?? 0;
  if (typeof nth !== 'number' || !Number.isInteger(nth) || nth < 0) throw new StatusError('Invalid status');
  return { title: text(ref.title, TITLE_LIMIT), nth };
};
/** What a request asks for, checked; anything else is refused. */
function changeOf(value: unknown): Change {
  const input = value as Record<string, unknown> | null;
  if (!input || typeof input !== 'object') throw new StatusError('Invalid status');
  switch (input.op) {
    case 'aim': return { op: 'aim', value: text(input.value), was: text(input.was) };
    case 'part':
      if (input.part !== 'steps' && !PARTS.includes(input.part as never)) throw new StatusError('Invalid status');
      return { op: 'part', goal: refOf(input.goal), part: input.part as Extract<Change, { op: 'part' }>['part'], value: text(input.value), was: text(input.was) };
    case 'title': return { op: 'title', goal: refOf(input.goal), value: titleOf(input.value) };
    case 'done':
      if (typeof input.value !== 'boolean') throw new StatusError('Invalid status');
      return { op: 'done', goal: refOf(input.goal), value: input.value };
    case 'add': return { op: 'add', title: titleOf(input.title) };
    case 'remove': return { op: 'remove', goal: refOf(input.goal) };
    default: throw new StatusError('Invalid status');
  }
}
const CHANGED = 'The status changed while you were editing';
/** The goal a change names, or -1: the one it was shown as is gone, renamed or removed by someone else. */
const indexOf = (goals: ParsedGoal[], ref: GoalRef): number => goals.map((goal, index) => goal.title === ref.title ? index : -1).filter(index => index >= 0)[ref.nth ?? 0] ?? -1;
/** The status with the change made, or nothing when it already is that way. A text that is no longer what the change began from is a conflict. */
function applied(status: ParsedStatus, change: Change): ParsedStatus | undefined {
  const replaced = (has: string, value: string, was: string): string | undefined => {
    const next = tidy(value);
    if (has === next) return undefined;
    if (has !== tidy(was)) throw new StatusError(CHANGED, 409);
    return next;
  };
  if (change.op === 'aim') {
    const next = replaced(status.aim, change.value, change.was);
    return next === undefined ? undefined : { ...status, aim: next };
  }
  if (change.op === 'add') {
    // Sent twice, it is still one goal.
    if (status.goals.some(goal => goal.title === change.title)) return undefined;
    if (status.goals.length >= GOAL_LIMIT) throw new StatusError('There are too many goals');
    return { ...status, goals: [...status.goals, { title: change.title, done: false, steps: '', progress: '', blockers: '', next: '', rest: [] }] };
  }
  const at = indexOf(status.goals, change.goal);
  if (change.op === 'remove') return at < 0 ? undefined : { ...status, goals: status.goals.filter((_, index) => index !== at) };
  if (at < 0) throw new StatusError(CHANGED, 409);
  const goal = status.goals[at], put = (next: ParsedGoal): ParsedStatus => ({ ...status, goals: status.goals.map((old, index) => index === at ? next : old) });
  if (change.op === 'done') return goal.done === change.value ? undefined : put({ ...goal, done: change.value });
  if (change.op === 'title') return goal.title === change.value ? undefined : put({ ...goal, title: change.value });
  const next = replaced(goal[change.part], change.value, change.was);
  return next === undefined ? undefined : put({ ...goal, [change.part]: next });
}

export class ProjectStatusService {
  private readonly inspections = new Map<string, { at: number; value: Promise<{ place: Workplace; found: Inspection }> }>();
  private readonly now: () => number;
  constructor(private readonly store: StatusStore, private readonly options: ServiceOptions) { this.now = options.now ?? Date.now; }

  /** The status of the project a conversation works in. */
  async get(sessionId: string, signal?: AbortSignal): Promise<StatusAnswer> {
    return this.answer(await this.folderOf(sessionId), signal);
  }

  /**
   * Makes one change to the project's file and leaves the rest of it as it is. The tab saves as the user types and ticks,
   * while agents edit the same file, so what is checked is the one text the change replaces: a change to another goal or
   * another text meanwhile is no conflict.
   * @param language - of the headings, for a file that has none yet.
   */
  async change(sessionId: string, input: unknown, language: unknown, signal?: AbortSignal): Promise<StatusAnswer> {
    const change = changeOf(input);
    const folder = await this.folderOf(sessionId), { found: { project } } = await this.inspected(folder, signal);
    for (let attempt = 0; ; attempt++) {
      const current = await this.store.read(project.id), parsed = parseStatus(current.text), next = applied(parsed, change);
      // Already so: the same change came twice, or someone wrote the same thing.
      if (!next) break;
      const text = serializeStatus(next, language === 'zh' ? 'zh' : 'en', project.name), again = parseStatus(text);
      // A line that reads as a heading would leave its text for a section of its own, and come back with every save.
      if (JSON.stringify([again.aim, again.goals]) !== JSON.stringify([next.aim, next.goals])) throw new StatusError('A line that starts with # would begin another section');
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
    const { project, aim, goals, updatedAt } = await this.answer(folder, signal);
    return { project, aim, goals, ...(updatedAt === undefined ? {} : { updatedAt }) };
  }

  /** For other plugins: every project that has been opened in the tab, with what its file says now. */
  async list(): Promise<ProjectStatusEntry[]> {
    const entries: ProjectStatusEntry[] = [];
    for (const project of await this.store.projects()) {
      const stored = await this.store.read(project.id).catch(() => undefined);
      if (!stored) continue;
      const parsed = parseStatus(stored.text);
      entries.push({ project, aim: parsed.aim, goals: parsed.goals.map(shown), ...(stored.updatedAt === undefined ? {} : { updatedAt: stored.updatedAt }) });
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
      project, aim: parsed.aim, goals: parsed.goals.map(shown), more: parsed.extra.length > 0, revision: stored.revision,
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
