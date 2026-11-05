import type { Context } from '@deepseek-ai/cordis';
import type { Store } from '../core/store.js';
import { TUI_LAUNCHERS } from './domain.js';

/** What a TUI conversation's CLI is doing. Approval and question are the kinds DSH's sidebar shows as waiting on the user. */
export type TuiActivity = 'idle' | 'running' | 'approval' | 'question';

/** The part of DSH's terminal screen (@xterm/headless) this reads. */
interface WatchedScreen {
  readonly rows: number;
  buffer: { active: { viewportY: number; getLine(y: number): { translateToString(trimRight?: boolean): string } | undefined } };
  onTitleChange(listener: (title: string) => void): { dispose(): void };
  parser: { registerOscHandler(code: number, handler: (data: string) => boolean): { dispose(): void } };
}
export interface WatchedTerminal { info: { state?: string; shell?: { name?: string } }; screen: WatchedScreen }

/** The status report Codex sends. Claude Code sends one too, but only once the terminal answers its query in a form it keeps to itself. */
const STATUS_REPORT = 7501;
/** Often enough to feel live; it only reads memory in this process, as the CLI's output reaches DSH anyway. */
const CHECK_MS = 1000;
/** A CLI can rest for a moment between two steps of a turn, which must not read as finished. */
const REST_MS = 2000;
/**
 * How often a busy conversation says so again. DSH runs turns of its own in a conversation that leads a team, and the end of
 * one reports it stopped, whatever its CLI is doing.
 */
const REPEAT_MS = 5000;
/** Codex reports working for a few seconds as it starts, with nothing asked of it. Leaving the row by then would read as a finished task. */
const START_MS = 8000;

/**
 * What a CLI's terminal title says, the one signal both keep up without any setup or extra connection. Measured on Claude
 * Code 2.1.318 (`✳ title` at rest, `◐ title` at work) and Codex 0.166 (`folder`, `⠙ folder`, `[ ! ] Action Required | …`).
 */
