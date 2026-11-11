import React, { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { extensionOf, type Asset } from '../domain.js';
import { ui } from './i18n.js';
import { fitScale, formatBytes, nameOf, visibleRows, visibleSpan } from './model.js';
import { THUMB_LIMIT, useImage } from './thumbs.js';

/** A picture in a square box: small sprites are enlarged by whole pixels and stay sharp, large ones shrink to fit. */
export function Picture({ sessionId, asset, box, limit = THUMB_LIMIT }: { sessionId: string; asset: Asset; box: number; limit?: number }) {
  const url = useImage(sessionId, asset, limit), scale = fitScale(asset.width, asset.height, box);
  const crisp = scale !== undefined || (!!asset.width && Math.max(asset.width, asset.height ?? 0) <= box);
  if (!url) return <span className="ga-ph">{url === null ? extensionOf(asset.path).toUpperCase() : ''}</span>;
  return <img src={url} alt="" draggable={false} data-crisp={crisp || undefined} style={scale ? { width: asset.width! * scale, height: asset.height! * scale } : undefined} />;
}

interface CellProps { sessionId: string; asset: Asset; size: number; selected: boolean; checked: boolean; onSelect(path: string): void; onCheck(path: string, range: boolean): void }
/** One image. A click opens its detail; the box in its corner, or a click with Ctrl or ⌘ held, adds it to the selection. */
const Cell = memo(function Cell({ sessionId, asset, size, selected, checked, onSelect, onCheck }: CellProps) {
  return <div role="option" aria-selected={selected} className="ga-cell" data-usage={asset.retired ? 'retired' : asset.usage} data-checked={checked || undefined} title={asset.path}
    onClick={event => { if (event.metaKey || event.ctrlKey || event.shiftKey) onCheck(asset.path, event.shiftKey); else onSelect(asset.path); }}>
    <input type="checkbox" className="ga-check" checked={checked} aria-label={ui('Select {name}', { name: nameOf(asset.path) })}
      onClick={event => { event.stopPropagation(); onCheck(asset.path, event.shiftKey); }} onChange={() => {}} />
    <span className="ga-thumb" style={{ height: size }}><Picture sessionId={sessionId} asset={asset} box={size} /></span>
    <span className="ga-name">{nameOf(asset.path)}</span>
    <span className="ga-meta"><i className="ga-dot" />{asset.width ? `${asset.width}×${asset.height}` : formatBytes(asset.size)}{asset.dup !== undefined && <b className="ga-tag">{ui('copy')}</b>}
      {asset.tags?.length ? <b className="ga-tag" data-tone="tag" title={asset.tags.join(', ')}>{asset.tags[0]}{asset.tags.length > 1 ? ` +${asset.tags.length - 1}` : ''}</b> : null}</span>
  </div>;
});

/** Thumbnails of `items`, with only the rows on screen in the document. Arrow keys move the detail selection; Space checks it. */
export function Grid({ sessionId, items, size, selected, checked, onSelect, onCheck }: { sessionId: string; items: Asset[]; size: number; selected?: string; checked: ReadonlySet<string>; onSelect(path: string): void; onCheck(path: string, range: boolean): void }) {
  const ref = useRef<HTMLDivElement>(null), rowsRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800), [span, setSpan] = useState({ top: 0, height: 600 });
  /**
   * What is on screen is measured, not assumed: if something lets the grid grow instead of scrolling, the page around it
   * scrolls, and only the rows that page shows are drawn.
   */
  const measure = useCallback(() => {
    const grid = ref.current;
    if (!grid) return;
    setWidth(old => (grid.clientWidth || 800) === old ? old : grid.clientWidth || 800);
    const box = grid.getBoundingClientRect(), rows = rowsRef.current;
    // Without layout, as in a test, the grid's own numbers are all there is.
    const next = rows && box.height > 0 ? visibleSpan(box, rows.getBoundingClientRect(), window.innerHeight || box.bottom) : { top: grid.scrollTop, height: grid.clientHeight || 600 };
    setSpan(old => old.top === next.top && old.height === next.height ? old : next);
  }, []);
  const frame = useRef(0);
  const schedule = useCallback(() => {
    if (frame.current) return;
    const run = () => { frame.current = 0; measure(); };
    frame.current = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(run) : window.setTimeout(run, 16);
  }, [measure]);
  useLayoutEffect(() => {
    measure();
    // A scroll anywhere around the grid moves what it shows.
    document.addEventListener('scroll', schedule, { capture: true, passive: true });
    window.addEventListener('resize', schedule);
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(schedule);
    observer?.observe(ref.current!);
    return () => {
      document.removeEventListener('scroll', schedule, { capture: true });
      window.removeEventListener('resize', schedule);
      observer?.disconnect();
      if (frame.current) { (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : clearTimeout)(frame.current); frame.current = 0; }
    };
  }, [measure, schedule]);
  const rowHeight = size + 58, columns = Math.max(1, Math.floor((width - 16) / (size + 24)));
  useLayoutEffect(measure, [measure, items.length, columns, rowHeight]);
  const { rows, first, last } = visibleRows(items.length, columns, rowHeight, span.top, span.height);
  const selectedIndex = selected ? items.findIndex(asset => asset.path === selected) : -1;

  // A new list starts at its top; a selection made elsewhere, such as from the detail pane, is brought on screen.
  useEffect(() => {
    const element = ref.current!;
    if (selectedIndex < 0) { element.scrollTop = 0; measure(); return; }
    const top = Math.floor(selectedIndex / columns) * rowHeight + 8, height = element.clientHeight || span.height;
    if (top < element.scrollTop) element.scrollTop = top - 8;
    else if (top + rowHeight > element.scrollTop + height) element.scrollTop = top + rowHeight - height + 8;
    measure();
    // Scrolling follows the list and the selection, not every resize.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, selected]);

  const move = (event: React.KeyboardEvent) => {
    if (event.target instanceof HTMLInputElement) return;
    if (event.key === ' ' && selectedIndex >= 0) { event.preventDefault(); onCheck(items[selectedIndex].path, event.shiftKey); return; }
    const step = ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns } as Record<string, number>)[event.key];
    const target = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : step === undefined ? undefined : selectedIndex < 0 ? 0 : selectedIndex + step;
    if (target === undefined || !items.length) return;
    event.preventDefault();
    onSelect(items[Math.max(0, Math.min(items.length - 1, target))].path);
  };
  const visible: number[] = [];
  for (let row = first; row <= last; row++) visible.push(row);
  return <div className="ga-grid" ref={ref} role="listbox" tabIndex={0} aria-label={ui('Images')} onKeyDown={move}>
    {items.length ? <div className="ga-rows" ref={rowsRef} data-picking={checked.size > 0 || undefined} style={{ height: rows * rowHeight + 16 }}>
      {visible.map(row => <div key={row} className="ga-row" style={{ top: row * rowHeight + 8, height: rowHeight, gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
        {items.slice(row * columns, (row + 1) * columns).map(asset => <Cell key={asset.path} sessionId={sessionId} asset={asset} size={size} selected={asset.path === selected} checked={checked.has(asset.path)} onSelect={onSelect} onCheck={onCheck} />)}
      </div>)}
    </div> : <p className="ga-note">{ui('No images match.')}</p>}
  </div>;
}
