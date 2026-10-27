import type { LocaleContext } from '@dsh-plugins/i18n';
import { ui, installLocale, useLocale, formatLocale } from './i18n.js';
import React, { useEffect, useState } from 'react';
import type { Dimension, GroupBy, UsageReport, Totals } from '../domain.js';
import { compact, dateRange, trendBuckets } from './metrics.js';
import { styles } from './styles.js';

interface Client extends LocaleContext {
  effect(factory: () => () => void): void;
  slots: { inject(name: string, factory: () => unknown): unknown; register(spec: Record<string, unknown>, component: React.FC): unknown };
}
const number = (value: number) => value.toLocaleString(formatLocale());
const percent = (value: number, total: number) => total ? `${(value / total * 100).toFixed(1)}%` : '—';
const shortDate = (value: string) => value.slice(5).replace('-', '/');
function UsageMark() {
  return <svg width="28" height="28" viewBox="0 0 32 32" fill="none" aria-hidden="true">
    <circle cx="16" cy="16" r="12.5" stroke="currentColor" strokeOpacity=".14" strokeWidth="2.5" />
    <path d="M16 3.5a12.5 12.5 0 0 1 12.5 12.5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    <path d="M27.4 21.1a12.5 12.5 0 0 1-19.1 4.7" stroke="var(--us-purple)" strokeWidth="2.5" strokeLinecap="round" />
    <rect x="9" y="15" width="3" height="7" rx="1.5" fill="currentColor" fillOpacity=".55" />
    <rect x="14.5" y="10" width="3" height="12" rx="1.5" fill="currentColor" />
    <rect x="20" y="13" width="3" height="9" rx="1.5" fill="var(--us-purple)" />
  </svg>;
}
function Icon({ kind = 'chart' }: { kind?: 'chart' | 'download' | 'refresh' }) {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{kind === 'chart' ? <><path d="M4 19h16M7 15V9m5 6V5m5 10v-4" /></> : kind === 'download' ? <><path d="M12 3v12m-4-4 4 4 4-4M5 16v4h14v-4" /></> : <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6.2 6.2A8 8 0 0 1 20 12M4 12a8 8 0 0 0 13.8 5.8" /></>}</svg>;
}
function Trend({ data }: { data: UsageReport }) {
  const [metric, setMetric] = useState<'tokens' | 'requests'>('tokens');
  const [hovered, setHovered] = useState<number>();
  const buckets = trendBuckets(data.series ?? [], data.query.from, data.query.to);
  const max = Math.max(1, ...buckets.map(b => b[metric]));
  const selected = hovered === undefined ? undefined : buckets[hovered];
  const total = metric === 'tokens' ? data.totals.totalTokens : data.totals.requests;
  return <section className="us-panel" aria-label={ui("Usage trend")}>
    <div className="us-panel-head"><div><h3>{ui("Usage trend")}</h3><p className="us-subtitle">{buckets.length && buckets[0].from !== buckets[0].to ? ui("Grouped by time period") : ui("Daily usage")} · UTC</p></div><div className="us-segment" role="group" aria-label={ui("Trend metric")}>{(['tokens', 'requests'] as const).map(value => <button key={value} aria-pressed={metric === value} onClick={() => { setMetric(value); setHovered(undefined); }}>{value === 'tokens' ? 'Token' : ui("Requests")}</button>)}</div></div>
    {buckets.length ? <div className="us-chart">
      <div className="us-chart-readout" aria-live="polite"><span>{selected ? `${selected.from}${selected.to !== selected.from ? ` → ${selected.to}` : ''}` : ui("Selected period")}</span><span className="us-number">{number(selected ? selected[metric] : total)} {metric === 'tokens' ? 'Token' : ui("requests")}</span></div>
      <div className="us-chart-body"><div className="us-y-axis" aria-hidden="true"><span>{compact(max)}</span><span>{compact(max / 2)}</span><span>0</span></div><div className="us-plot"><div className="us-grid" aria-hidden="true"><span /><span /><span /></div><div className="us-bars" role="group" aria-label={ui("Daily usage trend")}>{buckets.map((b, i) => <button key={b.from} className="us-bar-hit" aria-label={`${b.from}${b.from !== b.to ? ui(" to {0}", { 0: b.to }) : ''}: ${number(b[metric])} ${metric === 'tokens' ? 'Token' : ui("requests")}`} aria-pressed={hovered === i} onMouseEnter={() => setHovered(i)} onMouseLeave={() => setHovered(undefined)} onFocus={() => setHovered(i)} onBlur={() => setHovered(undefined)} onClick={() => setHovered(i)}><span className="us-bar" style={{ height: `${b[metric] ? Math.max(1.5, b[metric] / max * 100) : 0}%` }} /></button>)}</div></div></div>
      <div className="us-x-axis" aria-hidden="true"><span>{shortDate(buckets[0].from)}</span>{buckets.length > 3 && <span>{shortDate(buckets[Math.floor(buckets.length / 2)].from)}</span>}<span>{shortDate(buckets.at(-1)!.to)}</span></div>
    </div> : <div className="us-empty"><Icon /><p>{ui("No trend data yet")}</p></div>}
    <div className="us-token-parts">{([[ui("Input · Uncached"), data.totals.inputTokens], [ui("Output tokens"), data.totals.outputTokens], [ui("Cache reads"), data.totals.cacheReadTokens], [ui("Cache writes"), data.totals.cacheWriteTokens]] as const).map(([label, value]) => <div key={label}><span>{label}</span><b className="us-number" title={number(value)}>{compact(value)}</b></div>)}</div>
  </section>;
}
/** Request sources in display order, with their dashboard colours. */
const SOURCES = [['dsh', "DSH model calls", 'var(--us-accent)'], ['remote-agents', "Remote agents", 'var(--us-amber)']] as const;
function Sources({ data }: { data: UsageReport }) {
  const total = data.totals.totalTokens;
  const parts = SOURCES.map(([key, label, color]) => ({ key, label: ui(label), color, value: data.sources?.find(s => s.key === key)?.totals.totalTokens ?? 0 }));
  let offset = 0;
  const arcs = parts.map(part => { const share = total ? part.value / total * 100 : 0, arc = { ...part, share, offset }; offset += share; return arc; });
  return <section className="us-panel" aria-label={ui("Usage by source")}><div className="us-panel-head"><div><h3>{ui("Usage by source")}</h3><p className="us-subtitle">{ui("Based on reported token usage")}</p></div></div><div className="us-source-content"><div className="us-ring-wrap"><div className="us-ring" role="img" aria-label={parts.map(part => `${part.label} ${number(part.value)} Token`).join(', ')}>
    <svg viewBox="0 0 140 140" aria-hidden="true"><circle cx="70" cy="70" r="61" fill="none" stroke="var(--us-line)" strokeWidth="12" />{total > 0 && <g transform="rotate(-90 70 70)">{arcs.filter(arc => arc.share > 0).map(arc => <circle key={arc.key} cx="70" cy="70" r="61" pathLength="100" fill="none" stroke={arc.color} strokeWidth="12" strokeDasharray={`${arc.share} ${100 - arc.share}`} strokeDashoffset={-arc.offset} />)}</g>}</svg>
    <div className="us-ring-center"><b className="us-number" title={number(total)}>{compact(total)}</b><span>{ui("Total tokens")}</span></div>
    </div></div><div className="us-source-list">{parts.map(({ label, value, color }) => <div className="us-source-item" key={label}><div className="us-source-title"><span><i className="us-dot" style={{ background: color }} />{label}</span><b className="us-number">{percent(value, total)}</b></div><div className="us-track"><span style={{ width: `${total ? value / total * 100 : 0}%`, background: color }} /></div><div className="us-muted us-number" style={{ fontSize: 10 }}>{number(value)} Token</div></div>)}</div></div></section>;
}
function Metric({ label, value, detail, title }: { label: string; value: string; detail: string; title?: string }) {
  return <article className="us-metric" aria-label={label}><div className="us-metric-label">{label}</div><strong className="us-number" title={title}>{value}</strong><small>{detail}</small></article>;
}
function Status({ totals: t }: { totals: Totals }) {
  return t.errors || t.cancelled ? <span className="us-badge us-error">{t.errors ? ui("{0} failed", { 0: number(t.errors) }) : ''}{t.errors && t.cancelled ? ' · ' : ''}{t.cancelled ? ui("{0} cancelled", { 0: number(t.cancelled) }) : ''}</span> : <span className="us-badge">{ui("Completed")}</span>;
}
const BREAKDOWNS = [['provider', "By provider"], ['workspace', "By workspace"], ['model', "By model"], ['vendor', "By model vendor"], ['host', "By host"]] as const;
const BREAKDOWN_ROWS = 8;
/** Long workspace paths keep their last two folders; the full path is in the tooltip. */
const shortPath = (path: string) => { const parts = path.split(/[\\/]/).filter(Boolean); return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : path; };
function Breakdowns({ data }: { data: UsageReport }) {
  const [by, setBy] = useState<Dimension>('provider'); const [all, setAll] = useState(false);
  const rows = data.breakdowns?.[by] ?? [], total = data.totals.totalTokens;
  return <section className="us-panel us-breakdown" aria-label={ui("Usage breakdown")}>
    <div className="us-panel-head"><div><h3>{ui("Usage breakdown")}</h3><p className="us-subtitle">{ui("Share of reported tokens")}</p></div></div>
    <div className="us-segment us-breakdown-tabs" role="group" aria-label={ui("Break down by")}>{BREAKDOWNS.map(([value, label]) => <button key={value} aria-pressed={by === value} onClick={() => { setBy(value); setAll(false); }}>{ui(label)}</button>)}</div>
    {rows.length ? <ol className="us-breakdown-list">{(all ? rows : rows.slice(0, BREAKDOWN_ROWS)).map(g => {
      const placeholder = g.key === '' || g.key === '?', name = placeholder ? ui(g.label) : by === 'workspace' ? shortPath(g.label) : g.label;
      return <li key={g.key}><div className="us-breakdown-row"><span className="us-breakdown-name" title={placeholder ? name : g.label}>{name}</span><b className="us-number" title={number(g.totals.totalTokens)}>{compact(g.totals.totalTokens)}</b></div>
        <div className="us-breakdown-bar"><span style={{ width: `${total ? g.totals.totalTokens / total * 100 : 0}%` }} /></div>
        <div className="us-breakdown-meta"><span>{ui("{0} requests", { 0: number(g.totals.requests) })}</span><span className="us-number">{percent(g.totals.totalTokens, total)}</span></div></li>;
    })}</ol> : <p className="us-muted">{ui("No matching records")}</p>}
    {rows.length > BREAKDOWN_ROWS && <button className="us-button us-breakdown-more" onClick={() => setAll(!all)}>{all ? ui("Show fewer") : ui("Show all {0}", { 0: number(rows.length) })}</button>}
  </section>;
}
export function Dashboard() {
  useLocale();
  const [groupBy, setGroupBy] = useState<GroupBy>('model');
  const [source, setSource] = useState(''); const [from, setFrom] = useState(''); const [to, setTo] = useState('');
  const [period, setPeriod] = useState<'today' | '7d' | '30d' | 'all' | 'custom'>('all');
  const [provider, setProvider] = useState(''); const [model, setModel] = useState(''); const [sessionId, setSessionId] = useState('');
  const [data, setData] = useState<UsageReport>(); const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0); const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false); const [exportError, setExportError] = useState(''); const [page, setPage] = useState(0);
  const params = new URLSearchParams({ groupBy });
  for (const [key, value] of Object.entries({ source, from, to, provider, model, sessionId })) if (value) params.set(key, value);
  const path = `/api/usage-stats?${params}`;
  const exportCsv = async () => {
    setExporting(true); setExportError('');
    try {
      const response = await fetch(`${path}&format=csv`, { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) throw new Error(`Export failed ${response.status}`);
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'dsh-usage.csv';
      document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { setExportError(e instanceof Error ? e.message : String(e)); }
    finally { setExporting(false); }
  };
  useEffect(() => {
    const controller = new AbortController(); let pending = false;
    setData(undefined); setPage(0); setLoading(true); setError('');
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
  const choosePeriod = (value: 'today' | '7d' | '30d' | 'all') => { const range = dateRange(value); setPeriod(value); setFrom(range.from); setTo(range.to); };
  const reset = () => { setProvider(''); setModel(''); setSessionId(''); choosePeriod('all'); };
  const filterCount = [provider, model, sessionId].filter(Boolean).length;
  const select = (label: string, value: string, set: (value: string) => void, options: string[]) => <label className="us-field">{label}<select aria-label={label} value={value} onChange={e => set(e.target.value)}><option value="">{ui("All {0}", { 0: label })}</option>{options.map(v => <option key={v} value={v}>{v}</option>)}</select></label>;
  const t = data?.totals;
  const lastPage = data ? Math.max(0, Math.ceil(data.groups.length / 10) - 1) : 0;
  const currentPage = Math.min(page, lastPage);
  return <section className="dsh-usage" aria-label={ui("Usage statistics")}><style>{styles}</style>
    <header className="us-top"><div className="us-title"><span className="us-logo"><UsageMark /></span><div><h2>{ui("Usage statistics")}</h2><p className="us-subtitle">{ui("Model usage from DSH and remote agents")}</p></div></div><div className="us-actions"><span className="us-live"><i className="us-dot" />{ui("Updates every 5 seconds")}</span><button className="us-button" onClick={() => setRefresh(n => n + 1)} aria-label={ui("Refresh")}><Icon kind="refresh" />{ui("Refresh")}</button><button className="us-button us-primary" disabled={exporting} onClick={() => void exportCsv()}><Icon kind="download" />{exporting ? ui("Exporting…") : ui("Export CSV")}</button></div></header>
    <nav className="us-tabs" aria-label={ui("Request source")}>{([['', ui("All sources"), ''], ...SOURCES.map(([key, label, color]) => [key, ui(label), color])] as const).map(([value, label, color]) => <button className="us-tab" key={value} aria-pressed={source === value} onClick={() => setSource(value)}>{color && <i className="us-dot" style={{ background: color }} />}{label}</button>)}</nav>
    <div className="us-toolbar"><div className="us-period"><div className="us-segment" role="group" aria-label={ui("Time range")}>{([['today', ui("Today")], ['7d', ui("Last 7 days")], ['30d', ui("Last 30 days")], ['all', ui("All")]] as const).map(([value, label]) => <button key={value} aria-pressed={period === value} onClick={() => choosePeriod(value)}>{label}</button>)}<button aria-pressed={period === 'custom'} onClick={() => setPeriod('custom')}>{ui("Custom")}</button></div><span className="us-muted" style={{ fontSize: 11 }}>{from || to ? `${from || ui("First record")} → ${to || ui("Latest record")}` : ui("All records")} · UTC</span></div>{(filterCount > 0 || period === 'custom') && <button className="us-button" onClick={reset}>{ui("Reset filters")}</button>}</div>
    {period === 'custom' && <div className="us-custom-dates"><label className="us-field">{ui("Start date")}<input aria-label={ui("Start date")} type="date" value={from} onChange={e => setFrom(e.target.value)} /></label><span className="us-muted">—</span><label className="us-field">{ui("End date")}<input aria-label={ui("End date")} type="date" value={to} onChange={e => setTo(e.target.value)} /></label></div>}
    <details className="us-filters"><summary>{ui("More filters")}{filterCount ? ui(" · {0} applied", { 0: filterCount }) : ui(" · Provider, model, session")}</summary><div className="us-filter-grid">{select(ui("Provider"), provider, setProvider, data?.filters.providers ?? (provider ? [provider] : []))}{select(ui("Model"), model, setModel, data?.filters.models ?? (model ? [model] : []))}<label className="us-field">{ui("Session ID")}<input aria-label={ui("Session ID")} value={sessionId} onChange={e => setSessionId(e.target.value)} placeholder={ui("Filter by full session ID")} /></label></div></details>
    {error && <div className="us-notice us-warning" role="alert">{ui("Could not load:")}{ui(error)}<button className="us-button" onClick={() => setRefresh(n => n + 1)}>{ui("Retry")}</button></div>}
    {exportError && <div className="us-notice us-warning" role="alert">{ui(exportError)}</div>}
    {loading && <div className="us-loading" role="status">{ui("Loading usage…")}</div>}
    {data && t && <>
      {data.failedWrites > 0 && <div className="us-notice us-warning" role="alert">{ui("{0} records could not be saved. Statistics may be incomplete. Check DSH logs and disk permissions.", { 0: number(data.failedWrites) })}</div>}
      <div className="us-summary"><Metric label={ui("Total tokens")} value={compact(t.totalTokens)} title={number(t.totalTokens)} detail={ui("Input {0} / Output {1}", { 0: compact(t.inputTokens), 1: compact(t.outputTokens) })} /><Metric label={ui("Requests")} value={number(t.requests)} detail={ui("Usage reported {0}/{1}", { 0: number(t.withUsage), 1: number(t.requests) })} /><Metric label={ui("Cache read share")} value={t.withUsage ? percent(t.cacheReadTokens, t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens) : '—'} detail={ui("Cache reads {0} tokens", { 0: compact(t.cacheReadTokens) })} /><Metric label={ui("Completion rate")} value={percent(t.completed, t.requests)} detail={ui("Failed {0} · Cancelled {1}", { 0: number(t.errors), 1: number(t.cancelled) })} /></div>
      {t.withUsage < t.requests && <div className="us-notice us-warning" role="status">{ui("{0} requests returned no usage. Token totals only include reported data.", { 0: number(t.requests - t.withUsage) })}</div>}
      <div className="us-charts"><Trend data={data} /><Sources data={data} /></div>
      <Breakdowns data={data} />
      <section className="us-panel" aria-label={ui("Usage details")}><div className="us-details-head"><div><h3>{ui("Usage details")}</h3><p className="us-subtitle">{ui("See where your usage comes from")}</p></div><label className="us-actions"><span className="us-muted" style={{ fontSize: 11 }}>{ui("Group")}</span><select className="us-group-select" aria-label={ui("Group by")} value={groupBy} onChange={e => setGroupBy(e.target.value as GroupBy)}>{([['model', ui("By model")], ['day', ui("By day")], ['source', ui("By source")], ['session', ui("By session")]] as const).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label></div>
        {data.groups.length ? <><div className="us-scroll" tabIndex={0} aria-label={ui("Usage details, scroll horizontally")}><table className="us-table"><thead><tr>{['model' === groupBy ? ui("Model / Provider") : groupBy === 'day' ? ui("Date · UTC") : groupBy === 'source' ? ui("Request source") : ui("Session"), ui("Requests"), ui("Input"), ui("Output"), ui("Cache read / write"), ui("Total tokens"), ui("Status")].map(label => <th scope="col" key={label}>{label}</th>)}</tr></thead><tbody>{data.groups.slice(currentPage * 10, (currentPage + 1) * 10).map(g => {
          const split = groupBy === 'model' ? g.label.indexOf(' / ') : -1;
          const name = split >= 0 ? g.label.slice(split + 3) : groupBy === 'source' || (groupBy === 'session' && !g.key) ? ui(g.label) : g.label; const sub = split >= 0 ? g.label.slice(0, split) : '';
          return <tr key={g.key}><th scope="row" title={groupBy === 'source' || (groupBy === 'session' && !g.key) ? ui(g.label) : g.label}><div className="us-table-main">{name}</div>{sub && <span className="us-table-sub">{sub}</span>}</th><td>{number(g.totals.requests)}<span className="us-table-sub" style={{ marginLeft: 'auto' }}>{ui("With usage")} {g.totals.withUsage}/{g.totals.requests}</span></td><td title={ui("Uncached input: {0}", { 0: number(g.totals.inputTokens) })}>{number(g.totals.inputTokens)}</td><td>{number(g.totals.outputTokens)}</td><td>{compact(g.totals.cacheReadTokens)} / {compact(g.totals.cacheWriteTokens)}</td><td className="us-total-cell">{number(g.totals.totalTokens)}<span className="us-table-sub">{ui("Share")} {percent(g.totals.totalTokens, t.totalTokens)}</span></td><td><Status totals={g.totals} /></td></tr>;
        })}</tbody></table></div><div className="us-pagination"><span>{ui("{0} groups · Page {1} / {2}", { 0: number(data.groups.length), 1: currentPage + 1, 2: lastPage + 1 })}</span><div className="us-actions"><button className="us-button" aria-label={ui("Previous page")} disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>←</button><button className="us-button" aria-label={ui("Next page")} disabled={currentPage === lastPage} onClick={() => setPage(currentPage + 1)}>→</button></div></div></> : <div className="us-empty" role="status"><Icon /><h3>{ui("No matching records")}</h3><p>{ui("Usage appears here after a model or remote agent request completes.")}</p></div>}
      </section>
      <footer className="us-foot"><span>{ui("Updated")} {new Date(data.generatedAt).toLocaleTimeString(formatLocale())}  {ui("· Stored locally")}</span><details><summary>{ui("Measurement and scope")}</summary><p>{ui("Dates use UTC and the request start time. Input excludes cache tokens; cache reads and writes are counted separately. Cache read share = cache reads ÷ (uncached input + cache reads + cache writes). Reasoning tokens")} {number(t.reasoningTokens)}  {ui("are included in output. Only calls from this DSH instance are tracked, including titles and compaction. Remote agents are counted once per remote turn; independently running CLIs are excluded. Missing usage is not estimated. First record:")} {data.recordedSince ? new Date(data.recordedSince).toLocaleString(formatLocale()) : ui("None yet")}.</p></details></footer>
    </>}
  </section>;
}
export const name = 'dsh-usage-stats-client';
// The desktop language bridge initializes asynchronously; wait before registering UI.
export const inject = ['slots', 'locale'];
export function apply(ctx: Client): void {
  ctx.effect(() => installLocale(ctx));
  ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'usage-stats', order: 70, label: () => ui("Usage statistics") }, Dashboard));
}
