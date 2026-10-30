import React, { memo, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Commit } from '../domain.js';
import { ui } from './i18n.js';

export interface LayoutCommit extends Commit { row: number; lane: number }
/**
 * Lanes for `git log --date-order`, newest first, as gitk and GitLens draw them: from the oldest commit up, a commit takes
 * the lane of a child it is a parent of, else the first free lane.
 */
export function layoutGraph(commits: Commit[]): LayoutCommit[] {
  const lanes: (string | null)[] = [], placed = new Map<string, LayoutCommit>();
  for (let index = commits.length - 1; index >= 0; index--) {
    const commit = commits[index];
    let lane = lanes.findIndex(owner => owner !== null && commit.parents.includes(owner));
    if (lane < 0) { lane = lanes.indexOf(null); if (lane < 0) { lanes.push(null); lane = lanes.length - 1; } }
    placed.set(commit.sha, { ...commit, row: index, lane });
    lanes[lane] = commit.sha;
  }
  return commits.map(commit => placed.get(commit.sha)!);
}

const ROW = 24, LANE = 14, RADIUS = 4, PAD_LEFT = 10, PAD_TOP = 10, COLORS = 12, BUFFER = 10, BRANCH_COLUMN = 240;
const laneColor = (lane: number) => `var(--gv-lane-${lane % COLORS})`;
/** Approximate drawn width: CJK characters take about twice an ASCII character. */
const widthOf = (text: string) => [...text].reduce((w, ch) => w + (ch.charCodeAt(0) > 255 ? 12 : 6.5), 0);
function fit(text: string, max: number): string {
  let w = 0;
  for (let i = 0; i < text.length; i++) { w += text.charCodeAt(i) > 255 ? 12 : 6.5; if (w > max) return `${text.slice(0, i)}…`; }
  return text;
}
const saved = (key: string) => { try { const value = Number(localStorage.getItem(key)); return Number.isFinite(value) && value >= 4 ? value : 0; } catch { return 0; } };
const keep = (key: string, value: number) => { try { if (value) localStorage.setItem(key, String(value)); else localStorage.removeItem(key); } catch { /* storage unavailable: keep it in memory */ } };

interface SvgProps { layout: LayoutCommit[]; tips: Record<string, string>; current: string; textX: number; commitWidth: number; graphWidth: number; height: number; onSelect(commit: LayoutCommit): void }
/** The graph itself, drawn only around the visible rows; the SVG keeps its full height so scrolling stays exact. */
const GraphSvg = memo(function GraphSvg({ layout, tips, current, textX, commitWidth, graphWidth, height, onSelect }: SvgProps) {
  const svg = useRef<SVGSVGElement>(null);
  const [view, setView] = useState({ first: 0, last: Infinity });
  useLayoutEffect(() => {
    const root = svg.current, scroller = root?.closest<HTMLElement>('.gv-body');
    if (!root || !scroller) return;
    const measure = () => {
      const top = scroller.getBoundingClientRect().top - root.getBoundingClientRect().top;
      const first = Math.max(0, Math.floor((top - PAD_TOP) / ROW) - BUFFER), last = Math.min(layout.length - 1, Math.ceil((top + scroller.clientHeight - PAD_TOP) / ROW) + BUFFER);
      setView(previous => previous.first === first && previous.last === last ? previous : { first, last });
    };
    let raf = 0;
    const later = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; measure(); }); };
    measure();
    scroller.addEventListener('scroll', later, { passive: true });
    const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(later) : undefined;
    resize?.observe(scroller);
    return () => { scroller.removeEventListener('scroll', later); resize?.disconnect(); if (raf) cancelAnimationFrame(raf); };
  }, [layout]);
  const bySha = useMemo(() => new Map(layout.map(commit => [commit.sha, commit])), [layout]);
  // One label per row: the current branch first, then by name; a local branch and its remote often share a commit.
  const labels = useMemo(() => {
    const rows = new Map<number, string>();
    for (const [name, sha] of Object.entries(tips).sort(([a], [b]) => Number(b === current) - Number(a === current) || a.localeCompare(b))) {
      const commit = bySha.get(sha);
      if (commit && !rows.has(commit.row)) rows.set(commit.row, name);
    }
    return rows;
  }, [tips, bySha, current]);
  const tipShas = useMemo(() => new Set(Object.values(tips)), [tips]);
  const subjects = useMemo(() => new Map(layout.map(commit => [commit.sha, fit(commit.subject, commitWidth - 2)])), [layout, commitWidth]);
  const x = (lane: number) => PAD_LEFT + lane * LANE, y = (row: number) => PAD_TOP + row * ROW;
  const last = Math.min(view.last, layout.length - 1), visible = (row: number) => row >= view.first && row <= last;
  const edges: React.ReactElement[] = [], nodes: React.ReactElement[] = [];
  for (const commit of layout) {
    const parents = commit.parents.map(sha => bySha.get(sha)).filter((parent): parent is LayoutCommit => !!parent);
    // An edge crossing the visible area's edge is drawn while either end is visible.
    if (!visible(commit.row) && !parents.some(parent => visible(parent.row))) continue;
    const cx = x(commit.lane), cy = y(commit.row), color = laneColor(commit.lane);
    for (const parent of parents) {
      const px = x(parent.lane), py = y(parent.row), dy = Math.min(12, (py - cy) / 2);
      edges.push(parent.lane === commit.lane
        ? <line key={`${commit.sha}-${parent.sha}`} x1={cx} y1={cy} x2={px} y2={py} stroke={color} strokeWidth="1.2" opacity="0.85" />
        // Leaves the child and enters the parent vertically, as GitLens does.
        : <path key={`${commit.sha}-${parent.sha}`} d={`M ${cx} ${cy} C ${cx} ${cy + dy}, ${px} ${py - dy}, ${px} ${py}`} fill="none" stroke={color} strokeWidth="1.2" opacity="0.85" />);
    }
    if (!visible(commit.row)) continue;
    const tip = tipShas.has(commit.sha), currentTip = tips[current] === commit.sha;
    nodes.push(<g key={commit.sha} onClick={() => onSelect(commit)}>
      <circle cx={cx} cy={cy} r={RADIUS + 2} fill="transparent" />
      <circle cx={cx} cy={cy} r={RADIUS} fill={currentTip ? 'var(--gv-ok)' : color} stroke={tip ? 'var(--gv-pop)' : 'none'} strokeWidth={tip ? 1.5 : 0} />
      <text x={textX} y={cy + 3.5} fontSize="12" fill="var(--gv-fg)" style={{ pointerEvents: 'none' }}>{subjects.get(commit.sha)}</text>
    </g>);
  }
  return <svg ref={svg} width={graphWidth} height={height}>
    {edges}{nodes}
    {[...labels].filter(([row]) => visible(row)).map(([row, name]) =>
      <text key={`tip-${row}`} x={graphWidth - 4} y={y(row) + 4} fontSize="11" textAnchor="end" fontWeight={name === current ? 700 : 400} fill={name === current ? 'var(--gv-ok)' : 'var(--gv-muted)'}>
        {fit(name, BRANCH_COLUMN - 6)}</text>)}
  </svg>;
});

