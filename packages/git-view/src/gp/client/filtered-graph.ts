/**
 * Filtered commit-graph projection: draw the loaded window's real DAG, but only
 * onto the commits the current filter shows. A link between visible commits is
 * solid when it is a direct parent and dashed (`indirect`) when it skips hidden
 * ancestors; a parent the topology cannot resolve ends the row with a boundary
 * stub instead of holding a lane open to the bottom of the list.
 */
import type { GitGraphNode, GraphCommit, GraphStyle } from './types.js'
import { layoutGraph, type GraphLink, type GraphRow } from './git-graph.js'

/**
 * Ceiling on projected links for one layout. A single page can hold 10k commits
 * and a merge-dense window projects O(visible²) links; past the budget the rest
 * of each row's real parent paths are flagged `boundary` instead of drawn, so
 * the row keeps its node and the layout stays linear.
 */
const MAX_DISPLAY_LINKS = 4096

/**
 * Ceiling on ancestor entries held across the whole hidden memo. A merge-dense
 * window could otherwise build an O(hidden × visible) matrix out of a small raw
 * input; past the budget the remaining resolutions report `unknown`, so their
 * rows draw a boundary stub rather than a link.
 */
const MAX_ANCESTOR_ENTRIES = 1_000_000

/**
 * Ceiling on the summed row span of projected links. A link also costs about
 * `target - source` pass edges, so bounding the span bounds the whole edge set
 * without touching the layout. Conservative: a link that does not fit becomes a
 * boundary stub, so the drawn graph is a subset, never a wrong one.
 */
const MAX_ROW_SPAN = 100_000

interface Resolution {
  /** Nearest visible ancestors, first-parent order, deduplicated. */
  readonly ancestors: readonly string[]
  /** A hole the topology could not resolve, or an ancestor set cut at the cap. */
  readonly unknown: boolean
}

/**
 * Project `commits` onto `topology` (the loaded window's parent map, including
 * the commits the filter hid). An empty topology still links visible commits
 * through their own parents — it only loses the ability to see across hidden
 * ones, which then read as boundary stubs. Nothing is cached across calls, so
 * loading another page recomputes against the new window.
 */
