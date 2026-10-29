import React, { useEffect, useState, type ComponentType } from 'react';
import type { Totals, UsageReport } from '../domain.js';
import { UsageDialog } from './dialog.js';
import { formatLocale, ui, useLocale } from './i18n.js';
import { compact, localDay, localOffset } from './metrics.js';
import { usePreferences } from './preferences.js';

const REFRESH_MS = 10_000;
// Sized like the header's other 24px controls: a hairline pill with a 12px label and a 6px state dot.
const CSS = `.us-today{display:inline-flex;align-items:center;gap:6px;flex:none;box-sizing:border-box;height:24px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l4,color-mix(in srgb,currentColor 16%,transparent));border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary,inherit);font:inherit;font-family:var(--dsw-font-family,inherit);font-size:12px;line-height:18px;white-space:nowrap;font-variant-numeric:tabular-nums;cursor:pointer;-webkit-app-region:no-drag}
.us-today:hover,.us-today[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,currentColor 8%,transparent));color:var(--dsw-alias-label-primary,inherit)}
.us-today:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4176e6));outline-offset:2px}
.us-today i{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary,#22a06b);flex:none}
.us-today[data-stale] i{background:var(--dsw-alias-label-tertiary,#a1a1aa)}
.us-today sup{margin-left:-3px;font-size:10px;opacity:.75}`;

/**
 * A compact pill with today's reported token total, at the right of the conversation header. Clicking it opens
 * `details`, the full dashboard, in a modal window. The Settings switch hides it and stops its refreshes.
 */
export function TodayBadge({ details }: { details?: ComponentType }) {
  useLocale();
  const { headerBadge } = usePreferences();
  const [totals, setTotals] = useState<Totals | null>(null);
  const [stale, setStale] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!headerBadge) { setOpen(false); return; }
    let alive = true;
    const load = async () => {
      const now = new Date(), day = localDay(now);
      const query = new URLSearchParams({ from: day, to: day, tz: localOffset(now), groupBy: 'day' });
      try {
        const response = await fetch(`/api/usage-stats?${query}`, { credentials: 'same-origin', cache: 'no-store' });
        if (!response.ok) throw new Error(String(response.status));
        const data = await response.json() as UsageReport;
        if (alive) { setTotals(data.totals); setStale(false); }
      } catch { if (alive) setStale(true); }
    };
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [headerBadge]);
  if (!headerBadge || !totals) return null;
  // K/M/B like the dashboard, such as 13M or 9.8M, in every language (Chinese compact notation would show 1304万); the tooltip has the exact count.
  const value = compact(totals.totalTokens);
  const missing = totals.requests - totals.withUsage;
  const title = [ui("Today: {0} tokens in {1} requests", { 0: totals.totalTokens.toLocaleString(formatLocale()), 1: totals.requests.toLocaleString(formatLocale()) }),
    missing > 0 ? ui("* {0} requests returned no usage", { 0: missing.toLocaleString(formatLocale()) }) : '', stale ? ui("Could not refresh; showing the last value") : ''].filter(Boolean).join('\n');
  return <><style>{CSS}</style><button type="button" className="us-today" title={title} aria-label={title} data-stale={stale || undefined}
    {...(details ? { 'aria-haspopup': 'dialog' as const, 'aria-expanded': open, onClick: () => setOpen(true) } : {})}>
    <i aria-hidden="true" />{value}{missing > 0 && <sup aria-hidden="true">*</sup>}
  </button>
    {open && details && <UsageDialog Details={details} onClose={() => setOpen(false)} />}
  </>;
}