/**
 * The commit graph: lanes, commit subjects and branch labels in three columns. Dragging the commit column's edges
 * resizes it, double-clicking resets it, and the widths are remembered in this browser. A commit's details offer
 * cherry-pick and revert.
 */
export const Graph = memo(function Graph({ commits, tips, current, width, busy, onCherryPick, onRevert }: {
  commits: Commit[]; tips: Record<string, string>; current: string; width: number; busy: boolean; onCherryPick(sha: string): void; onRevert(sha: string): void;
}) {
  const layout = useMemo(() => layoutGraph(commits), [commits]);
  const [selected, setSelected] = useState<LayoutCommit>();
  const [commitOverride, setCommitOverride] = useState(() => saved('git-view.graph.commit')), [gapOverride, setGapOverride] = useState(() => saved('git-view.graph.gap'));
  const lanes = Math.max(1, ...layout.map(commit => commit.lane + 1)), laneRight = PAD_LEFT + lanes * LANE;
  const gap = gapOverride || 14, textX = laneRight + gap;
  const commitWidth = commitOverride || Math.max(60, Math.max(0, ...layout.map(commit => widthOf(commit.subject))) + 16), commitRight = textX + commitWidth;
  const graphWidth = Math.max(width - 16, commitRight + BRANCH_COLUMN + 8), height = PAD_TOP + layout.length * ROW + 12;
  const latest = useRef({ commitOverride, gapOverride });
  latest.current = { commitOverride, gapOverride };
  /** `move` turns the pointer's travel into the new widths; they are remembered when the drag ends. */
  const drag = (move: (dx: number) => void) => (event: React.PointerEvent) => {
    event.preventDefault(); event.stopPropagation();
    const start = event.clientX, onMove = (e: PointerEvent) => move(e.clientX - start);
    const onUp = () => {
      window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp);
      keep('git-view.graph.commit', latest.current.commitOverride); keep('git-view.graph.gap', latest.current.gapOverride);
    };
    window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp);
  };
  // The right edge resizes the commit column; the left edge moves its start and keeps its end.
  const right = drag(dx => setCommitOverride(Math.min(900, Math.max(60, commitWidth + dx))));
  const left = drag(dx => {
    const next = Math.min(Math.max(4, commitRight - laneRight - 60), Math.max(4, commitRight - laneRight - 900, gap + dx));
    setGapOverride(next); setCommitOverride(commitRight - (laneRight + next));
  });
  const reset = () => { setCommitOverride(0); setGapOverride(0); keep('git-view.graph.commit', 0); keep('git-view.graph.gap', 0); };
  if (!commits.length) return <p className="gv-empty">{ui('No commits yet')}</p>;
  return <div className="gv-graph">
    <div className="gv-graph-head" style={{ width: graphWidth }}>
      <span style={{ left: PAD_LEFT }}>{ui('Lanes')}</span>
      {lanes >= 2 && <div className="gv-resize" title={ui('Drag to resize · double-click to reset')} style={{ left: textX - 10 }} onPointerDown={left} onDoubleClick={reset} />}
      <span style={{ left: textX }}>{ui('Commit')}</span>
      <div className="gv-resize" title={ui('Drag to resize · double-click to reset')} style={{ left: commitRight - 3 }} onPointerDown={right} onDoubleClick={reset} />
      <span style={{ left: graphWidth - BRANCH_COLUMN }}>{ui('Branch')}</span>
    </div>
    <GraphSvg layout={layout} tips={tips} current={current} textX={textX} commitWidth={commitWidth} graphWidth={graphWidth} height={height} onSelect={setSelected} />
    {selected && <div className="gv-detail" role="region" aria-label={ui('Commit details')}>
      <p><b>{selected.subject}</b></p>
      <p>{selected.sha} · {selected.author} · {selected.date}</p>
      <div className="gv-row">
        <button type="button" className="gv-btn" disabled={busy} onClick={() => onCherryPick(selected.sha)}>{ui('Cherry-pick onto the current branch')}</button>
        <button type="button" className="gv-btn" disabled={busy} onClick={() => onRevert(selected.sha)}>{ui('Revert this commit')}</button>
        <button type="button" className="gv-btn" aria-label={ui('Close')} onClick={() => setSelected(undefined)}>×</button>
      </div>
    </div>}
  </div>;
});
