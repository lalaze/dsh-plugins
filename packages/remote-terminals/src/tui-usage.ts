import { randomUUID } from 'node:crypto';
import type { TurnUsage } from '@dsh-plugins/remote-core/domain.js';
import { tuiKey, type TuiDetails, type TuiStore } from './tui-state.js';
import { claudeTurnUsage, codexTurnUsage, type RemoteUsageRecord } from '@dsh-plugins/remote-core/usage.js';
import type { TuiCli } from '@dsh-plugins/remote-core/workspace.js';
import { tuiClaudeSession } from './tui.js';

/**
 * Usage of TUI conversations. Their CLI runs in a terminal, so no turn passes through the relay that counts a chat's
 * usage; each CLI logs what every request used, and that log is read instead. Claude Code writes the API's usage on each
 * reply line (several lines per request, one per part of the reply) and `system/turn_duration` when a turn ends, or,
 * for a turn stopped with Esc during a reply or a tool, a user line `[Request interrupted by user…]` naming the
 * interrupted request in `interruptedMessageId` (a reply cut off keeps only the usage it started with); its
 * subagents log to `<session>/subagents/agent-*.jsonl`. Codex reports its running totals in `token_count` events and
 * ends a turn with `task_complete` or `turn_aborted`; its subagents, such as the reviewer of approval requests, run in
 * threads of their own that name their parent in their first line, each with its own totals and turns. Subagents' usage
 * counts toward the conversation's turn running at the time, under their own model. Each finished turn becomes one
 * record per model, as a chat's does.
 */

/** Bytes of one file read in one go; the rest follows straight after. */
export const TUI_USAGE_CAP = 16 * 1024 * 1024;
/** Claude Code's subagent logs, which share the conversation's turns. */
export const TUI_SUBAGENT_FILE = /^agent-[\w-]+\.jsonl$/;
/** A Codex subagent's thread, by its ID, as the cursor and the reads name it. */
export const TUI_CODEX_CHILD = /^thread-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
/**
 * A CLI's log to read: its Claude session or Codex thread, and the bytes of each file already read. A Codex thread's
 * subagent threads are looked for among the files changed in the last `since` minutes, or among all when it is absent.
 */
export interface TuiUsageEntry { cli: TuiCli; id: string; read: Record<string, number>; since?: number }
/**
 * A turn that ends without any marker, as when its CLI is killed, counts once its log has been quiet this long. A later
 * prompt would otherwise take its usage into the next turn, or nothing would ever count it.
 */
export const QUIET_MS = 30 * 60_000;
/** A sweep of every TUI conversation catches turns run while nothing watched, as with DSH closed. */
const SWEEP_MS = 10 * 60_000, FIRST_SWEEP_MS = 20_000;
/** A turn the activity watcher saw end is read once its CLI has had time to log the end. */
const FINISHED_MS = 4_000;
/** A long log is read in parts; this many in a row before the next sweep takes over. */
const MAX_ROUNDS = 8;
/**
 * How often the time Codex subagent threads were last looked for moves on; the search covers the files changed since,
 * plus a margin. Moving it on every read would rewrite the state every few minutes for nothing.
 */
const SCAN_STEP_MS = 60 * 60_000, SCAN_MARGIN_MINUTES = 10;

/** Where reading a conversation's log got to, so that every turn is counted once. Kept in `TuiDetails.usage`. */
export interface TuiUsageCursor {
  /** Bytes read of each file: `main` and, for Claude Code, its subagents' files by name. */
  read: Record<string, number>;
  /** Claude Code: the request last read in each file and what of it is counted, as its lines may come in two reads. */
  requests?: Record<string, { id: string; usage: TurnUsage }>;
  /** The turn that was still running at the last read, by model; `seen` is when its log last said anything. */
  open?: { startedAt: string; seen: string; models: Record<string, TurnUsage> };
  /** Codex: its running totals when its last turn ended and as last reported, and the model of the running turn. */
  codexEnded?: Record<string, number>;
  codexLatest?: Record<string, number>;
  model?: string;
  /** Codex: the same for each subagent thread, by ID. */
  codexChildren?: Record<string, { ended?: Record<string, number>; latest?: Record<string, number>; model?: string }>;
  /** Codex: when subagent threads were last looked for. */
  scannedAt?: string;
}
/** A finished turn: when it started, how long it ran and what each model used. */
export interface TuiTurn { startedAt: string; durationMs: number; models: { model: string; usage: TurnUsage }[] }
/** What one read returned for a file. */
export interface TuiUsageChunk { file: string; from: number; end: number; capped: boolean; lines: string[] }

