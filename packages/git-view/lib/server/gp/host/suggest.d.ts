import type { GitPanelConfig, SnapshotDeps } from './core.js';
import type { GitSuggestRequest, GitSuggestResult, ResolvedLanguage, SuggestLanguage } from './types.js';
export declare function isCjkText(text: string): boolean;
/**
 * Parse `git log -z --format=%ae%x1f%s` into the repository's own commit
 * subjects, newest first: mechanical commits dropped, and the current
 * author's commits preferred once they are numerous enough to represent the
 * repository (a shared checkout may mix identities). Subjects are trimmed to
 * `STYLE_SAMPLE_MAX_CHARS` code points so one runaway subject cannot consume
 * the generation budget; the closest commit's language still dominates.
 */
export declare function parseStyleHistory(stdout: string, ownEmail: string | undefined): string[];
/**
 * Resolve the language a suggestion is written in. `zh` / `en` are honored as
 * configured; `auto` votes over the repository's recent non-mechanical commit
 * subjects with a recency decay, so a repository that switched languages is
 * judged by how it writes *now* rather than by its whole history. With no
 * history to read (an unborn repository) the vote is empty and English is the
 * neutral fallback.
 */
export declare function resolveSuggestLanguage(setting: SuggestLanguage, samples: readonly string[]): ResolvedLanguage;
/** A diff line longer than this is replaced by a one-line marker before the
 * model-input budget is applied. Build output is minified into single lines (a
 * bundled `lib/client.js` line can be hundreds of KB), so shipping it verbatim
 * spends the whole `suggestMaxBytes` budget on one line and cuts off the hunks
 * that actually describe the change. Line count and the diff prefix are kept,
 * so `@@` headers still describe the same regions. */
export declare const LONG_LINE_MAX_CHARS = 400;
/** Fold over-long lines into `<prefix>… [long line: N chars omitted]`.
 * `N` counts UTF-16 code units (what `String.length` reports), not bytes. */
export declare function compactLongLines(text: string, maxChars?: number): {
    text: string;
    folded: number;
};
/** Generate a commit message for the session's uncommitted changes. */
export declare function runSuggest(deps: SnapshotDeps, config: GitPanelConfig, request: GitSuggestRequest): Promise<GitSuggestResult>;
