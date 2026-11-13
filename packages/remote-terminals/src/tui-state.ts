import type { TuiUsageCursor } from './tui-usage.js';

/** What this DSH and the machine's list of TUI conversations last agreed on, which tells a change here from one made elsewhere. */
export interface TuiShared { archived: boolean; title?: string }
/**
 * A TUI conversation's first launch of its CLI, the title the plugin last gave it, and whether DSH has been told the
 * conversation's model. A Codex conversation also names its CLI and thread; one without them runs Claude Code.
 * A conversation another DSH started is shown here under a session of this DSH: `key` is then its session there, which
 * names its CLI session and its terminal on the machine, and `usageFrom` is when it came, as its earlier turns were
 * counted there. `shared` is set once the conversation is in the machine's list; see tui-shared.ts.
 */
export interface TuiDetails { cli?: 'codex'; thread?: string; model?: string; effort?: string; title?: string; modelRecorded?: boolean; usage?: TuiUsageCursor; key?: string; shared?: TuiShared; usageFrom?: string }
/** What names a TUI conversation on its machine, the same in every DSH that shows it. */
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