const USAGE_KEYS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens'] as const;
const used = (usage: TurnUsage) => USAGE_KEYS.some(key => (usage[key] ?? 0) > 0);
function add(into: TurnUsage | undefined, usage: TurnUsage): TurnUsage {
  const sum: TurnUsage = { inputTokens: 0, outputTokens: 0, ...into };
  for (const key of USAGE_KEYS) if (usage[key]) sum[key] = (sum[key] ?? 0) + usage[key]!;
  return sum;
}
/** What `now` adds to `counted`, a part of the same request already read. */
function beyond(now: TurnUsage, counted: TurnUsage): TurnUsage {
  const extra: TurnUsage = { inputTokens: 0, outputTokens: 0 };
  for (const key of USAGE_KEYS) { const value = Math.max(0, (now[key] ?? 0) - (counted[key] ?? 0)); if (value) extra[key] = value; }
  return extra;
}
function most(a: TurnUsage, b: TurnUsage): TurnUsage {
  const top: TurnUsage = { inputTokens: 0, outputTokens: 0 };
  for (const key of USAGE_KEYS) { const value = Math.max(a[key] ?? 0, b[key] ?? 0); if (value) top[key] = value; }
  return top;
}
const time = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : undefined;

/** Splits a read into its files, per entry; `more` says a file has more than one read gave. */
export function tuiUsageChunks(output: string): { entries: Map<number, TuiUsageChunk[]>; more: boolean } {
  const entries = new Map<number, TuiUsageChunk[]>();
  let current: TuiUsageChunk | undefined, more = false;
  for (const line of output.split('\n')) {
    const header = /^@ (\d+) (\d+) (\d+) ([01]) (\S+)$/.exec(line);
    if (header) {
      const [, entry, from, end, capped, file] = header;
      current = { file, from: Number(from), end: Number(end), capped: capped === '1', lines: [] };
      if (current.capped) more = true;
      if (file !== 'main' && !TUI_SUBAGENT_FILE.test(file) && !TUI_CODEX_CHILD.test(file)) { current = undefined; continue; }
      entries.set(Number(entry), [...entries.get(Number(entry)) ?? [], current]);
    } else if (current && line.startsWith('{')) current.lines.push(line);
  }
  return { entries, more };
}

interface Event { at: number; order: number; stamp: string; request?: { file: string; id: string; model: string; usage: TurnUsage }; end?: { durationMs?: number } }
/** @param at - when the turn was seen to end, if its log says no duration. */
function finish(open: NonNullable<TuiUsageCursor['open']>, durationMs?: number, at?: string): TuiTurn | undefined {
  const models = Object.entries(open.models).filter(([, usage]) => used(usage)).map(([model, usage]) => ({ model, usage }));
  if (!models.length) return undefined;
  const span = Math.max(0, Math.max(Date.parse(open.seen), Date.parse(at ?? open.seen)) - Date.parse(open.startedAt));
  return { startedAt: open.startedAt, durationMs: typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : span, models };
}
/** Whether a file was read from the start again, being shorter than what was read of it before. */
const anew = (cursor: TuiUsageCursor, chunk: TuiUsageChunk) => chunk.from < (cursor.read[chunk.file] ?? 0);
/** Whether the open turn has been quiet so long that it is taken to have ended. */
const quiet = (cursor: TuiUsageCursor, main: readonly TuiUsageChunk[], now: number) =>
  !!cursor.open && !main.some(chunk => chunk.end > chunk.from) && now - Date.parse(cursor.open.seen) >= QUIET_MS;

