import type { TuiUsageCursor } from './tui-usage.js';

/**
 * A TUI conversation's first launch of its CLI, the title the plugin last gave it, and whether DSH has been told the
 * conversation's model. A Codex conversation also names its CLI and thread; one without them runs Claude Code.
 * 0.1.10 and earlier showed a conversation another DSH started under a session of this DSH. Such a conversation stays:
 * `key` is its session in that DSH, which names its CLI session and its terminal on the machine, and `usageFrom` is when
 * it came here, as its earlier turns were counted there.
 */
export interface TuiDetails { cli?: 'codex'; thread?: string; model?: string; effort?: string; title?: string; modelRecorded?: boolean; usage?: TuiUsageCursor; key?: string; usageFrom?: string }
/** What names a TUI conversation on its machine. */
export const tuiKey = (sessionId: string, details?: Pick<TuiDetails, 'key'>): string => details?.key || sessionId;
/** What is saved about TUI conversations: which DSH conversations they are, each one's details, and the scrolling choice. */
export interface TuiState {
  tuiSessions?: string[];
  tuiDetails?: Record<string, TuiDetails>;
  /** Whether Claude Code in a terminal leaves scrolling to that terminal; on unless false. See TuiSessions.localScroll. */
  tuiLocalScroll?: boolean;
}
/** Where that is kept. `directory` is a private folder beside it. */
export interface TuiStore {
  readonly directory: string;
  snapshot(): TuiState;
  update(change: (state: TuiState) => void): Promise<void>;
}