export function titleActivity(title: string): 'idle' | 'running' | 'approval' {
  if (/^\[ [!.] \] Action Required\b/.test(title)) return 'approval';
  return /^[^\p{L}\p{N}\s[✳]\s/u.test(title) ? 'running' : 'idle';
}

/**
 * What a status report such as `state=blocked:app=codex:kind=permission` says, if it says anything. Codex 0.166 sends idle,
 * working, blocked and, for a finished turn, done. Any other state counts as rest: a stale running row never clears, while
 * a wrong rest clears at its next report.
 */
export function reportActivity(report: string): TuiActivity | undefined {
  const fields = new Map(report.split(':').map(field => field.split('=', 2) as [string, string | undefined]));
  const state = fields.get('state');
  if (state === undefined) return undefined;
  if (state === 'working') return 'running';
  if (state === 'blocked') return fields.get('kind') === 'permission' ? 'approval' : 'question';
  return 'idle';
}

/**
 * The dialog on Claude Code's screen, whose title reads at rest while one waits. The prompt mark sits on the highlighted
 * choice then and the prompt itself is gone, so the last mark on the screen tells them apart: on a numbered choice, or
 * above a line offering to cancel (the folder trust dialog numbers nothing).
 */
export function dialogOnScreen(rows: readonly string[]): 'approval' | 'question' | undefined {
  const mark = rows.findLastIndex(row => /^\s*❯/.test(row));
  if (mark < 0 || !(/^\s*❯ \d+\. /.test(rows[mark]) || rows.slice(mark + 1).some(row => /\bEsc to cancel\b/i.test(row)))) return undefined;
  // What it asks stands right above its choices; further up is only the conversation.
  return rows.slice(Math.max(0, mark - 6), mark).some(row => /\b(Do|Would) you (want|like)\b/.test(row)) ? 'approval' : 'question';
}

const screenRows = ({ rows, buffer: { active } }: WatchedScreen): string[] =>
  Array.from({ length: rows }, (_, row) => active.getLine(active.viewportY + row)?.translateToString(true) ?? '');

interface Watch { terminal: WatchedTerminal; dispose(): void; title: string; report?: TuiActivity; shown: TuiActivity; started: number; restSince?: number; reported?: number }

/**
 * Watches TUI conversations' CLIs, so that they show as running, waiting and finished like every other conversation. DSH
 * runs no turn for these: their work happens in a terminal it knows nothing about, and it would list them as idle for good.
 */
export class TuiActivityWatcher {
  private readonly watches = new Map<string, Watch>();
  constructor(private readonly deps: {
    /** The TUI conversations. */
    sessions(): readonly string[];
    /** A conversation's open terminals. */
    terminals(sessionId: string): Iterable<WatchedTerminal>;
    /** Tell DSH's clients a conversation started or stopped running. */
    emit(sessionId: string, running: boolean): void;
    now?(): number;
  }) {}
  /** Whether the conversation counts as running: DSH's own approvals count too, so a finish is only reported after them. */
  isBusy(sessionId: string): boolean {
    const shown = this.watches.get(sessionId)?.shown;
    return shown !== undefined && shown !== 'idle';
  }
  /** The conversations waiting on the user, by what they wait for. */
  waiting(): Record<string, 'approval' | 'question'> {
    const waiting: Record<string, 'approval' | 'question'> = {};
    for (const [sessionId, { shown }] of this.watches) if (shown === 'approval' || shown === 'question') waiting[sessionId] = shown;
    return waiting;
  }
  check(): void {
    const sessions = new Set(this.deps.sessions());
    for (const sessionId of this.watches.keys()) if (!sessions.has(sessionId)) this.stop(sessionId);
    for (const sessionId of sessions) {
      const terminal = this.cliTerminal(sessionId);
      let watch = this.watches.get(sessionId);
      if (watch && watch.terminal !== terminal) { this.stop(sessionId); watch = undefined; }
      if (!terminal) continue;
      watch ??= this.start(sessionId, terminal);
      this.update(sessionId, watch);
    }
  }
  close(): void { for (const sessionId of [...this.watches.keys()]) this.stop(sessionId); }

  /** The conversation's running terminal started from its CLI's launcher, as it may have others open. */
  private cliTerminal(sessionId: string): WatchedTerminal | undefined {
    const launchers = Object.values(TUI_LAUNCHERS);
    for (const terminal of this.deps.terminals(sessionId)) {
      if (terminal.info.state === 'running' && launchers.includes(terminal.info.shell?.name?.replace(/\.cmd$/i, '') ?? '')) return terminal;
    }
    return undefined;
  }
  private start(sessionId: string, terminal: WatchedTerminal): Watch {
    const watch: Watch = { terminal, dispose: () => {}, title: '', shown: 'idle', started: this.deps.now?.() ?? Date.now() };
    const title = terminal.screen.onTitleChange((text) => { watch.title = text; });
    // Only reads it: xterm passes it on to any other handler, and the terminal behaves as before.
    const report = terminal.screen.parser.registerOscHandler(STATUS_REPORT, (data) => {
      // On exit Codex takes its report back, leaving the shell after it to the title.
      watch.report = data.startsWith('state=clear') ? undefined : reportActivity(data) ?? watch.report;
      return false;
    });
    watch.dispose = () => { title.dispose(); report.dispose(); };
    this.watches.set(sessionId, watch);
    return watch;
  }
  private stop(sessionId: string): void {
    const watch = this.watches.get(sessionId);
    if (!watch) return;
    watch.dispose();
    this.watches.delete(sessionId);
    // Its CLI is gone, so nothing can bring this run back: no need to wait for it to last.
    if (watch.shown !== 'idle') this.deps.emit(sessionId, false);
  }
  private update(sessionId: string, watch: Watch): void {
    const now = this.deps.now?.() ?? Date.now();
    let next: TuiActivity = watch.report ?? titleActivity(watch.title);
    if (next === 'idle' && watch.report === undefined) next = dialogOnScreen(screenRows(watch.terminal.screen)) ?? 'idle';
    if (next === 'running' && watch.shown === 'idle' && now - watch.started < START_MS) return;
    if (next !== 'idle') watch.restSince = undefined;
    else if (watch.shown !== 'idle') {
      watch.restSince ??= now;
      if (now - watch.restSince < REST_MS) return;
    }
    const wasBusy = watch.shown !== 'idle', busy = next !== 'idle';
    watch.shown = next;
    if (wasBusy === busy && !(busy && now - (watch.reported ?? 0) >= REPEAT_MS)) return;
    watch.reported = now;
    this.deps.emit(sessionId, busy);
  }
}

/** The parts of DSH's services this reaches into. It offers neither a view of a terminal's output nor a way to add to a conversation's running state. */
interface DshTerminals { owners?: Map<string, { terminals: Map<string, WatchedTerminal> }> }
interface DshSessionList { summaryFor?(session: unknown): { sessionId: string; running: boolean } }

/** Report TUI conversations' activity: running through DSH's own status event and list, waiting over a route of its own. */
export function installTuiActivity(ctx: Context, store: Pick<Store, 'snapshot'>): void {
  const scopedCtx = ctx as unknown as {
    inject(services: string[], factory: (scoped: { get(name: string): unknown; effect(factory: () => () => void): void }) => void): unknown;
    emit(event: string, ...args: unknown[]): void;
  };
  let watcher: TuiActivityWatcher | undefined;
  scopedCtx.inject(['terminalController', 'sessionController'], (scoped) => {
    const terminals = scoped.get('terminalController') as DshTerminals | undefined;
    const list = (scoped.get('sessionController') as { listState?: DshSessionList } | undefined)?.listState;
    const active = new TuiActivityWatcher({
      sessions: () => store.snapshot().tuiSessions ?? [],
      terminals: id => terminals?.owners?.get(id)?.terminals.values() ?? [],
      emit: (id, running) => scopedCtx.emit('api-session/status', id, running),
    });
    scoped.effect(() => {
      watcher = active;
      const timer = setInterval(() => active.check(), CHECK_MS);
      timer.unref?.();
      // DSH builds a conversation's row from its agent, which a TUI's never runs: a client reloading mid-turn or a row
      // republished for any other reason would otherwise say it stopped.
      const summaryFor = list?.summaryFor;
      if (list && summaryFor) list.summaryFor = session => {
        const summary = summaryFor.call(list, session);
        return active.isBusy(summary.sessionId) ? { ...summary, running: true } : summary;
      };
      return () => {
        clearInterval(timer);
        if (list && summaryFor) list.summaryFor = summaryFor;
        active.close();
        if (watcher === active) watcher = undefined;
      };
    });
  });
  (ctx as unknown as { connection: { fetch: { register(route: unknown): void } } }).connection.fetch.register({
    path: '/api/remote-agents/tui-activity', methods: ['GET'], requestBody: 'buffered',
    fetch: () => new Response(JSON.stringify({ waiting: watcher?.waiting() ?? {} }), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }),
  });
}
