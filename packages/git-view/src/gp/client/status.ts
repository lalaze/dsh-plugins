/** Changed-file status → display helpers, shared by the Changes list and the
 * Overview commit-file tree so both map every status (incl. conflicted /
 * typechange) onto a CSS class that actually exists in styles.ts. */
import type { GitChange, GitChangeStatus } from './types.js'

/** Single-letter badge for a status. */
export const statusChar: Record<string, string> = {
  added: 'A', modified: 'M', deleted: 'D', renamed: 'R', untracked: 'U', conflicted: '!', typechange: 'T',
}

/** CSS class for a status badge; unmapped statuses fall back to modified. */
export function statusClass(status: GitChangeStatus | string): string {
  if (status === 'added' || status === 'untracked') return 'gp-status--added'
  if (status === 'deleted') return 'gp-status--deleted'
  if (status === 'renamed') return 'gp-status--renamed'
  return 'gp-status--modified'
}

/**
 * Whether Git considers `path` untracked. Untracked files normally carry their
 * own entry (`--untracked-files=all`); the ancestor rule covers the entries that
 * stay directory-level — nested repositories/submodules, and the collapsed
 * fallback for an untracked tree too large to expand — whose files match no
 * change of their own.
 */
export function isUntrackedPath(changes: readonly GitChange[], path: string): boolean {
  return changes.some((c) => c.status === 'untracked'
    && (c.isDirectory ? path.startsWith(`${c.path}/`) : c.path === path))
}
