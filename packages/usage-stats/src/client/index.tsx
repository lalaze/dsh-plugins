import type { LocaleContext } from '@dsh-plugins/i18n';
import { ui, installLocale, useLocale, formatLocale } from './i18n.js';
import React, { useEffect, useRef, useState } from 'react';
import type { Dimension, UsageReport, Totals } from '../domain.js';
import { compact, dateRange, localOffset, trendBuckets } from './metrics.js';
import { styles } from './styles.js';
import { TodayBadge } from './today.js';
import { UsageSettings } from './settings.js';

interface Client extends LocaleContext {
  effect(factory: () => () => void): void;
  slots: { inject(name: string, factory: () => unknown): unknown; register(spec: Record<string, unknown>, component: React.FC): unknown };
}
const number = (value: number) => value.toLocaleString(formatLocale());
const percent = (value: number, total: number) => total ? `${(value / total * 100).toFixed(1)}%` : '—';
const shortDate = (value: string) => value.slice(5).replace('-', '/');
/** The viewer's IANA zone, the one the date presets and the API's `tz` follow. */
const timeZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ui("Local time"); } catch { return ui("Local time"); } };
function Icon({ kind = 'chart' }: { kind?: 'chart' | 'download' | 'refresh' }) {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{kind === 'chart' ? <><path d="M4 19h16M7 15V9m5 6V5m5 10v-4" /></> : kind === 'download' ? <><path d="M12 3v12m-4-4 4 4 4-4M5 16v4h14v-4" /></> : <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6.2 6.2A8 8 0 0 1 20 12M4 12a8 8 0 0 0 13.8 5.8" /></>}</svg>;
}
/** The expand marker of a breakdown row or the data sources: a chevron that turns down when open. */
function Chevron({ open }: { open: boolean }) {
  return <svg className="us-chevron" data-open={open || undefined} width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 4l4 4-4 4" /></svg>;
}
/** A row of choices: full-width equal tabs for the time range, a compact control for the category. */
function Tabs<T extends string>({ label, value, options, onChange, compact }: { label: string; value: T; options: readonly (readonly [T, string])[]; onChange: (value: T) => void; compact?: boolean }) {
  return <div className={compact ? 'us-segment' : 'us-tabs'} role="group" aria-label={label}>{options.map(([key, text]) => <button key={key} type="button" aria-pressed={value === key} onClick={() => onChange(key)}>{ui(text)}</button>)}</div>;
}
function Trend({ data }: { data: UsageReport }) {
  const [metric, setMetric] = useState<'tokens' | 'requests'>('tokens');
  const [hovered, setHovered] = useState<number>();
  const buckets = trendBuckets(data.series ?? [], data.query.from, data.query.to);
  // A single day is already the headline total.
  if (buckets.length < 2) return null;
  const max = Math.max(1, ...buckets.map(b => b[metric]));
  const selected = hovered === undefined ? undefined : buckets[hovered];
  const total = metric === 'tokens' ? data.totals.totalTokens : data.totals.requests;
  return <section className="us-panel" aria-label={ui("Usage trend")}>
    <div className="us-panel-head"><div><h3>{ui("Usage trend")}</h3><p className="us-subtitle">{buckets[0].from !== buckets[0].to ? ui("Grouped by time period") : ui("Daily usage")} · {ui("Local time")}</p></div><div className="us-segment" role="group" aria-label={ui("Trend metric")}>{(['tokens', 'requests'] as const).map(value => <button key={value} aria-pressed={metric === value} onClick={() => { setMetric(value); setHovered(undefined); }}>{value === 'tokens' ? 'Token' : ui("Requests")}</button>)}</div></div>
    <div className="us-chart">
      <div className="us-chart-readout" aria-live="polite"><span>{selected ? `${selected.from}${selected.to !== selected.from ? ` → ${selected.to}` : ''}` : ui("Selected period")}</span><span className="us-number">{number(selected ? selected[metric] : total)} {metric === 'tokens' ? 'Token' : ui("requests")}</span></div>
      <div className="us-chart-body"><div className="us-y-axis" aria-hidden="true"><span>{compact(max)}</span><span>{compact(max / 2)}</span><span>0</span></div><div className="us-plot"><div className="us-grid" aria-hidden="true"><span /><span /><span /></div><div className="us-bars" role="group" aria-label={ui("Daily usage trend")}>{buckets.map((b, i) => <button key={b.from} className="us-bar-hit" aria-label={`${b.from}${b.from !== b.to ? ui(" to {0}", { 0: b.to }) : ''}: ${number(b[metric])} ${metric === 'tokens' ? 'Token' : ui("requests")}`} aria-pressed={hovered === i} onMouseEnter={() => setHovered(i)} onMouseLeave={() => setHovered(undefined)} onFocus={() => setHovered(i)} onBlur={() => setHovered(undefined)} onClick={() => setHovered(i)}><span className="us-bar" style={{ height: `${b[metric] ? Math.max(1.5, b[metric] / max * 100) : 0}%` }} /></button>)}</div></div></div>
      <div className="us-x-axis" aria-hidden="true"><span>{shortDate(buckets[0].from)}</span>{buckets.length > 3 && <span>{shortDate(buckets[Math.floor(buckets.length / 2)].from)}</span>}<span>{shortDate(buckets.at(-1)!.to)}</span></div>
    </div>
  </section>;
}
function Status({ totals: t }: { totals: Totals }) {
  return t.errors || t.cancelled ? <span className="us-badge us-error">{t.errors ? ui("{0} failed", { 0: number(t.errors) }) : ''}{t.errors && t.cancelled ? ' · ' : ''}{t.cancelled ? ui("{0} cancelled", { 0: number(t.cancelled) }) : ''}</span> : <span className="us-badge">{ui("Completed")}</span>;
}
/** Data problems that make the totals partial: unsaved records and requests that returned no usage. */
function attention(data: UsageReport): string[] {
  const missing = data.totals.requests - data.totals.withUsage;
  return [data.failedWrites > 0 ? ui("{0} records could not be saved. Statistics may be incomplete. Check DSH logs and disk permissions.", { 0: number(data.failedWrites) }) : '',
    missing > 0 ? ui("{0} requests returned no usage. Token totals only include reported data.", { 0: number(missing) }) : ''].filter(Boolean);
}
/** The period's total in large type, its request count, then input and output; the exact total is in the tooltip. */
function Headline({ data, onPartial }: { data: UsageReport; onPartial: () => void }) {
  const t = data.totals, notes = attention(data);
  const input = t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens;
  return <article className="us-hero" aria-label={ui("Recorded usage")}>
    <div className="us-hero-head"><span>{ui("Recorded usage")}</span>{notes.length > 0 && <button type="button" className="us-partial" title={notes.join('\n')} onClick={onPartial}>{ui("Partial records")}</button>}</div>
    <div className="us-hero-total"><strong className="us-number" title={number(t.totalTokens)}>{compact(t.totalTokens)}</strong><span>{ui("tokens")}</span></div>
    <p className="us-hero-exact us-number">{ui("{0} requests", { 0: number(t.requests) })}</p>
    <div className="us-hero-split">
      <div><span>{ui("Input · incl. cache")}</span><b className="us-number" title={number(input)}>{compact(input)}</b><small>{ui("Cache reads {0} · {1} of input", { 0: compact(t.cacheReadTokens), 1: t.withUsage ? percent(t.cacheReadTokens, input) : '—' })}</small></div>
      <div><span>{ui("Output · incl. reasoning")}</span><b className="us-number" title={number(t.outputTokens)}>{compact(t.outputTokens)}</b>{t.reasoningTokens > 0 && <small>{ui("Reasoning {0}", { 0: compact(t.reasoningTokens) })}</small>}</div>
    </div>
  </article>;
}
/** The dashboard's time ranges and categories; the selected category drives the breakdown and the CSV export. */
type Period = 'today' | '7d' | '30d' | 'all' | 'custom';
const PERIODS = [['today', "Today"], ['7d', "Last 7 days"], ['30d', "Last 30 days"], ['all', "All"], ['custom', "Custom"]] as const;
const BREAKDOWNS = [['provider', "By provider"], ['workspace', "By workspace"], ['model', "By model"], ['vendor', "By model vendor"], ['host', "By host"]] as const;
const BREAKDOWN_ROWS = 8;
/** Long workspace paths keep their last two folders; the full path is in the tooltip. */
const shortPath = (path: string) => { const parts = path.split(/[\\/]/).filter(Boolean); return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : path; };
/**
 * A group's shown name and full tooltip; placeholder keys (empty or `?`) are translated. A DSH workspace shows its name
 * as the sidebar does; a directory outside every workspace shows its last folders.
 */
const groupName = (g: { key: string; label: string }, by: Dimension) => {
  const placeholder = g.key === '' || g.key === '?', named = by === 'workspace' && g.key.startsWith('workspace:');
  return { name: placeholder ? ui(g.label) : by === 'workspace' && !named ? shortPath(g.label) : g.label, title: placeholder ? ui(g.label) : g.label };
};
/** The selected category's groups, largest first; a row expands into its request, token and status details. */
function Breakdown({ data, by }: { data: UsageReport; by: Dimension }) {
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => { setAll(false); setOpen(new Set()); }, [by]);
  const rows = data.breakdowns?.[by] ?? [], total = data.totals.totalTokens;
  if (!rows.length) return <div className="us-empty" role="status"><Icon /><h3>{ui("No matching records")}</h3><p>{ui("Usage appears here after a model or remote agent request completes.")}</p></div>;
  const toggle = (key: string) => setOpen(previous => { const next = new Set(previous); if (!next.delete(key)) next.add(key); return next; });
  return <section className="us-breakdown" aria-label={ui("Usage breakdown")}>
    <ol>{(all ? rows : rows.slice(0, BREAKDOWN_ROWS)).map(g => {
      const { name, title } = groupName(g, by), expanded = open.has(g.key), t = g.totals;
      return <li key={g.key}>
        <button type="button" className="us-row" aria-expanded={expanded} onClick={() => toggle(g.key)}><span className="us-row-name" title={title}>{name}</span><b className="us-number" title={number(t.totalTokens)}>{compact(t.totalTokens)}</b><span className="us-row-share us-number">{percent(t.totalTokens, total)}</span><Chevron open={expanded} />
          <span className="us-meter" aria-hidden="true"><span style={{ width: `${total ? t.totalTokens / total * 100 : 0}%` }} /></span></button>
        {expanded && <dl className="us-row-detail">
          <div><dt>{ui("Requests")}</dt><dd>{number(t.requests)}<small>{ui("Usage reported {0}/{1}", { 0: number(t.withUsage), 1: number(t.requests) })}</small></dd></div>
          <div><dt>{ui("Input · Uncached")}</dt><dd>{number(t.inputTokens)}</dd></div>
          <div><dt>{ui("Output tokens")}</dt><dd>{number(t.outputTokens)}</dd></div>
          <div><dt>{ui("Cache read / write")}</dt><dd>{number(t.cacheReadTokens)} / {number(t.cacheWriteTokens)}</dd></div>
          <div><dt>{ui("Total tokens")}</dt><dd>{number(t.totalTokens)}</dd></div>
          <div><dt>{ui("Status")}</dt><dd><Status totals={t} /></dd></div>
        </dl>}
      </li>;
    })}</ol>
    {rows.length > BREAKDOWN_ROWS && <button type="button" className="us-link us-more" onClick={() => setAll(!all)}>{all ? ui("Show fewer") : ui("Show all {0}", { 0: number(rows.length) })}</button>}
  </section>;
}
/** DSH model calls and remote agents with their totals; the details hold what needs attention and how usage is counted. */
function Sources({ data, open, onToggle, anchor }: { data: UsageReport; open: boolean; onToggle: () => void; anchor: React.RefObject<HTMLElement> }) {
  const t = data.totals, notes = attention(data);
  return <section ref={anchor} className="us-sources" aria-label={ui("Data sources")}>
    <button type="button" className="us-sources-head" aria-expanded={open} onClick={onToggle}><span className="us-sources-title">{ui("Data sources")}</span>
      <span className="us-sources-status">{notes.length ? <><i className="us-dot us-warn" />{ui("{0} need attention", { 0: notes.length })}</> : ui("Measurement and scope")}</span><Chevron open={open} /></button>
    <ul className="us-source-list">{data.sources.map(s => <li key={s.key}><div><span>{ui(s.label)}</span><small>{ui("{0} requests", { 0: number(s.totals.requests) })} · {ui("Usage reported {0}/{1}", { 0: number(s.totals.withUsage), 1: number(s.totals.requests) })}</small></div><b className="us-number" title={number(s.totals.totalTokens)}>{compact(s.totals.totalTokens)}</b></li>)}</ul>
    {open && <div className="us-sources-detail">
      {notes.map(note => <p key={note} className="us-notice us-warning">{note}</p>)}
      <p>{ui("Completion rate")} {percent(t.completed, t.requests)} · {ui("Failed {0} · Cancelled {1}", { 0: number(t.errors), 1: number(t.cancelled) })}</p>
      <p>{ui("Dates use your local time zone and the request start time. Input excludes cache tokens; cache reads and writes are counted separately. Cache read share = cache reads ÷ (uncached input + cache reads + cache writes). Reasoning tokens")} {number(t.reasoningTokens)} {ui("are included in output. Only calls from this DSH instance are tracked, including titles and compaction. Remote agents are counted once per remote turn; independently running CLIs are excluded. Missing usage is not estimated. First record:")} {data.recordedSince ? new Date(data.recordedSince).toLocaleString(formatLocale()) : ui("None yet")}.</p>
      <p>{ui("Only calls from this DSH instance are recorded, on this computer. Nothing is uploaded.")}</p>
    </div>}
  </section>;
}
export function Dashboard() {
  useLocale();
  const [groupBy, setGroupBy] = useState<Dimension>('provider');
  // Opens on today, the total the header pill shows.
  const [from, setFrom] = useState(() => dateRange('today').from); const [to, setTo] = useState(() => dateRange('today').to);
  const [period, setPeriod] = useState<Period>('today');
  const [provider, setProvider] = useState(''); const [model, setModel] = useState(''); const [sessionId, setSessionId] = useState('');
  const [data, setData] = useState<UsageReport>(); const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0); const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false); const [exportError, setExportError] = useState('');
  const [sourcesOpen, setSourcesOpen] = useState(false); const sources = useRef<HTMLElement>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const params = new URLSearchParams();
  // Days follow the viewer's time zone, like the header pill.
  for (const [key, value] of Object.entries({ from, to, provider, model, sessionId, tz: localOffset() })) if (value) params.set(key, value);
  // Every category's groups arrive in one report, so switching categories needs no new request.
  const path = `/api/usage-stats?${params}`;
  const exportCsv = async () => {
    setExporting(true); setExportError('');
    try {
      const response = await fetch(`/api/usage-stats?${new URLSearchParams([...params, ['groupBy', groupBy], ['format', 'csv']])}`, { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) throw new Error(`Export failed ${response.status}`);
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'dsh-usage.csv';
      document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { setExportError(e instanceof Error ? e.message : String(e)); }
    finally { setExporting(false); }
  };
  useEffect(() => {
    const controller = new AbortController(); let pending = false;
    setData(undefined); setLoading(true); setError('');
    const read = async () => {
      if (period !== 'custom') {
        const range = dateRange(period);
        if (from !== range.from || to !== range.to) {
          setFrom(range.from); setTo(range.to);
          return; // The updated path starts a fresh read and aborts the old one.
        }
      }
      if (pending) return;
      pending = true;
      try {
        const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || `Request failed ${response.status}`);
        if (!controller.signal.aborted) { setData(body); setError(''); }
      } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e)); }
      finally { pending = false; if (!controller.signal.aborted) setLoading(false); }
    };
    void read(); const timer = setInterval(() => { if (!document.hidden) void read(); }, 5000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [path, refresh, period]);
  const choosePeriod = (value: Period) => {
    setPeriod(value);
    if (value !== 'custom') { const range = dateRange(value); setFrom(range.from); setTo(range.to); }
  };
  const reset = () => { setProvider(''); setModel(''); setSessionId(''); choosePeriod('today'); };
  const showAttention = () => { setSourcesOpen(true); requestAnimationFrame(() => sources.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })); };
  const filterCount = [provider, model, sessionId].filter(Boolean).length;
  const select = (label: string, value: string, set: (value: string) => void, options: string[]) => <label className="us-field">{label}<select aria-label={label} value={value} onChange={e => set(e.target.value)}><option value="">{ui("All {0}", { 0: label })}</option>{options.map(v => <option key={v} value={v}>{v}</option>)}</select></label>;
  const range = from && from === to ? from : from || to ? `${from || ui("First record")} → ${to || ui("Latest record")}` : ui("All records");
  return <section className="dsh-usage" aria-label={ui("Usage statistics")}><style>{styles}</style>
    <header className="us-top"><div className="us-title"><h2>{ui("Usage statistics")}</h2><p className="us-subtitle">{data ? ui("Updated {0}", { 0: new Date(data.generatedAt).toLocaleTimeString(formatLocale()) }) + ' · ' : ''}{ui("Updates every 5 seconds")}</p></div>
      <div className="us-actions"><button type="button" className="us-link" onClick={() => setRefresh(n => n + 1)}><Icon kind="refresh" />{ui("Refresh")}</button><button type="button" className="us-link" disabled={exporting} onClick={() => void exportCsv()}><Icon kind="download" />{exporting ? ui("Exporting…") : ui("Export CSV")}</button></div></header>
    <Tabs label={ui("Time range")} value={period} options={PERIODS} onChange={choosePeriod} />
    {period === 'custom' && <div className="us-custom-dates"><label className="us-field">{ui("Start date")}<input aria-label={ui("Start date")} type="date" value={from} onChange={e => setFrom(e.target.value)} /></label><span className="us-muted">—</span><label className="us-field">{ui("End date")}<input aria-label={ui("End date")} type="date" value={to} onChange={e => setTo(e.target.value)} /></label></div>}
    <div className="us-filter-row"><button type="button" className="us-filters" aria-expanded={filtersOpen} onClick={() => setFiltersOpen(!filtersOpen)}><Chevron open={filtersOpen} />{ui("More filters")}{filterCount ? ui(" · {0} applied", { 0: filterCount }) : ui(" · Provider, model, session")}</button>
      <span className="us-range us-number">{range} · {timeZone()}</span>
      {(filterCount > 0 || period === 'custom') && <button type="button" className="us-link" onClick={reset}>{ui("Reset filters")}</button>}</div>
    {filtersOpen && <div className="us-filter-grid">{select(ui("Provider"), provider, setProvider, data?.filters.providers ?? (provider ? [provider] : []))}{select(ui("Model"), model, setModel, data?.filters.models ?? (model ? [model] : []))}<label className="us-field">{ui("Session ID")}<input aria-label={ui("Session ID")} value={sessionId} onChange={e => setSessionId(e.target.value)} placeholder={ui("Filter by full session ID")} /></label></div>}
    {error && <div className="us-notice us-warning" role="alert">{ui("Could not load:")}{ui(error)}<button className="us-button" onClick={() => setRefresh(n => n + 1)}>{ui("Retry")}</button></div>}
    {exportError && <div className="us-notice us-warning" role="alert">{ui(exportError)}</div>}
    {loading && <div className="us-loading" role="status">{ui("Loading usage…")}</div>}
    {data && <>
      <Headline data={data} onPartial={showAttention} />
      <Tabs label={ui("Group by")} value={groupBy} options={BREAKDOWNS} onChange={setGroupBy} compact />
      <Breakdown data={data} by={groupBy} />
      <Trend data={data} />
      <Sources data={data} open={sourcesOpen} onToggle={() => setSourcesOpen(!sourcesOpen)} anchor={sources} />
    </>}
  </section>;
}
// The header pill and the Settings section both open this dashboard in a modal window.
const TodayWithDashboard = () => <TodayBadge details={Dashboard} />;
const SettingsWithDashboard = () => <UsageSettings details={Dashboard} />;
export const name = 'dsh-usage-stats-client';
// The desktop language bridge initializes asynchronously; wait before registering UI.
export const inject = ['slots', 'locale'];
export function apply(ctx: Client): void {
  ctx.effect(() => installLocale(ctx));
  ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'usage-stats', order: 70, label: () => ui("Usage statistics") }, SettingsWithDashboard));
  // Today's total first among the conversation header utilities, before the host's buttons and overflow menu (order 0).
  // A host that rejects the entry keeps the rest of the plugin working.
  ctx.slots.inject('conversation.session.header.utilities', () => {
    try { return ctx.slots.register({ name: 'conversation.session.header.utilities', id: 'usage-stats-today', order: -1000, label: () => ui("Today's usage") }, TodayWithDashboard); }
    catch (error) { console.warn('[dsh-usage-stats] Could not show today\'s usage in the conversation header', error); return undefined; }
  });
}
