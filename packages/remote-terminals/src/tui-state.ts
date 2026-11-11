import type { TuiUsageCursor } from './tui-usage.js';

/**
 * A TUI conversation's first launch of its CLI, the title the plugin last gave it, and whether DSH has been told the
 * conversation's model. A Codex conversation also names its CLI and thread; one without them runs Claude Code.
 */
export interface TuiDetails { cli?: 'codex'; thread?: string; model?: string; effort?: string; title?: string; modelRecorded?: boolean; usage?: TuiUsageCursor }
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
