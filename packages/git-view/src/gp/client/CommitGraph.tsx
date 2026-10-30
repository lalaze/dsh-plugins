/** SVG row renderer shared by wide and compact commit lists. */
import { createElement as h, useId } from 'react'
import type { JSX } from 'react'
import type { GraphRow } from './git-graph.js'

export const GRAPH_LANE_W = 14
const PALETTE = ['#4e9bff', '#3fb950', '#e0982e', '#d05ce3', '#e5534b', '#2dc6c6', '#d29922', '#8b949e']

export function CommitGraph({ row, laneCount, rowH, current }: {
  readonly row: GraphRow
  readonly laneCount: number
  readonly rowH: number
  readonly current: boolean
}): JSX.Element {
  const maskId = useId()
  const w = Math.max(GRAPH_LANE_W, laneCount * GRAPH_LANE_W)
  const cx = (lane: number): number => lane * GRAPH_LANE_W + GRAPH_LANE_W / 2
  const mid = rowH / 2
  const color = PALETTE[row.color % PALETTE.length]
  const edges = row.edges.map((edge) => {
    const y0 = edge.kind === 'out' ? mid : 0
    const y1 = edge.kind === 'into' ? mid : rowH
    const cy = (y0 + y1) / 2
    return h('path', {
      key: `${edge.kind}-${edge.fromLane}-${edge.toLane}-${edge.color}`,
      className: 'gp-graph-edge',
      d: `M ${cx(edge.fromLane)} ${y0} C ${cx(edge.fromLane)} ${cy}, ${cx(edge.toLane)} ${cy}, ${cx(edge.toLane)} ${y1}`,
      stroke: PALETTE[edge.color % PALETTE.length], strokeWidth: 1.6, fill: 'none',
      ...(edge.indirect ? { strokeDasharray: '7 5', 'data-indirect': 'true' } : {}),
    })
  })
  if (row.boundary) {
    const endX = cx(row.lane) + (row.edges.some((edge) => edge.kind === 'out') ? 5 : 0)
    edges.push(h('path', {
      key: 'boundary', className: 'gp-graph-boundary',
      d: `M ${cx(row.lane)} ${mid} L ${endX} ${mid + 7} V ${Math.min(rowH - 3, mid + 13)}`,
      stroke: color, strokeWidth: 1.6, strokeDasharray: '3 3', fill: 'none',
    }))
  }
  // Clear the line beneath HEAD's ring and dot without painting over the row
  // highlight, so the gap between the two stays transparent in every theme.
  return h('svg', { className: 'gp-graph-svg', width: w, height: rowH, 'aria-hidden': true }, [
    current ? h('defs', { key: 'defs' }, h('mask', { id: maskId, maskUnits: 'userSpaceOnUse', x: 0, y: 0, width: w, height: rowH }, [
      h('rect', { key: 'area', x: 0, y: 0, width: w, height: rowH, fill: 'white' }),
      h('circle', { key: 'hole', cx: cx(row.lane), cy: mid, r: 6.2, fill: 'black' }),
    ])) : null,
    h('g', { key: 'edges', ...(current ? { mask: `url(#${maskId})` } : {}) }, edges),
    h('circle', {
      key: 'node', className: `gp-graph-node${current ? ' gp-graph-node--current' : ''}`,
      cx: cx(row.lane), cy: mid, r: current ? 5.2 : row.merge ? 4 : 3.2,
      fill: current ? 'none' : color,
      stroke: current ? color : 'var(--dsw-alias-bg-layer-1)', strokeWidth: current ? 2 : 1,
    }),
    current ? h('circle', {
      key: 'head-dot', className: 'gp-graph-node__dot',
      cx: cx(row.lane), cy: mid, r: 2.2, fill: color,
    }) : null,
  ])
}
