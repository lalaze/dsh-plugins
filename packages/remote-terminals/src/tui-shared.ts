import type { TuiCli } from '@dsh-plugins/remote-core/workspace.js';
import { tuiHolder } from './holder-protocol.js';
import { tuiKey, type TuiDetails, type TuiShared, type TuiStore } from './tui-state.js';
import { COMMAND_VALUE, FIRST_TITLES, MAX_TITLE, OLD_TITLE, type TuiSessions } from './tui.js';

/**
 * TUI conversations in every DSH that uses the same account on a machine. A TUI conversation's CLI runs in a terminal on
 * the machine, and no relay sees it, so the sessions Remote Agents shares never include it: only the DSH that started it
 * knew it existed. Each one is therefore listed in a small file on the machine (see `SHARED_TUI_FOLDER`), and every DSH
 * shows the listed ones it does not have yet as conversations of its own, in the remote workspace of their directory.
 * All of them open the same terminal there, whose holder takes several clients at once: each sees the same screen and
 * may type, and the screen has the size of whichever came or resized last.
 *
 * Archiving and the title follow too. Each DSH remembers what it and the list last agreed on (`TuiDetails.shared`): a
 * difference on its own side is its user's change and goes to the list, a difference in the list is someone else's and
 * is applied here. A conversation archived before it was ever listed stays out of the list, so old ones do not appear
 * elsewhere when this arrives.
 */

/** A TUI conversation as its machine lists it. `key` is its `tuiKey`; `at` is when it was listed. */
export interface SharedTui { v: 1; key: string; cli: TuiCli; thread?: string; cwd: string; title?: string; model?: string; effort?: string; at: string; archived?: boolean }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Longer than any DSH session ID, and short enough for a record to stay within one read of its file. */
const MAX_KEY = 256, MAX_CWD = 1024;
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\0\r\n]/.test(value);

/** One record of the list, or nothing if it is not one this version can show. Its model and effort reach a command line. */
export function sharedTui(value: unknown): SharedTui | undefined {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  if (!record || record.v !== 1 || !text(record.key, MAX_KEY) || !text(record.cwd, MAX_CWD) || !record.cwd.startsWith('/')) return;
  if (record.cli !== 'claude' && record.cli !== 'codex') return;
  if (record.cli === 'codex' && !(typeof record.thread === 'string' && UUID.test(record.thread))) return;
  const choice = (item: unknown) => (text(item, 100) && COMMAND_VALUE.test(item) ? item : undefined);
  const model = choice(record.model), effort = choice(record.effort);
  return {
    v: 1, key: record.key, cli: record.cli, cwd: record.cwd, ...(record.cli === 'codex' ? { thread: record.thread as string } : {}),
    ...(text(record.title, MAX_TITLE) ? { title: record.title } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}),
    at: text(record.at, 40) ? record.at : '', ...(record.archived === true ? { archived: true } : {}),
  };
}
/** The records in what `TuiRemote.sharedTuis` read. A file cut short or written by something else is passed over. */
export function sharedTuis(output: string): SharedTui[] {
  const found = new Map<string, SharedTui>();
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    let record: SharedTui | undefined;
    try { record = sharedTui(JSON.parse(line)); } catch { continue; }
    if (record && !found.has(record.key)) found.set(record.key, record);
  }
  return [...found.values()];
}
/** The file a conversation is listed in, without its extension. */
export const sharedTuiName = (key: string) => tuiHolder(key);

/** A conversation of this DSH: whether it is still new, and its title if DSH told. */
export interface SharedTuiRow { blank: boolean; title?: string }
export interface TuiSharingHost {
  /** The saved machines whose conversations are shared with other DSHes. */
  hosts(): Promise<{ id: string; label: string }[]>;
  /** What `TuiRemote.sharedTuis` reads on a machine. */
  list(hostId: string, signal: AbortSignal): Promise<string>;
  put(hostId: string, name: string, record: string, signal: AbortSignal): Promise<void>;
  /** A conversation's verified machine and directory. */
  target(sessionId: string, signal: AbortSignal): Promise<{ hostId: string; cwd: string }>;
  /** The conversations DSH has archived, or nothing where this DSH does not tell. */
  archived(): readonly string[] | undefined;
  archive(sessionId: string, archived: boolean): Promise<void>;
  rows(): Promise<Map<string, SharedTuiRow>>;
  /** The local folder of the remote workspace for a directory, created when missing. */
  anchor(hostId: string, cwd: string, signal: AbortSignal): Promise<string>;
  /** The DSH workspace for a local folder, added when missing. */
  workspace(path: string): Promise<string>;
  /** Creates the conversation with this ID, or reuses it while blank; DSH answers with the ID it used. */
  create(workspaceId: string, sessionId: string): Promise<string>;
  warn?(message: string): void;
  now?(): number;
}