export function layoutFilteredGraph(commits: readonly GraphCommit[], topology: readonly GitGraphNode[], style: GraphStyle): GraphRow[] {
  const parentsOf = new Map<string, readonly string[]>()
  for (const node of topology) parentsOf.set(node.hash, node.parents)
  // Visible hash → row index: also the "is shown" test and the ordering rule.
  const order = new Map<string, number>()
  commits.forEach((commit, index) => order.set(commit.hash, index))
  // A hidden node cannot reach more visible ancestors than there are rows.
  const ancestorCap = Math.min(MAX_DISPLAY_LINKS, order.size)

  // Nearest visible ancestors of a hidden commit, memoized per node. Walked with
  // an explicit stack (a 10k-deep hidden chain must not overflow the call stack)
  // and folded in post-order, so a shared subgraph is resolved once instead of
  // once per path — a diamond ladder would otherwise be exponential.
  const resolved = new Map<string, Resolution>()
  let ancestorEntries = 0
  const resolveHidden = (start: string): Resolution => {
    const done = resolved.get(start)
    if (done !== undefined) return done
    const stack: { hash: string; expanded: boolean }[] = [{ hash: start, expanded: false }]
    const seen = new Set<string>()
    const post: string[] = []
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!
      if (!frame.expanded) {
        frame.expanded = true
        seen.add(frame.hash)
        const parents = parentsOf.get(frame.hash)!
        // Push in reverse so the first parent is expanded first.
        for (let i = parents.length - 1; i >= 0; i--) {
          const parent = parents[i]!
          if (order.has(parent) || !parentsOf.has(parent) || seen.has(parent) || resolved.has(parent)) continue
          stack.push({ hash: parent, expanded: false })
        }
        continue
      }
      post.push(frame.hash)
      stack.pop()
    }
    // Post-order: every hidden parent is folded before the child that needs it.
    for (const hash of post) {
      if (resolved.has(hash)) continue
      const parents = parentsOf.get(hash)!
      // Every parent resolved to the same immutable object — a single-parent
      // chain, or parallel branches that merged into one. Share that result
      // instead of copying its ancestor list: a long chain above a wide hidden
      // merge would otherwise copy the wide list once per link (quadratic).
      let shared: Resolution | undefined
      let shareable = parents.length > 0
      for (const parent of parents) {
        if (order.has(parent)) { shareable = false; break }
        const sub = resolved.get(parent)
        if (sub === undefined) { shareable = false; break }
        if (shared === undefined) shared = sub
        else if (shared !== sub) { shareable = false; break }
      }
      if (shareable && shared !== undefined) { resolved.set(hash, shared); continue }

      const ancestors: string[] = []
      const uniq = new Set<string>()
      let unknown = false
      const push = (ancestor: string): void => {
        if (uniq.has(ancestor)) return
        // Cut at the cap or the total memo budget: the row only needs to know
        // that something was omitted, and it draws a stub instead of a link.
        if (ancestors.length >= ancestorCap || ancestorEntries >= MAX_ANCESTOR_ENTRIES) { unknown = true; return }
        uniq.add(ancestor)
        ancestors.push(ancestor)
        ancestorEntries++
      }
      for (const parent of parents) {
        if (order.has(parent)) { push(parent); continue }
        const sub = resolved.get(parent)
        // Missing from the topology, or an unresolved cycle: a hole either way.
        if (sub === undefined) { unknown = true; continue }
        for (const ancestor of sub.ancestors) push(ancestor)
        if (sub.unknown) unknown = true
      }
      resolved.set(hash, { ancestors, unknown })
    }
    return resolved.get(start)!
  }

  let budget = MAX_DISPLAY_LINKS
  let spanBudget = MAX_ROW_SPAN
  const links: GraphLink[][] = []
  const boundary: boolean[] = []
  for (let index = 0; index < commits.length; index++) {
    const commit = commits[index]!
    // The commit's own parents are authoritative for a visible commit: a
    // truncated topology entry must not turn a real parent into a fake root.
    const parents = commit.parents
    const out: GraphLink[] = []
    const at = new Map<string, number>()
    let stub = false
    // A target must sit BELOW its source. Partial data spanning generations must
    // not fabricate a back edge to a row already drawn (or to the source itself).
    const below = (hash: string): boolean => {
      const at2 = order.get(hash)
      return at2 !== undefined && at2 > index
    }
    // Provenance order is kept; a target reached both directly and across hidden
    // commits is one link, and the direct one wins.
    const add = (hash: string, indirect: boolean): void => {
      const seen = at.get(hash)
      if (seen === undefined) {
        // A link costs one display link and about one pass edge per row it
        // spans; both budgets must cover it. Out of budget: keep the node, flag
        // the row, draw no further link.
        const span = order.get(hash)! - index + 1
        if (budget === 0 || spanBudget < span) { stub = true; return }
        budget--
        spanBudget -= span
        at.set(hash, out.length)
        out.push({ hash, indirect })
      } else if (!indirect && out[seen]!.indirect) {
        // Already charged: the upgrade reuses the same target.
        out[seen] = { hash, indirect: false }
      }
    }
    for (const parent of parents) {
      if (order.has(parent)) {
        if (below(parent)) add(parent, false)
        else stub = true
        continue
      }
      if (!parentsOf.has(parent)) { stub = true; continue }
      const res = resolveHidden(parent)
      // No visible target (the chain ends outside the shown commits) or a hole
      // in the topology: this connection cannot be drawn to a node.
      if (res.ancestors.length === 0 || res.unknown) stub = true
      for (const ancestor of res.ancestors) {
        if (below(ancestor)) add(ancestor, true)
        else stub = true
      }
    }
    links.push(out)
    boundary.push(stub)
  }

  const rows = layoutGraph(commits, style, links)
  return boundary.some((flag) => flag) ? rows.map((row, i) => (boundary[i] === true ? { ...row, boundary: true } : row)) : rows
}
