import { createHash } from 'node:crypto';
import { RemoteError } from '@dsh-plugins/remote-core/domain.js';
import type { Store } from '../core/store.js';
import type { TuiCli } from './domain.js';
import { tuiHolder } from './holder-protocol.js';

/** The part of a DSH session this needs. */
interface TuiSession { append(type: string, data: unknown): unknown }
/** The part of DSH's agent loop that numbers turns. */
interface TuiAgent { phase?: { kind?: string; lastTurn?: number } }
interface SessionRow { sessionId: string; blank?: boolean }

/** What a conversation shows until its CLI has titled it. */
const FIRST_TITLES: Record<TuiCli, string> = { claude: 'Claude Code', codex: 'Codex' };
const MAX_TITLE = 120, MAX_PROMPT_TITLE = 80;
/** The title 0.2.81 gave every TUI conversation, which is replaced like the plugin's own. */
const OLD_TITLE = /^Claude TUI \d\d:\d\d$/;
/** Model and effort reach the remote command line inside double quotes. */
const COMMAND_VALUE = /^[\w.:[\]-]+$/;
/** The chat provider of each remote CLI. */
const PROVIDERS: Record<TuiCli, string> = { claude: 'remote-cli-claude', codex: 'remote-cli-codex' };
/**
 * Codex saves a new thread only once it has a message or a name, and `codex resume` needs it saved, so a TUI conversation's
 * thread starts with this name. It keeps Codex from titling the thread by itself, so `/rename` is the only title it can have.
 */
export const CODEX_THREAD_NAME = 'DSH TUI';

/** The Claude session of a TUI conversation: the same every launch, so that reopening it resumes. */
export function tuiClaudeSession(sessionId: string): string {
  const hash = createHash('sha256').update(`dsh-tui:${sessionId}`).digest('hex');
  return [hash.slice(0, 8), hash.slice(8, 12), `4${hash.slice(13, 16)}`, `8${hash.slice(17, 20)}`, hash.slice(20, 32)].join('-');
}

/** Without a trailing space: DSH trims titles, and a difference would read as a rename. */
const promptTitle = (text: string) => text.slice(0, MAX_PROMPT_TITLE).trim();

/**
 * A conversation's title from Claude Code's session file: the user's /rename, then Claude's own title, then the first
 * prompt. Claude often writes no title, for a short greeting especially, and DSH titles its other conversations by their
 * first prompt too. The first `last-prompt` record holds the first prompt; a later one may have no text.
 */
export function claudeTitle(records: string): string | undefined {
  let custom: unknown, own: unknown, prompt: string | undefined;
  for (const line of records.split('\n')) {
    try {
      const record = JSON.parse(line) as { type?: string; customTitle?: unknown; aiTitle?: unknown; lastPrompt?: unknown };
      if (record.type === 'custom-title') custom = record.customTitle;
      if (record.type === 'ai-title') own = record.aiTitle;
      if (record.type === 'last-prompt' && prompt === undefined && typeof record.lastPrompt === 'string') {
        const text = record.lastPrompt.replace(/\s+/g, ' ').trim();
        // A slash command says nothing about the conversation.
        if (text && !text.startsWith('/')) prompt = promptTitle(text);
      }
    } catch { /* not a whole record */ }
  }
  const title = [custom, own].find(value => typeof value === 'string' && value.trim()) as string | undefined;
  return title?.trim().slice(0, MAX_TITLE) ?? prompt;
}

/**
 * A conversation's title from its Codex thread: the user's /rename, then the first prompt.
 * @param records - the thread's newest line of Codex's name index and the first of its user messages.
 */