const EVERY_MS = 30_000, FIRST_MS = 8_000, SOON_MS = 1_500;
/** A machine that cannot be reached, or a conversation that cannot be shown, is tried again after a growing wait. */
const RETRY_MS = 30_000, MAX_RETRY_MS = 30 * 60_000;
/** A conversation's machine and directory are looked up once in a while: they do not change. */
const TARGET_MS = 10 * 60_000;

export class TuiSharing {
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private again = false;
  private readonly abort = new AbortController();
  private readonly retries = new Map<string, { at: number; delay: number }>();
  private readonly targets = new Map<string, { at: number; value?: { hostId: string; cwd: string } }>();
  private warned = false;
  constructor(private readonly store: TuiStore, private readonly tui: TuiSessions, private readonly host: TuiSharingHost) {}
  private now(): number { return this.host.now?.() ?? Date.now(); }
  start(): void { this.schedule(FIRST_MS); }
  close(): void { this.abort.abort(); clearTimeout(this.timer); }
  /** Something changed here, such as a conversation starting: the list hears of it without waiting for the next round. */
  soon(): void { if (!this.abort.signal.aborted) this.schedule(SOON_MS); }
  private schedule(delay: number): void {
    if (this.abort.signal.aborted) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.run().finally(() => this.schedule(EVERY_MS)); }, delay);
    this.timer.unref?.();
  }
  /** One round over the shared machines. Rounds never overlap; one asked for meanwhile follows. */
  run(): Promise<void> {
    if (this.running) { this.again = true; return this.running; }
    const run = this.round().catch(error => this.host.warn?.(`TUI conversations could not be shared: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => { this.running = undefined; if (this.again && !this.abort.signal.aborted) { this.again = false; void this.run(); } });
    return this.running = run;
  }
  private due(id: string): boolean { return (this.retries.get(id)?.at ?? 0) <= this.now(); }
  private failed(id: string): boolean {
    const first = !this.retries.has(id), delay = Math.min((this.retries.get(id)?.delay ?? RETRY_MS / 2) * 2, MAX_RETRY_MS);
    this.retries.set(id, { at: this.now() + delay, delay });
    return first;
  }
  private async round(): Promise<void> {
    const signal = this.abort.signal, archivedIds = this.host.archived();
    if (!archivedIds) {
      // Without it a conversation archived long ago could not be told from one in use, and all would be listed.
      if (!this.warned) { this.warned = true; this.host.warn?.('TUI conversations are not shared with other DSHes: this DSH does not tell which conversations are archived.'); }
      return;
    }
    const hosts = (await this.host.hosts()).filter(host => this.due(`host:${host.id}`));
    const listed = new Map<string, { hostId: string; record: SharedTui }>(), read = new Set<string>();
    for (const host of hosts) {
      if (signal.aborted) return;
      try {
        for (const record of sharedTuis(await this.host.list(host.id, signal))) if (!listed.has(record.key)) listed.set(record.key, { hostId: host.id, record });
        read.add(host.id); this.retries.delete(`host:${host.id}`);
      } catch (error) {
        if (signal.aborted) return;
        if (this.failed(`host:${host.id}`)) this.host.warn?.(`TUI conversations on ${host.label} could not be read: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!read.size) return;
    const state = this.store.snapshot(), archived = new Set(archivedIds), known = new Set<string>();
    let rows: Map<string, SharedTuiRow> | undefined;
    const row = async (sessionId: string) => (rows ??= await this.host.rows()).get(sessionId);
    for (const sessionId of state.tuiSessions ?? []) {
      if (signal.aborted) return;
      const details = state.tuiDetails?.[sessionId], key = tuiKey(sessionId, details), found = listed.get(key);
      known.add(key);
      try {
        if (found) await this.agree(sessionId, details, found, archived.has(sessionId), row, signal);
        else if (!archived.has(sessionId)) await this.publish(sessionId, key, details, read, signal);
      } catch (error) {
        if (signal.aborted) return;
        if (this.failed(`row:${sessionId}`)) this.host.warn?.(`A TUI conversation could not be shared with other DSHes: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    for (const [key, found] of listed) {
      if (signal.aborted) return;
      if (known.has(key) || found.record.archived || !this.due(`key:${key}`)) continue;
      try { await this.adopt(found, row, signal); this.retries.delete(`key:${key}`); }
      catch (error) {
        if (signal.aborted) return;
        if (this.failed(`key:${key}`)) this.host.warn?.(`Could not show the TUI conversation "${found.record.title ?? FIRST_TITLES[found.record.cli]}" here: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  private async save(sessionId: string, shared: TuiShared): Promise<void> {
    await this.store.update(state => { if (state.tuiDetails?.[sessionId] || state.tuiSessions?.includes(sessionId)) state.tuiDetails = { ...state.tuiDetails, [sessionId]: { ...state.tuiDetails?.[sessionId], shared } }; });
  }
  /** Lists a conversation of this DSH, on its machine if that machine was read this round and so is known not to list it. */
  private async publish(sessionId: string, key: string, details: TuiDetails | undefined, read: ReadonlySet<string>, signal: AbortSignal): Promise<void> {
    if (!this.due(`row:${sessionId}`)) return;
    let cached = this.targets.get(sessionId);
    if (!cached || this.now() - cached.at > TARGET_MS) {
      // A conversation whose workspace is gone, or no longer a remote one, has nowhere to be listed.
      cached = { at: this.now(), value: await this.host.target(sessionId, signal).then(({ hostId, cwd }) => ({ hostId, cwd }), () => undefined) };
      this.targets.set(sessionId, cached);
    }
    const target = cached.value;
    if (!target || !read.has(target.hostId)) return;
    const cli: TuiCli = details?.cli ?? 'claude';
    const record = sharedTui({ v: 1, key, cli, thread: details?.thread, cwd: target.cwd, title: details?.title, model: details?.model, effort: details?.effort, at: new Date(this.now()).toISOString() });
    if (!record) return;
    await this.host.put(target.hostId, sharedTuiName(key), JSON.stringify(record), signal);
    await this.save(sessionId, { archived: false, ...(record.title ? { title: record.title } : {}) });
    this.retries.delete(`row:${sessionId}`);
  }
  /** Brings a conversation of this DSH and its record together: whichever side changed since they last agreed wins. */
  private async agree(sessionId: string, details: TuiDetails | undefined, found: { hostId: string; record: SharedTui }, archived: boolean,
    row: (sessionId: string) => Promise<SharedTuiRow | undefined>, signal: AbortSignal): Promise<void> {
    if (!this.due(`row:${sessionId}`)) return;
    const { record, hostId } = found, listedArchived = record.archived === true;
    // With nothing remembered, as after a lost state file, the list is taken as what was agreed.
    const agreed: TuiShared = details?.shared ?? { archived, ...(record.title ? { title: record.title } : {}) };
    const next: TuiShared = { ...agreed }, change: Partial<SharedTui> = {};
    if (archived !== agreed.archived) { next.archived = archived; if (listedArchived !== archived) change.archived = archived; }
    else if (listedArchived !== agreed.archived) { await this.host.archive(sessionId, listedArchived); next.archived = listedArchived; }
    const own = details?.title;
    if (own && own !== agreed.title) { next.title = own; if (record.title !== own) change.title = own; }
    else if (record.title && record.title !== agreed.title) {
      // A conversation renamed in DSH keeps its name, as it does when its own CLI retitles it. Until DSH tells its
      // title there is no knowing, and the next round asks again.
      const shown = (await row(sessionId))?.title;
      if (shown !== undefined) {
        await this.tui.retitle(sessionId, record.title, shown === own || OLD_TITLE.test(shown) || Object.values(FIRST_TITLES).includes(shown));
        next.title = record.title;
      }
    }
    signal.throwIfAborted();
    if (Object.keys(change).length) {
      const { archived: _archived, ...rest } = record;
      await this.host.put(hostId, sharedTuiName(record.key), JSON.stringify({ ...rest, ...(change.title ? { title: change.title } : {}), ...((change.archived ?? listedArchived) ? { archived: true } : {}) }), signal);
    }
    if (!details?.shared || next.archived !== agreed.archived || next.title !== agreed.title) await this.save(sessionId, next);
    this.retries.delete(`row:${sessionId}`);
  }
  /** Shows a listed conversation this DSH does not have, in a conversation of its own in that directory's remote workspace. */
  private async adopt({ hostId, record }: { hostId: string; record: SharedTui }, row: (sessionId: string) => Promise<SharedTuiRow | undefined>, signal: AbortSignal): Promise<void> {
    const path = await this.host.anchor(hostId, record.cwd, signal);
    signal.throwIfAborted();
    const workspaceId = await this.host.workspace(path);
    // The same ID as in the DSH that started it, where DSH allows; an adoption cut short finds its conversation again.
    const existing = await row(record.key);
    const sessionId = existing && !existing.blank ? record.key : await this.host.create(workspaceId, record.key);
    signal.throwIfAborted();
    await this.tui.adopt(sessionId, hostId, record, !(existing && !existing.blank && sessionId === record.key), new Date(this.now()));
  }
}
