import { type RepoFs } from './repos.js';
/** One record of `git worktree list --porcelain`. */
export interface WorktreeInfo {
    /** Absolute work-tree path as git printed it. */
    readonly path: string;
    /** HEAD commit; null when the repository has no commits (unborn). */
    readonly head: string | null;
    /** Checked-out branch (refs/heads/ stripped); null = detached HEAD. */
    readonly branch: string | null;
    readonly locked: boolean;
    readonly prunable: boolean;
    readonly bare: boolean;
}
/**
 * A worktree converted for the switcher: the cwd-relative selector path (or a
 * lexical relative path for a disabled row), the identity the row needs, and
 * the reason it cannot be chosen when there is one.
 */
export interface WorktreeCheckout {
    /** cwd-relative POSIX path; '' when the row *is* the session's checkout. */
    readonly path: string;
    /** Realpath of the directory (the listed path when it is gone). */
    readonly root: string;
    readonly name: string;
    readonly role: 'main' | 'linked';
    readonly branch: string | null;
    readonly locked: boolean;
    readonly disabled?: 'outside' | 'stale';
}
/** Parse `git worktree list --porcelain [-z]` output into records. git prints
 * paths verbatim (never quoted), so only the `-z` form — every attribute
 * NUL-terminated, an empty attribute between records — survives a path holding
 * a newline; output without a NUL is the newline form of a git that predates
 * `-z`. An empty attribute separates records; a bare key (`detached`, `bare`)
 * carries no value, and `locked` / `prunable` carry an optional reason. */
export declare function parseWorktreePorcelain(stdout: string): WorktreeInfo[];
/**
 * Convert porcelain records into switcher rows for one session.
 *
 * `workspaceRoot` is the checkout the session's own selector resolves to; the
 * record naming that directory becomes the workspace row (`path: ''`) whatever
 * its primary/linked role is, so the list and the selector agree on identity.
 * The primary work tree keeps `role: 'main'`; every other record is `linked`.
 * Rows are returned in git's order (primary first), then selectable rows and
 * disabled rows grouped by the caller.
 */
export declare function worktreeCheckouts(fs: RepoFs, cwd: string, workspaceRoot: string, infos: readonly WorktreeInfo[]): Promise<readonly WorktreeCheckout[]>;
