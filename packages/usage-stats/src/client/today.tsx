import React, { useEffect, useState } from 'react';
import type { Totals, UsageReport } from '../domain.js';
import { formatLocale, ui, useLocale } from './i18n.js';

const REFRESH_MS = 10_000;
const pad = (value: number) => String(value).padStart(2, '0');
/** Today in the viewer's time zone, not UTC like the dashboard's date presets. */
const localDay = (now: Date) => `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
const CSS = `.us-today{display:inline-flex;align-items:center;gap:6px;flex:none;height:22px;padding:0 9px;border:1px solid color-mix(in srgb,currentColor 14%,transparent);border-radius:999px;background:color-mix(in srgb,currentColor 5%,transparent);font-size:12px;line-height:1;white-space:nowrap;font-variant-numeric:tabular-nums;cursor:default;-webkit-app-region:no-drag}
.us-today i{width:7px;height:7px;border-radius:50%;background:#2fb47c;flex:none}
.us-today[data-stale] i{background:#a1a1aa}
.us-today sup{margin-left:-3px;font-size:10px;opacity:.75}`;

/** A compact pill with today's reported token total, at the right of the conversation header. */
export function TodayBadge() {
  useLocale();
  const [totals, setTotals] = useState<Totals | null>(null);
  const [stale, setStale] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const now = new Date(), day = localDay(now);
      const query = new URLSearchParams({ from: day, to: day, tz: String(-now.getTimezoneOffset()), groupBy: 'day' });
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
  }, []);
  if (!totals) return null;
  const value = new Intl.NumberFormat(formatLocale(), { notation: 'compact', maximumFractionDigits: 2 }).format(totals.totalTokens);
  const missing = totals.requests - totals.withUsage;
  const title = [ui("Today: {0} tokens in {1} requests", { 0: totals.totalTokens.toLocaleString(formatLocale()), 1: totals.requests.toLocaleString(formatLocale()) }),
    missing > 0 ? ui("* {0} requests returned no usage", { 0: missing.toLocaleString(formatLocale()) }) : '', stale ? ui("Could not refresh; showing the last value") : ''].filter(Boolean).join('\n');
  return <><style>{CSS}</style><span className="us-today" role="status" title={title} aria-label={title} data-stale={stale || undefined}>
    <i aria-hidden="true" />{ui("Today's usage")} {value}{missing > 0 && <sup aria-hidden="true">*</sup>}
  </span></>;
}