/** Claude Code's finished turns in what was read, and where reading got to. */
export function readClaudeUsage(previous: TuiUsageCursor | undefined, chunks: readonly TuiUsageChunk[], now = Date.now()): { cursor: TuiUsageCursor; turns: TuiTurn[] } {
  const cursor: TuiUsageCursor = structuredClone(previous ?? { read: {} }), turns: TuiTurn[] = [];
  // A file read anew loses what was known of its last request.
  for (const chunk of chunks) if (anew(cursor, chunk) && cursor.requests) delete cursor.requests[chunk.file];
  const events: Event[] = [];
  let order = 0;
  for (const chunk of chunks) {
    let last = cursor.open?.seen ?? new Date(now).toISOString();
    for (const line of chunk.lines) {
      let record: any;
      try { record = JSON.parse(line); } catch { continue; }
      const at = time(record?.timestamp) ?? last; last = at;
      if (record?.type === 'assistant') {
        const message = record.message, usage = claudeTurnUsage(message?.usage);
        // Claude's own notices, such as API errors, are `<synthetic>` and use nothing.
        if (!usage || typeof message.id !== 'string' || typeof message.model !== 'string' || !message.model || message.model.startsWith('<')) continue;
        events.push({ at: Date.parse(at), order: order++, stamp: at, request: { file: chunk.file, id: message.id, model: message.model, usage } });
      } else if (record?.type === 'system' && record.subtype === 'turn_duration' && chunk.file === 'main') {
        events.push({ at: Date.parse(at), order: order++, stamp: at, end: { durationMs: record.durationMs } });
      } else if (record?.type === 'user' && typeof record.interruptedMessageId === 'string' && record.isSidechain !== true && chunk.file === 'main') {
        // Stopped with Esc: Claude Code logs no duration then, and the next prompt starts a turn of its own.
        events.push({ at: Date.parse(at), order: order++, stamp: at, end: {} });
      }
    }
  }
  // Subagents work within their conversation's turns: in time order, each request falls in the turn running then.
  events.sort((a, b) => a.at - b.at || a.order - b.order);
  for (const event of events) {
    if (event.request) {
      const { file, id, model, usage } = event.request, before = cursor.requests?.[file];
      const counted = before?.id === id ? before.usage : undefined, extra = counted ? beyond(usage, counted) : usage;
      cursor.requests = { ...cursor.requests, [file]: { id, usage: counted ? most(counted, usage) : usage } };
      if (!used(extra)) continue;
      cursor.open ??= { startedAt: event.stamp, seen: event.stamp, models: {} };
      cursor.open.models[model] = add(cursor.open.models[model], extra);
      if (event.stamp > cursor.open.seen) cursor.open.seen = event.stamp;
    } else if (cursor.open) {
      const turn = finish(cursor.open, event.end?.durationMs, event.stamp);
      if (turn) turns.push(turn);
      delete cursor.open;
    }
  }
  for (const chunk of chunks) cursor.read[chunk.file] = chunk.end;
  if (cursor.open && quiet(cursor, chunks.filter(chunk => chunk.file === 'main'), now)) {
    const turn = finish(cursor.open);
    if (turn) turns.push(turn);
    delete cursor.open;
  }
  return { cursor, turns };
}

/** Codex's running totals, as `codexTurnUsage` reads them. */
function codexTotals(value: any): Record<string, number> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const totals = Object.fromEntries(Object.entries(value).filter(([, count]) => typeof count === 'number' && Number.isFinite(count) && count >= 0)) as Record<string, number>;
  return Object.keys(totals).length ? totals : undefined;
}
/**
 * Codex's finished turns in what was read, and where reading got to. The conversation's thread and its subagents' are
 * read in time order, so that a subagent's turn falls in the conversation's turn running then.
 */
