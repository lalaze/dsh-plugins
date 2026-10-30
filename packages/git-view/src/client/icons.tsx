import React from 'react';

/** One 16×16 set with one stroke width, after dsh-git-panel's, so every button reads the same in both themes. */
const SHAPES = {
  refresh: ['M13.2 8a5.2 5.2 0 1 1-1.5-3.7', 'M13.4 2.6v2.9h-2.9'],
  file: ['M4.2 1.8h4.3L12 5.3v8.9H4.2z', 'M8.4 1.8v3.6H12'],
  split: ['M3.6 3.2h8.8a1.4 1.4 0 0 1 1.4 1.4v6.8a1.4 1.4 0 0 1-1.4 1.4H3.6a1.4 1.4 0 0 1-1.4-1.4V4.6a1.4 1.4 0 0 1 1.4-1.4z', 'M8 3.2v9.6'],
  unified: ['M3 4.6h10M3 8h10M3 11.4h5.5'],
  edit: ['M10.9 2.4l2.7 2.7-7.2 7.2H3.7v-2.7z', 'M9.6 3.7l2.7 2.7'],
  conflict: ['M8 2.4l5.7 10.2H2.3z', 'M8 6.4v3.1M8 11.4h.01'],
  wrap: ['M3 4.4h10M3 11.6h4M3 8h7.2a2 2 0 010 4H8.4', 'M9.6 10.4L8.2 12l1.4 1.6'],
  fold: ['M4.4 6.2L8 2.9l3.6 3.3M4.4 9.8L8 13.1l3.6-3.3'],
  code: ['M5.9 4.2L2.4 8l3.5 3.8M10.1 4.2L13.6 8l-3.5 3.8'],
  plus: ['M8 3.2v9.6M3.2 8h9.6'],
  minus: ['M3.4 8h9.2'],
  save: ['M8 2.6v6.4M5.2 6.4L8 9.2l2.8-2.8M3.4 13h9.2'],
  check: ['M3.4 8.4l3 3 6.2-6.8'],
  close: ['M4.4 4.4l7.2 7.2M11.6 4.4l-7.2 7.2'],
  copy: ['M6.9 5.4h5.2a1.5 1.5 0 0 1 1.5 1.5v5.2a1.5 1.5 0 0 1-1.5 1.5H6.9a1.5 1.5 0 0 1-1.5-1.5V6.9a1.5 1.5 0 0 1 1.5-1.5z', 'M10.6 3.6V3a1.4 1.4 0 0 0-1.4-1.4H3.6A1.4 1.4 0 0 0 2.2 3v5.6a1.4 1.4 0 0 0 1.4 1.4h.4'],
  chat: ['M13.4 9.4a2.4 2.4 0 0 1-2.4 2.4H6.2L2.6 14.4V4.6a2.4 2.4 0 0 1 2.4-2.4h6a2.4 2.4 0 0 1 2.4 2.4z'],
  undo: ['M3.2 8h7a2.8 2.8 0 0 1 0 5.6H7.4', 'M3.2 8l2.8-2.8M3.2 8l2.8 2.8'],
  arrowUp: ['M8 12.8V3.2M4.6 6.6L8 3.2l3.4 3.4'],
  arrowDown: ['M8 3.2v9.6M4.6 9.4L8 12.8l3.4-3.4'],
  fetch: ['M4.6 11.4a2.8 2.8 0 0 1-.3-5.6 3.6 3.6 0 0 1 7-1 2.6 2.6 0 0 1 .3 5.2', 'M8 8.4v3.6M6.4 10.6L8 12.4l1.6-1.8'],
  key: ['M5.6 8a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 1 0 0-4.8z', 'M7.4 8.6l5-5M10.4 5.6l1.6 1.6M12 4l1.4 1.4'],
  bulb: ['M8 2.6a3.6 3.6 0 0 0-2.1 6.5c.4.3.6.8.6 1.3v.4h3v-.4c0-.5.2-1 .6-1.3A3.6 3.6 0 0 0 8 2.6z', 'M6.6 12.6h2.8'],
  branch: ['M4.6 2.4a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 1 0 0-3.2zM4.6 10.4a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 1 0 0-3.2zM11.4 4.8a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 1 0 0-3.2z', 'M4.6 5.6v4.8M11.4 8c0 2.2-2 3.2-4.6 3.4'],
  both: ['M4 3.4h2.2a2.4 2.4 0 0 1 2.4 2.4v4.4a2.4 2.4 0 0 0 2.4 2.4H13', 'M4 12.6h2.2a2.4 2.4 0 0 0 2.4-2.4'],
  server: ['M3 4.5h10v3H3zM3 8.5h10v3H3zM5 6h.01M5 10h.01'],
  external: ['M9.4 2.6h4v4', 'M13.4 2.6L7.6 8.4', 'M12 10v2.6a1.4 1.4 0 0 1-1.4 1.4H3.4A1.4 1.4 0 0 1 2 12.6V5.4A1.4 1.4 0 0 1 3.4 4H6'],
} as const;
export type IconName = keyof typeof SHAPES;
export const Icon = ({ name, size = 14 }: { name: IconName; size?: number }) =>
  <svg className="gv-icon" viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {SHAPES[name].map((d, i) => <path key={i} d={d} />)}
  </svg>;
/** The guide entry's artwork, at the size and in the color of DSH's own entries. */
export const GitArtwork = ({ size = 26, className }: { size?: number; className?: string }) =>
  <svg width={size} height={size} className={className} viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="9" cy="7" r="2.6" /><circle cx="9" cy="21" r="2.6" /><circle cx="19" cy="14" r="2.6" /><path d="M9 9.6v8.8M9 14h7.4" />
  </svg>;