export function codexTitle(records: string): string | undefined {
  let name: unknown, prompt: string | undefined;
  for (const line of records.split('\n')) {
    try {
      const record = JSON.parse(line) as { thread_name?: unknown; payload?: { item?: { type?: string; content?: unknown } } };
      if (record.thread_name !== undefined) name = record.thread_name;
      const item = record.payload?.item;
      if (item?.type !== 'UserMessage' || prompt !== undefined || !Array.isArray(item.content)) continue;
      const text = item.content.map((part: { type?: string; text?: unknown }) => (part?.type === 'text' && typeof part.text === 'string' ? part.text : '')).join(' ').replace(/\s+/g, ' ').trim();
      // A path says nothing about the conversation, like a slash command in Claude Code's.
      if (text && !text.startsWith('/')) prompt = promptTitle(text);
    } catch { /* not a whole record */ }
  }
  return typeof name === 'string' && name.trim() && name !== CODEX_THREAD_NAME ? name.trim().slice(0, MAX_TITLE) : prompt;
}

/** The model of a chat model route, `<project>/<cli>/<model>`, if it is this CLI's. */
function routeModel(route: unknown, expected: TuiCli): string | undefined {
  if (typeof route !== 'string') return;
  const [, cli, model] = route.split('/');
  try { return cli === expected && model ? decodeURIComponent(model) : undefined; } catch { return undefined; }
}

/**
 * Conversations whose main view is the interactive Claude Code or Codex instead of DSH's chat. Each stays a real DSH
 * session, so it is a row in the workspace list. DSH shows no views in a session until its log has a turn, so starting one
 * records an empty turn. The conversation itself lives in the remote CLI; see the launchers in terminal.ts.
 */