export function readCodexUsage(previous: TuiUsageCursor | undefined, chunks: readonly TuiUsageChunk[], fallbackModel: string, now = Date.now()): { cursor: TuiUsageCursor; turns: TuiTurn[] } {
  const cursor: TuiUsageCursor = structuredClone(previous ?? { read: {} }), turns: TuiTurn[] = [];
  const events: { at: number; order: number; stamp: string; child?: string; record: any }[] = [];
  let order = 0;
  for (const chunk of chunks) {
    const child = TUI_CODEX_CHILD.exec(chunk.file)?.[1];
    if (chunk.file !== 'main' && !child) continue;
    // A log written anew starts its totals over.
    if (anew(cursor, chunk)) {
      if (child) delete cursor.codexChildren?.[child];
      else { delete cursor.codexEnded; delete cursor.codexLatest; delete cursor.open; }
    }
    let last = cursor.open?.seen ?? new Date(now).toISOString();
    for (const line of chunk.lines) {
      let record: any;
      try { record = JSON.parse(line); } catch { continue; }
      const stamp = time(record?.timestamp) ?? last; last = stamp;
      events.push({ at: Date.parse(stamp), order: order++, stamp, ...(child ? { child } : {}), record });
    }
    cursor.read[chunk.file] = chunk.end;
  }
  events.sort((a, b) => a.at - b.at || a.order - b.order);
  for (const { stamp: at, child, record } of events) {
    const payload = record?.payload, type = record?.type === 'event_msg' ? payload?.type : record?.type;
    const thread = child ? ((cursor.codexChildren ??= {})[child] ??= {}) : undefined;
    if (type === 'turn_context') {
      if (typeof payload?.model === 'string' && payload.model) { if (thread) thread.model = payload.model; else cursor.model = payload.model; }
    } else if (type === 'token_count') {
      const total = codexTotals(payload.info?.total_token_usage);
      if (!total) continue;
      if (thread) { thread.latest = total; continue; }
      cursor.codexLatest = total;
      cursor.open ??= { startedAt: at, seen: at, models: {} };
      if (at > cursor.open.seen) cursor.open.seen = at;
    } else if (type === 'task_complete' || type === 'turn_aborted') {
      if (!thread) { end(at); continue; }
      // A subagent's turn: what its own totals grew by joins the conversation's turn.
      const usage = thread.latest && codexTurnUsage(thread.latest, thread.ended);
      if (thread.latest) thread.ended = thread.latest;
      if (!usage) continue;
      const model = thread.model ?? fallbackModel;
      cursor.open ??= { startedAt: at, seen: at, models: {} };
      cursor.open.models[model] = add(cursor.open.models[model], usage);
      if (at > cursor.open.seen) cursor.open.seen = at;
    } else if (type === 'task_started' && !thread) {
      // Subagent usage taken in while no turn ran belongs to this one.
      cursor.open = { startedAt: at, seen: at, models: cursor.open?.models ?? {} };
    }
  }
  // A turn left open this long is ended by the totals so far.
  if (cursor.open && quiet(cursor, chunks.filter(chunk => chunk.file === 'main'), now)) end(cursor.open.seen);
  return { cursor, turns };
  /** The conversation's turn ends: it used what its totals grew by since the last one ended, and its subagents' share. */
  function end(at: string) {
    const models = { ...cursor.open?.models }, usage = cursor.codexLatest && codexTurnUsage(cursor.codexLatest, cursor.codexEnded);
    const startedAt = cursor.open?.startedAt ?? at, model = cursor.model ?? fallbackModel;
    if (usage) models[model] = add(models[model], usage);
    const shares = Object.entries(models).filter(([, share]) => used(share)).map(([name, share]) => ({ model: name, usage: share }));
    if (shares.length) turns.push({ startedAt, durationMs: Math.max(0, Date.parse(at) - Date.parse(startedAt)), models: shares });
    if (cursor.codexLatest) cursor.codexEnded = cursor.codexLatest;
    delete cursor.open;
  }
}

