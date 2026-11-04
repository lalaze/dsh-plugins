import { createHash } from 'node:crypto';
import { RemoteError } from '../core/domain.js';
import type { Store } from '../core/store.js';

/** The part of a DSH session this needs. */
interface TuiSession { append(type: string, data: unknown): unknown }
interface SessionRow { sessionId: string; blank?: boolean }

/** What a conversation shows until Claude Code has titled it. */
const FIRST_TITLE = 'Claude Code', MAX_TITLE = 120;
/** The title 0.2.81 gave every TUI conversation, which is replaced like the plugin's own. */
const OLD_TITLE = /^Claude TUI \d\d:\d\d$/;
/** Model and effort reach the remote command line inside double quotes. */
const COMMAND_VALUE = /^[\w.:[\]-]+$/;

/** The Claude session of a TUI conversation: the same every launch, so that reopening it resumes. */
export function tuiClaudeSession(sessionId: string): string {
  const hash = createHash('sha256').update(`dsh-tui:${sessionId}`).digest('hex');
  return [hash.slice(0, 8), hash.slice(8, 12), `4${hash.slice(13, 16)}`, `8${hash.slice(17, 20)}`, hash.slice(20, 32)].join('-');
}

/** A title Claude Code recorded in its session file; one the user set with /rename wins over its own. */
export function claudeTitle(records: string): string | undefined {
  let custom: unknown, own: unknown;
  for (const line of records.split('\n')) {
    try {
      const record = JSON.parse(line) as { type?: string; customTitle?: unknown; aiTitle?: unknown };
      if (record.type === 'custom-title') custom = record.customTitle;
      if (record.type === 'ai-title') own = record.aiTitle;
    } catch { /* not a whole record */ }
  }
  const title = typeof custom === 'string' && custom.trim() ? custom : own;
  return typeof title === 'string' ? title.trim().slice(0, MAX_TITLE) || undefined : undefined;
}

/** The Claude model of a chat model route, `<project>/<cli>/<model>`. */
function claudeModel(route: unknown): string | undefined {
  if (typeof route !== 'string') return;
  const [, cli, model] = route.split('/');
  try { return cli === 'claude' && model ? decodeURIComponent(model) : undefined; } catch { return undefined; }
}

/**
 * Conversations whose main view is the interactive Claude Code instead of DSH's chat. Each stays a real DSH session, so
 * it is a row in the workspace list. DSH shows no views in a session until its log has a turn, so starting one records
 * an empty turn. The conversation itself lives in the remote Claude Code; see the Remote Claude launcher in terminal.ts.
 */
export class TuiSessions {
  constructor(private readonly store: Store, private readonly dsh: {
    /** Rejects a conversation that is not a verified remote workspace. */
    verify(sessionId: string, signal: AbortSignal): Promise<unknown>;
    session(sessionId: string): TuiSession | undefined;
    list(): Promise<readonly SessionRow[]>;
    rename(sessionId: string, title: string): Promise<void>;
    /** The title records of a Claude session on the conversation's machine. */
    titleRecords(sessionId: string, claudeSession: string, signal: AbortSignal): Promise<string>;
  }) {}
  list(): string[] { return this.store.snapshot().tuiSessions ?? []; }
  /** @param selection - the composer's model route and effort, which the first launch of Claude Code uses. */
  async start(sessionId: string, selection: { model?: unknown; effort?: unknown }, signal: AbortSignal): Promise<void> {
    await this.dsh.verify(sessionId, signal);
    if (this.list().includes(sessionId)) return;
    const session = this.dsh.session(sessionId);
    if (!session) throw new RemoteError('This conversation is not open', 409);
    // Its turns would stay in DSH while Claude Code started from nothing.
    if ((await this.dsh.list()).find(row => row.sessionId === sessionId)?.blank === false) throw new RemoteError('Only a new conversation can start in the TUI', 409);
    signal.throwIfAborted();
    const model = claudeModel(selection.model), effort = selection.effort;
    await this.store.update(state => {
      state.tuiSessions = [...state.tuiSessions ?? [], sessionId];
      state.tuiDetails = { ...state.tuiDetails, [sessionId]: { title: FIRST_TITLE,
        ...(model && COMMAND_VALUE.test(model) ? { model } : {}), ...(typeof effort === 'string' && COMMAND_VALUE.test(effort) ? { effort } : {}) } };
    });
    session.append('turn/start', { turn: 1 });
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    await this.dsh.rename(sessionId, FIRST_TITLE);
  }
  /**
   * Follow Claude Code's title, until the conversation is renamed in DSH.
   * @param current - the conversation's title in DSH.
   * @returns the new title, if it changed.
   */
  async syncTitle(sessionId: string, current: unknown, signal: AbortSignal): Promise<string | undefined> {
    if (!this.list().includes(sessionId)) return;
    const shown = typeof current === 'string' ? current : undefined, saved = this.store.snapshot().tuiDetails?.[sessionId];
    if (shown !== undefined && shown !== saved?.title && !OLD_TITLE.test(shown)) return;
    await this.dsh.verify(sessionId, signal);
    const title = claudeTitle(await this.dsh.titleRecords(sessionId, tuiClaudeSession(sessionId), signal));
    if (!title || title === shown) return;
    await this.dsh.rename(sessionId, title);
    await this.store.update(state => { state.tuiDetails = { ...state.tuiDetails, [sessionId]: { ...state.tuiDetails?.[sessionId], title } }; });
    return title;
  }
}