export class TuiSessions {
  constructor(private readonly store: Store, private readonly dsh: {
    /** Rejects a conversation that is not a verified remote workspace. */
    verify(sessionId: string, signal: AbortSignal): Promise<{ hostId: string }>;
    session(sessionId: string): TuiSession | undefined;
    agent?(sessionId: string): unknown;
    list(): Promise<readonly SessionRow[]>;
    rename(sessionId: string, title: string): Promise<void>;
    selectModel(selection: { sessionId: string; provider: string; model: string; reasoningEffort?: string }): Promise<void>;
    /** The title records of a Claude session on the conversation's machine. */
    titleRecords(sessionId: string, claudeSession: string, signal: AbortSignal): Promise<string>;
    /** Starts a saved Codex thread with CODEX_THREAD_NAME on the conversation's machine, and returns its ID. */
    codexThread(sessionId: string, signal: AbortSignal): Promise<string>;
    /** The title records of a Codex thread on the conversation's machine. */
    codexTitleRecords(sessionId: string, thread: string, signal: AbortSignal): Promise<string>;
    /** Ends a terminal's holder on the conversation's machine. */
    endHolder?(sessionId: string, holder: string, signal: AbortSignal): Promise<void>;
  }) {}
  list(): string[] { return this.store.snapshot().tuiSessions ?? []; }
  /**
   * Whether Claude Code is started with its classic renderer, which leaves the conversation in the terminal's own
   * scrollback. Its fullscreen one draws the scrolling itself: every wheel step is a trip to the host and a repaint of the
   * whole screen (about 3.5 KB at 126x47), so on a slow or lossy connection scrolling stutters while the page is idle.
   * Measured over a path of 77 ms with 2% loss: 120 ms a step and pauses of 200 ms, against 17 ms and none this way.
   * The launchers in terminal.ts read it, so it applies to a CLI when it next starts.
   */
  localScroll(): boolean { return this.store.snapshot().tuiLocalScroll !== false; }
  async setLocalScroll(local: boolean): Promise<void> { await this.store.update(state => { state.tuiLocalScroll = local; }); }
  /** Those of `list` that run Codex. */
  codex(): string[] {
    const { tuiSessions = [], tuiDetails } = this.store.snapshot();
    return tuiSessions.filter(id => tuiDetails?.[id]?.cli === 'codex');
  }
  /**
   * Tell DSH the conversation's model, once. A session shows its model in the workspace list only if a selection or a
   * request recorded it: a TUI conversation sends no requests, and the composer may only be showing a remembered default.
   * The icon is all that depends on this, so a failure is retried by the next title check rather than reported.
   * @param route - the composer's model route; a conversation started by an earlier version has none, so its is rebuilt.
   */
  private async recordModel(sessionId: string, hostId: string, route?: string): Promise<void> {
    const details = this.store.snapshot().tuiDetails?.[sessionId];
    if (details?.modelRecorded) return;
    const cli = details?.cli ?? 'claude';
    await this.dsh.selectModel({ sessionId, provider: PROVIDERS[cli], model: route ?? `${hostId}/${cli}/${encodeURIComponent(details?.model ?? 'default')}`,
      ...(details?.effort ? { reasoningEffort: details.effort } : {}) });
    await this.store.update(state => { state.tuiDetails = { ...state.tuiDetails, [sessionId]: { ...state.tuiDetails?.[sessionId], modelRecorded: true } }; });
  }
  /** @param selection - the CLI, and the composer's model route and effort, which its first launch uses. */
  async start(sessionId: string, selection: { cli?: unknown; model?: unknown; effort?: unknown }, signal: AbortSignal): Promise<void> {
    const cli: TuiCli = selection.cli === 'codex' ? 'codex' : 'claude';
    const target = await this.dsh.verify(sessionId, signal);
    if (this.list().includes(sessionId)) return;
    const session = this.dsh.session(sessionId);
    if (!session) throw new RemoteError('This conversation is not open', 409);
    // Its turns would stay in DSH while the CLI started from nothing.
    if ((await this.dsh.list()).find(row => row.sessionId === sessionId)?.blank === false) throw new RemoteError('Only a new conversation can start in the TUI', 409);
    signal.throwIfAborted();
    const thread = cli === 'codex' ? await this.dsh.codexThread(sessionId, signal) : undefined;
    signal.throwIfAborted();
    const model = routeModel(selection.model, cli), effort = selection.effort;
    await this.store.update(state => {
      state.tuiSessions = [...state.tuiSessions ?? [], sessionId];
      state.tuiDetails = { ...state.tuiDetails, [sessionId]: { title: FIRST_TITLES[cli], ...(thread ? { cli: 'codex' as const, thread } : {}),
        ...(model && COMMAND_VALUE.test(model) ? { model } : {}), ...(typeof effort === 'string' && COMMAND_VALUE.test(effort) ? { effort } : {}) } };
    });
    await this.recordModel(sessionId, target.hostId, model ? selection.model as string : undefined).catch(() => {});
    session.append('turn/start', { turn: 1 });
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    // An agent reads its last turn once, when it is created. A later turn here, numbered 1 again, would leave a log DSH
    // refuses to load.
    const phase = (this.dsh.agent?.(sessionId) as TuiAgent | undefined)?.phase;
    if (phase?.kind === 'idle') phase.lastTurn = 1;
    await this.dsh.rename(sessionId, FIRST_TITLES[cli]);
  }
  /** Ends the conversation's CLI, which otherwise keeps running with no DSH around. Reopening the conversation resumes it. */
  async end(sessionId: string, signal: AbortSignal): Promise<void> {
    if (this.list().includes(sessionId)) await this.dsh.endHolder?.(sessionId, tuiHolder(sessionId), signal);
  }
  /**
   * Follow the CLI's title, until the conversation is renamed in DSH.
   * @param current - the conversation's title in DSH.
   * @returns the new title, if it changed.
   */
  async syncTitle(sessionId: string, current: unknown, signal: AbortSignal): Promise<string | undefined> {
    if (!this.list().includes(sessionId)) return;
    const shown = typeof current === 'string' ? current : undefined, saved = this.store.snapshot().tuiDetails?.[sessionId];
    const renamed = shown !== undefined && shown !== saved?.title && !OLD_TITLE.test(shown);
    if (renamed && saved?.modelRecorded) return;
    const target = await this.dsh.verify(sessionId, signal);
    await this.recordModel(sessionId, target.hostId).catch(() => {});
    if (renamed) return;
    const title = saved?.thread ? codexTitle(await this.dsh.codexTitleRecords(sessionId, saved.thread, signal)) : claudeTitle(await this.dsh.titleRecords(sessionId, tuiClaudeSession(sessionId), signal));
    if (!title || title === shown) return;
    await this.dsh.rename(sessionId, title);
    await this.store.update(state => { state.tuiDetails = { ...state.tuiDetails, [sessionId]: { ...state.tuiDetails?.[sessionId], title } }; });
    return title;
  }
}