/** A turn's records in dsh-usage-stats' shape: a conversation's, on the machine and in the directory it ran in. */
export function tuiUsageRecords(turn: TuiTurn, context: { cli: TuiCli; sessionId: string; host?: string; workspace: string }): RemoteUsageRecord[] {
  return turn.models.map(({ model, usage }) => ({
    id: randomUUID(), startedAt: turn.startedAt, provider: `remote-cli-${context.cli}`, model, sessionId: context.sessionId,
    purpose: 'conversation', status: 'completed', durationMs: turn.durationMs, usage,
    ...(context.host ? { host: context.host } : {}), workspace: context.workspace,
  }));
}

interface Target { hostId: string; label: string; cwd: string }
/**
 * Reads TUI conversations' logs: every few minutes, and soon after the activity watcher sees a turn end. Reads of one
 * machine go together over its connection. Where reading got to is saved before the records are sent, so a failure can
 * lose a turn but never count one twice.
 */
export class TuiUsage {
  private chain: Promise<void> = Promise.resolve();
  private readonly due = new Set<string>();
  private timers: ReturnType<typeof setTimeout>[] = [];
  private soon?: ReturnType<typeof setTimeout>;
  private closed = false;
  private readonly abort = new AbortController();
  constructor(private readonly store: Pick<TuiStore, 'snapshot' | 'update'>, private readonly deps: {
    /** The conversation's verified machine and remote directory. */
    target(sessionId: string, signal: AbortSignal): Promise<Target>;
    /** Runs one read on a machine, once every conversation in it is verified again. */
    read(hostId: string, sessions: readonly { sessionId: string; target: Target }[], entries: readonly TuiUsageEntry[], signal: AbortSignal): Promise<Buffer | string>;
    emit(record: RemoteUsageRecord): void;
    warn?(message: string): void;
    now?(): number;
  }) {}
  start(): void {
    const sweep = () => { void this.sweep(); };
    this.timers.push(setTimeout(sweep, FIRST_SWEEP_MS), setInterval(sweep, SWEEP_MS) as unknown as ReturnType<typeof setTimeout>);
    for (const timer of this.timers) (timer as { unref?(): void }).unref?.();
  }
  close(): void {
    this.closed = true; this.abort.abort();
    for (const timer of this.timers) clearInterval(timer);
    if (this.soon) clearTimeout(this.soon);
  }
  /** A TUI conversation's turn ended. */
  finished(sessionId: string): void {
    if (this.closed || !(this.store.snapshot().tuiSessions ?? []).includes(sessionId)) return;
    this.due.add(sessionId);
    if (this.soon) clearTimeout(this.soon);
    this.soon = setTimeout(() => { this.soon = undefined; const ids = [...this.due]; this.due.clear(); void this.sweep(ids); }, FINISHED_MS);
    (this.soon as { unref?(): void }).unref?.();
  }
  /** Reads the given TUI conversations, or all of them. One read runs at a time. */
  sweep(only?: readonly string[]): Promise<void> {
    const run = this.chain.then(() => this.read(only)).catch(error => this.deps.warn?.(`TUI usage could not be read: ${error instanceof Error ? error.message : String(error)}`));
    this.chain = run;
    return run;
  }
  private async read(only?: readonly string[]): Promise<void> {
    if (this.closed) return;
    const signal = this.abort.signal, listed = this.store.snapshot().tuiSessions ?? [];
    const ids = only ? listed.filter(id => only.includes(id)) : listed;
    const machines = new Map<string, { sessionId: string; target: Target }[]>();
    for (const sessionId of ids) {
      // A conversation that is gone, or whose workspace is no longer a verified remote one, is passed over.
      const target = await this.deps.target(sessionId, signal).catch(() => undefined);
      if (!target) continue;
      machines.set(target.hostId, [...machines.get(target.hostId) ?? [], { sessionId, target }]);
    }
    for (const [hostId, sessions] of machines) {
      for (let round = 0; round < MAX_ROUNDS && !this.closed; round++) {
        let more: boolean;
        try { more = await this.readMachine(hostId, sessions, signal); }
        catch (error) {
          if (!this.closed) this.deps.warn?.(`TUI usage on ${sessions[0].target.label} could not be read: ${error instanceof Error ? error.message : String(error)}`);
          break;
        }
        if (!more) break;
      }
    }
  }
  /** @returns whether a log has more to read. */
  private async readMachine(hostId: string, sessions: readonly { sessionId: string; target: Target }[], signal: AbortSignal): Promise<boolean> {
    const details = this.store.snapshot().tuiDetails ?? {}, started = this.deps.now?.() ?? Date.now();
    const entries: TuiUsageEntry[] = sessions.map(({ sessionId }) => {
      const saved = details[sessionId], read = saved?.usage?.read ?? {};
      if (saved?.cli !== 'codex') return { cli: 'claude', id: tuiClaudeSession(tuiKey(sessionId, saved)), read };
      const scanned = Date.parse(saved.usage?.scannedAt ?? '');
      return { cli: 'codex', id: saved.thread ?? '', read, ...(Number.isFinite(scanned) ? { since: Math.max(0, Math.ceil((started - scanned) / 60_000)) + SCAN_MARGIN_MINUTES } : {}) };
    });
    const output = await this.deps.read(hostId, sessions, entries, signal);
    if (this.closed) return false;
    let { entries: files, more } = tuiUsageChunks(output.toString());
    const now = this.deps.now?.() ?? Date.now(), results: { sessionId: string; target: Target; cli: TuiCli; cursor: TuiUsageCursor; turns: TuiTurn[] }[] = [];
    sessions.forEach(({ sessionId, target }, index) => {
      const chunks = files.get(index);
      const saved: TuiDetails | undefined = details[sessionId], entry = entries[index];
      if (!chunks?.length && !saved?.usage?.open) return;
      const { cursor, turns } = entry.cli === 'codex' ? readCodexUsage(saved?.usage, chunks ?? [], saved?.model ?? 'default', now) : readClaudeUsage(saved?.usage, chunks ?? [], now);
      if (entry.cli === 'codex' && chunks?.some(chunk => chunk.file === 'main')) {
        // Subagent threads found just now are looked for again with them as parents, for subagents of their own;
        // otherwise the search is done up to the time this read began.
        const found = Object.keys(cursor.read).some(name => TUI_CODEX_CHILD.test(name) && !(name in (saved?.usage?.read ?? {})));
        if (found) more = true;
        else if (!cursor.scannedAt || started - Date.parse(cursor.scannedAt) >= SCAN_STEP_MS) cursor.scannedAt = new Date(started).toISOString();
      }
      if (JSON.stringify(cursor) !== JSON.stringify(saved?.usage ?? { read: {} })) results.push({ sessionId, target, cli: entry.cli, cursor, turns });
    });
    if (!results.length) return more;
    await this.store.update(state => {
      for (const { sessionId, cursor } of results) {
        // A conversation removed meanwhile keeps no cursor.
        if (!(state.tuiSessions ?? []).includes(sessionId)) continue;
        state.tuiDetails = { ...state.tuiDetails, [sessionId]: { ...state.tuiDetails?.[sessionId], usage: cursor } };
      }
    });
    for (const { sessionId, target, cli, turns } of results) {
      // A conversation another DSH started had its earlier turns counted there.
      const from = Date.parse(details[sessionId]?.usageFrom ?? '');
      for (const turn of turns) {
        if (Number.isFinite(from) && Date.parse(turn.startedAt) + turn.durationMs < from) continue;
        for (const record of tuiUsageRecords(turn, { cli, sessionId, host: target.label, workspace: target.cwd })) this.deps.emit(record);
      }
    }
    return more;
  }
}
