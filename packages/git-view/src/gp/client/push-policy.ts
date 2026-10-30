import type { GitSnapshot } from './types.js'

/** Offer only ordinary pushes from a branch strictly ahead of its upstream. */
export function canPush(snapshot: GitSnapshot): boolean {
  return snapshot.hasUpstream === true && snapshot.ahead > 0 && snapshot.behind === 0
}

/**
 * Offer publishing when the current branch exists only locally: it has no
 * upstream yet, HEAD is on a branch (not detached), there is at least one
 * commit to send (an unborn branch has nothing to push), and a remote exists to
 * create the branch on. Creating a same-named branch on the remote cannot
 * overwrite anything, so this needs no ahead/behind reconciliation.
 */
export function canPublish(snapshot: GitSnapshot): boolean {
  return snapshot.hasUpstream !== true
    && snapshot.branch !== null
    && snapshot.unborn !== true
    && snapshot.head !== null && snapshot.head !== ''
    && snapshot.remote !== null
}

/** The remote write the sync controls offer for this snapshot; null = none. */
export type PushIntent = 'push' | 'publish'

/** One source for every push-shaped control, so a branch that cannot be pushed
 * can still be published (and the two states can never both show). */
export function pushIntent(snapshot: GitSnapshot): PushIntent | null {
  if (canPush(snapshot)) return 'push'
  if (canPublish(snapshot)) return 'publish'
  return null
}
