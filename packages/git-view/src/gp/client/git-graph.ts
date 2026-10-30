/**
 * Commit-graph lane layout. Independent implementation: given commits in
 * topological (newest-first) order with parent links, assign each commit a
 * lane column and compute the passing edges for that row, so a canvas/SVG
 * layer can draw nodes and connecting lines.
 */
import type { GraphCommit, GraphStyle } from './types.js'

export interface GraphEdge {
  /** Lane the edge occupies at the top of the row. */
  readonly fromLane: number
  /** Lane the edge occupies at the bottom of the row. */
  readonly toLane: number
  readonly color: number
  /**
   * Vertical span within the row: `into` flows top → node (drawn to ROW_H/2),
   * `out` flows node → bottom (drawn from ROW_H/2), `pass` crosses the whole
   * row. Into/out edges meeting at the node keep a lane's stub from trailing
   * below its last commit and keep a converging curve from being overdrawn
   * by a full-height straight.
   */
  readonly kind: 'into' | 'out' | 'pass'
  /**
   * The line spans hidden commits (a filtered view's projected edge). The whole
   * connection is drawn dashed: its lane carries the flag through every pass and
   * into edge, not just at the node that opened it.
   */
  readonly indirect?: boolean
}

export interface GraphRow {
  readonly commit: GraphCommit
  /** Lane index of this commit's node. */
  readonly lane: number
  readonly color: number
  /** Edges passing through this row (including this node's outgoing edges). */
  readonly edges: readonly GraphEdge[]
  /** Whether the node is a merge (2+ parents). */
  readonly merge: boolean
  /**
   * A parent link this row cannot draw: the parent is not loaded, the topology
   * is missing, or the history is truncated / shallow. The lane closes here (a
   * short stub is drawn) instead of staying open to the bottom of the list.
   */
  readonly boundary?: boolean
}

/** One resolved parent link: the visible commit this row connects down to. */
export interface GraphLink {
  readonly hash: string
  /** Target is an ancestor reached across hidden commits, not a direct parent. */
  readonly indirect: boolean
}

/** Total lane count used across all rows (for width sizing). */
export function graphWidth(rows: readonly GraphRow[]): number {
  let max = 0
  for (const row of rows) {
    max = Math.max(max, row.lane + 1)
    for (const e of row.edges) max = Math.max(max, e.fromLane + 1, e.toLane + 1)
  }
  return max
}

/**
 * Assign lanes. `lanes[i]` holds the commit hash the lane is currently waiting
 * to place (its next expected commit). We walk commits newest→oldest, place
 * each commit into the first lane awaiting it (or a new lane), continue that
 * lane with the commit's first parent, and open new lanes for extra parents.
 * Each lane carries one color for its whole run.
 *
 * `style` controls how a first parent already reached by another lane is drawn:
 *  - `compact` (git log --graph): the two lanes converge into the leftmost one
 *    right away, so the shared ancestor keeps a single column (fewer lanes).
 *  - `parallel` (VSCode / GUI tools): each merge's first parent continues in its
 *    own lane, so a shared ancestor shows as parallel lines that converge only
 *    at the ancestor node (wider, straighter lines).
 *
 * `links` replaces each commit's raw parents with resolved visible targets (see
 * `layoutFilteredGraph`). Omitted, the commit's own parents drive the layout and
 * the result is the unfiltered one.
 */
