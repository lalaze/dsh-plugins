/** Fold flat branch refs into a nested directory tree keyed by '/'-segments. */

import type { GitBranch } from './types.js'

export interface BranchTreeLeaf {
  readonly kind: 'leaf'
  /** Last '/'-segment of the branch name. */
  readonly label: string
  /** Full branch name as git reported it. */
  readonly path: string
  /** The original object, identity preserved. */
  readonly branch: GitBranch
}

export interface BranchTreeDir {
  readonly kind: 'dir'
  /** Display name relative to the parent row: the last segment, or a merged
   * chain (e.g. 'a/b' under 'feat'). */
  readonly label: string
  /** Absolute path of the dir, e.g. 'feat/a/b'. */
  readonly path: string
  /** A branch whose name equals this dir's path, else null. */
  readonly self: GitBranch | null
  readonly children: readonly BranchTreeNode[]
}

export type BranchTreeNode = BranchTreeLeaf | BranchTreeDir

/** Mutable dir used while folding; `label` is the display segment, `path` the
 * absolute one, until `collapse` rewrites the label of a merged chain. */
interface BuilderDir {
  readonly kind: 'dir'
  label: string
  path: string
  self: GitBranch | null
  children: BuilderNode[]
}

type BuilderNode = BranchTreeLeaf | BuilderDir

interface Entry {
  readonly segments: readonly string[]
  readonly branch: GitBranch
}

/**
 * Fold branches into a directory tree, preserving input order (the host sorts by
 * `-committerdate`) and collapsing single-child dir chains into one node.
 */
export function buildBranchTree(branches: readonly GitBranch[]): BranchTreeNode[] {
  const entries: Entry[] = []
  const dirPaths = new Set<string>()
  for (const branch of branches) {
    const segments = branch.name.split('/').filter((s) => s !== '')
    if (segments.length === 0) continue
    entries.push({ segments, branch })
    let acc = ''
    for (let i = 0; i < segments.length - 1; i++) {
      acc = acc === '' ? segments[i]! : `${acc}/${segments[i]!}`
      dirPaths.add(acc)
    }
  }

  // Absolute dir path → node, shared by every level: a dir is created once and
  // found in O(1), so a wide sibling list is never rescanned per ref.
  const dirs = new Map<string, BuilderDir>()
  const roots: BuilderNode[] = []
  for (const { segments, branch } of entries) {
    const name = segments.join('/')
    // A branch named like a dir path attaches as that dir's `self`, never as a
    // duplicate same-named sibling.
    const isDirName = dirPaths.has(name)
    let children = roots
    let acc = ''
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!
      acc = acc === '' ? seg : `${acc}/${seg}`
      const last = i === segments.length - 1
      if (last && !isDirName) {
        children.push({ kind: 'leaf', label: seg, path: name, branch })
        break
      }
      let dir = dirs.get(acc)
      if (dir === undefined) {
        dir = { kind: 'dir', label: seg, path: acc, self: null, children: [] }
        dirs.set(acc, dir)
        children.push(dir)
      }
      if (last) dir.self = branch
      else children = dir.children
    }
  }
  return collapse(roots)
}

/**
 * Merge a dir whose only child is a dir into "a/b". A dir carrying a `self`
 * branch is left alone: merging it would rename the path out from under the
 * branch it holds.
 */
function collapse(nodes: readonly BuilderNode[]): BranchTreeNode[] {
  return nodes.map((node) => {
    if (node.kind === 'leaf') return node
    let current = node
    for (;;) {
      const only = current.children.length === 1 ? current.children[0]! : undefined
      if (current.self !== null || only === undefined || only.kind !== 'dir') break
      current = {
        kind: 'dir',
        label: `${current.label}/${only.label}`,
        path: only.path,
        self: only.self,
        children: only.children,
      }
    }
    return {
      kind: 'dir',
      label: current.label,
      path: current.path,
      self: current.self,
      children: collapse(current.children),
    }
  })
}

/**
 * Name of the branch to pin first: the repo default when it exists locally, else
 * `main`, else `master`. Null when the repo has none of them.
 */
export function primaryBranchName(local: readonly GitBranch[], defaultBranch: string | null): string | null {
  const has = (name: string): boolean => local.some((b) => b.name === name)
  if (defaultBranch !== null && has(defaultBranch)) return defaultBranch
  if (has('main')) return 'main'
  if (has('master')) return 'master'
  return null
}

/**
 * Move the named ref to the front, leaving the rest of the order untouched.
 * Returns the input array itself when nothing moves, so callers keep identity.
 */
export function pinPrimaryFirst(branches: readonly GitBranch[], name: string | null): readonly GitBranch[] {
  if (name === null) return branches
  const at = branches.findIndex((b) => b.name === name)
  if (at <= 0) return branches
  return [branches[at]!, ...branches.slice(0, at), ...branches.slice(at + 1)]
}

/**
 * Full ref to lead the remote section: `<primary remote>/<default branch>`, else
 * the same remote's `main`, else its `master`. Resolved from the remote refs
 * alone — a remote-tracking ref is worth pinning even when the local branch of
 * that name is missing or named differently, so this never consults the local
 * list (unlike `primaryBranchName`).
 */
export function primaryRemoteRef(remote: readonly GitBranch[], remoteName: string | null, defaultBranch: string | null): string | null {
  if (remoteName === null) return null
  const names = defaultBranch === null ? ['main', 'master'] : [defaultBranch, 'main', 'master']
  for (const name of names) {
    const ref = `${remoteName}/${name}`
    if (remote.some((b) => b.name === ref)) return ref
  }
  return null
}

/** The pinned rows plus the folded remainder of the local branch list. */
export interface LocalBranchSection {
  /** Rendered above the tree in full: the current branch, then the primary. */
  readonly pinned: readonly GitBranch[]
  /** Every other branch, folded in input order. */
  readonly nodes: readonly BranchTreeNode[]
}

/**
 * Split the local list for the pinned rows: `current` when it exists, then
 * `primary` — a name that is both leads once. Both leave the tree, so a slashed
 * name shows in full above it instead of disappearing into its directory.
 * Everything else keeps the host order.
 */
export function buildLocalBranchSection(branches: readonly GitBranch[], current: string | null, primary: string | null): LocalBranchSection {
  const pinned: GitBranch[] = []
  const take = (name: string | null): void => {
    if (name === null || pinned.some((b) => b.name === name)) return
    const found = branches.find((b) => b.name === name)
    if (found !== undefined) pinned.push(found)
  }
  take(current)
  take(primary)
  const pinnedNames = new Set(pinned.map((b) => b.name))
  return { pinned, nodes: buildBranchTree(branches.filter((b) => !pinnedNames.has(b.name))) }
}
