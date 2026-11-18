import React, { useEffect, useState, type ComponentType } from 'react';
import type { MachineUsage, UsageReport } from '../domain.js';
import { UsageDialog } from './dialog.js';
import { formatLocale, ui, useLocale } from './i18n.js';
import { compact, localDay, localOffset } from './metrics.js';
import { usePreferences } from './preferences.js';

const REFRESH_MS = 10_000;
/**
 * Machines that are online but did not answer, one line each: their usage is missing from the total. An offline machine
 * is not one of them (it is listed under Data sources): it uses nothing while off, and its last answer stands in when
 * there is one.
 */
export function machineNotes(machines: readonly MachineUsage[]): string[] {
  return machines.flatMap(machine => machine.state === 'failed' ? [ui("{0} did not answer; its usage is not included", { 0: machine.name })] : []);
}
// Sized like the header's other 24px controls: a hairline pill with a 12px label and a 6px state dot.
const CSS = `.us-today{display:inline-flex;align-items:center;gap:6px;flex:none;box-sizing:border-box;height:24px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l4,color-mix(in srgb,currentColor 16%,transparent));border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary,inherit);font:inherit;font-family:var(--dsw-font-family,inherit);font-size:12px;line-height:18px;white-space:nowrap;font-variant-numeric:tabular-nums;cursor:pointer;-webkit-app-region:no-drag}
.us-today:hover,.us-today[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,currentColor 8%,transparent));color:var(--dsw-alias-label-primary,inherit)}
.us-today:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4176e6));outline-offset:2px}
.us-today i{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary,#22a06b);flex:none}
.us-today[data-stale] i{background:var(--dsw-alias-label-tertiary,#a1a1aa)}
.us-today sup{margin-left:-3px;font-size:10px;opacity:.75}`;

/**
 * A compact pill with today's reported token total over every machine DSH Link reaches, at the right of the
 * conversation header. Clicking it opens `details`, the full dashboard, in a modal window. The Settings switch hides it
 * and stops its refreshes.
 */
export function TodayBadge({ details }: { details?: ComponentType }) {
  const language = useLocale();
  const { headerBadge } = usePreferences();
  const [data, setData] = useState<UsageReport | null>(null);
  const [stale, setStale] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!headerBadge) { setOpen(false); return; }
    let alive = true;
    const load = async () => {
      const now = new Date(), day = localDay(now);
      const query = new URLSearchParams({ from: day, to: day, tz: localOffset(now), groupBy: 'day', machines: 'all' });
      try {
        const response = await fetch(`/api/usage-stats?${query}`, { credentials: 'same-origin', cache: 'no-store' });
        if (!response.ok) throw new Error(String(response.status));
        const data = await response.json() as UsageReport;
        if (alive) { setData(data); setStale(false); }
      } catch { if (alive) setStale(true); }
    };
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [headerBadge]);
  if (!headerBadge || !data) return null;
  const totals = data.totals, number = (value: number) => value.toLocaleString(formatLocale());
  // As on the dashboard: 13M or 9.8M, and in Chinese 1.13亿 from 1亿 up; the tooltip has the exact count.
  const value = compact(totals.totalTokens, language);
  const missing = totals.requests - totals.withUsage;
  // Several machines: each one's share, and the ones whose usage is not in the total.
  const counted = (data.machines ?? []).filter(machine => machine.state === 'counted');
  const notes = machineNotes(data.machines ?? []);
  const botTotals = data.sources.find(source => source.key === 'mausbot')?.totals;
  const dshTokens = totals.totalTokens - (botTotals?.totalTokens ?? 0);
  const dshRequests = totals.requests - (botTotals?.requests ?? 0);
  const title = [ui(counted.length > 1 ? "Today, {2} machines: {0} tokens in {1} requests" : "Today: {0} tokens in {1} requests", { 0: number(totals.totalTokens), 1: number(totals.requests), 2: counted.length }),
    ...(botTotals ? [
      `${ui("DSH & remote")}  ${compact(dshTokens, language, totals.totalTokens)} (${ui("{0} requests", { 0: number(dshRequests) })})`,
      `MausBot  ${compact(botTotals.totalTokens, language, totals.totalTokens)} (${ui("{0} requests", { 0: number(botTotals.requests) })})`,
    ] : []),
    ...(counted.length > 1 ? counted.map(machine => `${machine.name}  ${compact(machine.totals?.totalTokens ?? 0, language, totals.totalTokens)}${machine.stale ? `  ${ui("(as of {0})", { 0: new Date(machine.asOf!).toLocaleTimeString(formatLocale(), { hour: '2-digit', minute: '2-digit' }) })}` : ''}`) : []),
    ...notes.map(note => `* ${note}`),
    missing > 0 ? ui("* {0} requests returned no usage", { 0: number(missing) }) : '', stale ? ui("Could not refresh; showing the last value") : ''].filter(Boolean).join('\n');
  return <><style>{CSS}</style><button type="button" className="us-today" title={title} aria-label={title} data-stale={stale || undefined}
    {...(details ? { 'aria-haspopup': 'dialog' as const, 'aria-expanded': open, onClick: () => setOpen(true) } : {})}>
    <i aria-hidden="true" />{value}{(missing > 0 || notes.length > 0) && <sup aria-hidden="true">*</sup>}
  </button>
    {open && details && <UsageDialog Details={details} onClose={() => setOpen(false)} />}
  </>;
}