export function layoutGraph(commits: readonly GraphCommit[], style: GraphStyle, links?: readonly (readonly GraphLink[])[]): GraphRow[] {
  const rows: GraphRow[] = []
  // Each active lane awaits a specific commit hash (its child already placed)
  // and carries a color for its whole run, so a continuous line keeps one color
  // (VSCode-style, issue #9) instead of recoloring at every commit. A lane's
  // color is freed when the lane closes and reused lowest-first to keep the
  // palette tight. A lane also carries whether the connection it holds spans
  // hidden commits, so the whole line — pass, into and out edges alike — is
  // dashed, not only the edge that opened it.
  let lanes: (string | null)[] = []
  let laneColor: (number | null)[] = []
  let laneIndirect: boolean[] = []
  const freed: number[] = []
  let nextColor = 0
  // Reuse the lowest freed color so the palette stays tight across the page.
  const openColor = (): number => {
    if (freed.length === 0) return nextColor++
    const c = Math.min(...freed)
    freed.splice(freed.indexOf(c), 1)
    return c
  }
  const freeColor = (c: number | null): void => { if (c !== null && !freed.includes(c)) freed.push(c) }
  // Open a column for a connection: the first free lane, else a new one.
  const openLane = (hash: string, indirect: boolean): number => {
    let lane = lanes.findIndex((h) => h === null)
    if (lane === -1) { lane = lanes.length; lanes.push(null); laneColor.push(null); laneIndirect.push(false) }
    lanes[lane] = hash
    laneColor[lane] = openColor()
    laneIndirect[lane] = indirect
    return lane
  }
  // A node sits in any lane awaiting it. A parent link only shares a lane that
  // awaits the same target with the SAME nature: reusing a lane of the other
  // nature would paint the new line with the wrong style. Two natures therefore
  // stay apart until the target, where both converge — one into-edge each, each
  // keeping its own style.
  const laneAwaiting = (hash: string): number => lanes.findIndex((h) => h === hash)
  const assignParentLane = (hash: string, indirect: boolean): number => {
    const lane = lanes.findIndex((h, i) => h === hash && laneIndirect[i] === indirect)
    return lane === -1 ? openLane(hash, indirect) : lane
  }
  // `indirect` is set only when true, so unfiltered rows keep today's shape.
  const edge = (fromLane: number, toLane: number, color: number, kind: GraphEdge['kind'], indirect: boolean): GraphEdge =>
    indirect ? { fromLane, toLane, color, kind, indirect: true } : { fromLane, toLane, color, kind }

  for (let index = 0; index < commits.length; index++) {
    const commit = commits[index]!
    // Resolved links when the caller projected a filtered list, else the raw
    // parents (the unfiltered layout).
    const resolved = links === undefined ? undefined : links[index]
    const parentCount = resolved === undefined ? commit.parents.length : resolved.length
    const parentAt = (i: number): string => (resolved === undefined ? commit.parents[i]! : resolved[i]!.hash)
    const indirectAt = (i: number): boolean => resolved !== undefined && resolved[i]!.indirect

    // Was any lane already awaiting this commit (i.e. a child placed above it)?
    // If not, the node opens a fresh lane and is a tip — it must not draw an
    // incoming stub above its dot (the newest commit / a branch head).
    const awaited = laneAwaiting(commit.hash)
    const awaitedBefore = awaited !== -1
    const lane = awaited === -1 ? openLane(commit.hash, false) : awaited
    const color = laneColor[lane]!

    // Snapshot lanes + their state before mutation (top of the row).
    const before = [...lanes]
    const beforeColor = [...laneColor]
    const beforeIndirect = [...laneIndirect]

    // This lane continues with the commit's FIRST resolved link, keeping a
    // first-parent chain straight in a single column; extra links open new lanes
    // to the right. `merge` stays a property of the RAW parents, so one parent
    // crossing a hidden merge can display several lines without becoming a merge.
    const merge = commit.parents.length >= 2
    // A commit with several displayed children is awaited by more than one lane;
    // the extras converge into this node (drawn below as into-edges).
    for (let i = 0; i < lanes.length; i++) {
      if (i !== lane && lanes[i] === commit.hash) { freeColor(laneColor[i]); lanes[i] = null; laneColor[i] = null }
    }
    let contLane = -1 // lane the first link continues in (-1 = chain ends here)
    const extraLanes: number[] = [] // lanes opened for the 2nd+ links
    if (parentCount === 0) {
      freeColor(laneColor[lane]); lanes[lane] = null; laneColor[lane] = null
    } else {
      const fp = parentAt(0)
      const fpIndirect = indirectAt(0)
      // Compact converges a first parent already awaited by another lane into the
      // leftmost one (main line stays left, issue #9) — but only when both lines
      // have the same nature. Two lines of different indirect state must stay
      // apart until the real target, or one trunk could not show which of them
      // skips hidden commits.
      const other = style === 'compact'
        ? lanes.findIndex((h, i) => h === fp && i !== lane && laneIndirect[i] === fpIndirect)
        : -1
      if (other === -1) {
        lanes[lane] = fp // lane keeps its color across the continuation
        laneIndirect[lane] = fpIndirect
        contLane = lane
      } else {
        // Compact only: two lanes want the same parent — keep the leftmost.
        const keep = Math.min(lane, other)
        const drop = Math.max(lane, other)
        lanes[keep] = fp
        laneIndirect[keep] = fpIndirect
        freeColor(laneColor[drop]); lanes[drop] = null; laneColor[drop] = null
        contLane = keep
      }
      for (let p = 1; p < parentCount; p++) extraLanes.push(assignParentLane(parentAt(p), indirectAt(p)))
    }

    // Edge color is the color of the line it represents: an into/pass edge keeps
    // the incoming lane's color up to the node; an out edge takes the color of
    // the lane it lands in (the continuation, or the target line of a merge).
    const edges: GraphEdge[] = []
    for (let i = 0; i < before.length; i++) {
      const awaited = before[i]
      if (awaited === null) continue
      if (awaited === commit.hash) {
        // Skip the self-edge of a freshly opened lane: a tip has no line above.
        if (i === lane && !awaitedBefore) continue
        edges.push(edge(i, lane, beforeColor[i]!, 'into', beforeIndirect[i]!))
      } else {
        // A lane still awaiting the same commit stays in place (parallel lines
        // never collapse onto the first matching slot); otherwise follow it.
        const toLane = lanes[i] === awaited ? i : lanes.findIndex((h, j) => h === awaited && laneIndirect[j] === beforeIndirect[i])
        if (toLane !== -1) edges.push(edge(i, toLane, beforeColor[i]!, 'pass', beforeIndirect[i]!))
      }
    }
    if (contLane !== -1) edges.push(edge(lane, contLane, laneColor[contLane]!, 'out', laneIndirect[contLane]!))
    for (const lp of extraLanes) edges.push(edge(lane, lp, laneColor[lp]!, 'out', laneIndirect[lp]!))

    rows.push({ commit, lane, color, edges, merge })
    // Trim trailing null lanes to keep width tight.
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) {
      lanes = lanes.slice(0, -1); laneColor = laneColor.slice(0, -1); laneIndirect = laneIndirect.slice(0, -1)
    }
  }
  return rows
}

