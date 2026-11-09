import React, { useEffect, useState } from 'react';
import type { UsageReport } from '../domain.js';
import { ui, formatLocale } from './i18n.js';
import { calendarDays, heatLevel, localDay, localOffset, monthRange, shiftMonth } from './metrics.js';

/** Independent whole-month query: changing the dashboard's time preset must not clip the calendar. */
export function MonthlyHeatmap({ provider, model, sessionId, refresh }: { provider: string; model: string; sessionId: string; refresh: number }) {
  const today = localDay(), currentMonth = today.slice(0, 7);
  const [month, setMonth] = useState(currentMonth);
  const [metric, setMetric] = useState<'tokens' | 'requests'>('tokens');
  const [selected, setSelected] = useState<string>();
  const [snapshot, setSnapshot] = useState<{ path: string; data: UsageReport }>();
  const [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const params = new URLSearchParams({ ...monthRange(month), tz: localOffset() });
  for (const [key, value] of Object.entries({ provider, model, sessionId })) if (value) params.set(key, value);
  const path = `/api/usage-stats?${params}`;
  // A prior month/filter must never masquerade as the newly selected one, including during failures.
  const data = snapshot?.path === path ? snapshot.data : undefined;
  useEffect(() => {
    const controller = new AbortController(); let pending = false;
    setLoading(true); setError('');
    const read = async () => {
      if (pending) return;
      pending = true;
      try {
        const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || `Request failed ${response.status}`);
        if (!controller.signal.aborted) { setSnapshot({ path, data: body }); setError(''); }
      } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e)); }
      finally { pending = false; if (!controller.signal.aborted) setLoading(false); }
    };
    void read();
    const timer = setInterval(() => { if (!document.hidden) void read(); }, 5000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [path, refresh, retry]);
  const days = calendarDays(month, data?.series ?? [], today);
  const pastDays = days.filter(day => day && !day.future);
  const max = Math.max(1, ...pastDays.map(day => day![metric]));
  const total = pastDays.reduce((sum, day) => sum + day![metric], 0);
  const active = days.find(day => day?.date === selected);
  const number = (value: number) => value.toLocaleString(formatLocale());
  const unit = metric === 'tokens' ? 'Token' : ui('requests');
  const monthLabel = new Date(`${month}-01T00:00:00Z`).toLocaleDateString(formatLocale(), { year: 'numeric', month: 'long', timeZone: 'UTC' });
  const weekday = new Intl.DateTimeFormat(formatLocale(), { weekday: 'short', timeZone: 'UTC' });
  const chooseMonth = (value: string) => { setMonth(value); setSelected(undefined); };
  return <section className="us-panel us-heatmap" aria-label={ui('Monthly heatmap')} aria-busy={loading || (!data && !error)}>
    <div className="us-panel-head">
      <div><h3>{ui('Monthly heatmap')}</h3><p className="us-subtitle">{ui('Full month · follows filters, not time range')}</p></div>
      <div className="us-segment" role="group" aria-label={ui('Heatmap metric')}>{(['tokens', 'requests'] as const).map(value => <button key={value} type="button" aria-pressed={metric === value} onClick={() => setMetric(value)}>{value === 'tokens' ? 'Token' : ui('Requests')}</button>)}</div>
    </div>
    <div className="us-heatmap-body">
      <div className="us-month-nav">
        <button type="button" className="us-button" aria-label={ui('Previous month')} title={ui('Previous month')} onClick={() => chooseMonth(shiftMonth(month, -1))}>‹</button>
        <strong className="us-month-label us-number">{monthLabel}</strong>
        <button type="button" className="us-button" aria-label={ui('Next month')} title={ui('Next month')} disabled={month >= currentMonth} onClick={() => chooseMonth(shiftMonth(month, 1))}>›</button>
        <button type="button" className="us-link" disabled={month === currentMonth} onClick={() => chooseMonth(currentMonth)}>{ui('This month')}</button>
      </div>
      <div className="us-heatmap-readout us-number" role="status">
        <span>{active ? active.date : ui('Monthly total')}</span>
        <span>{data ? `${number(active ? active[metric] : total)} ${unit}` : error ? ui('Could not load this month') : ui('Loading month…')}</span>
      </div>
      <div className="us-heatmap-weekdays" aria-hidden="true">{Array.from({ length: 7 }, (_, i) => <span key={i}>{weekday.format(new Date(Date.UTC(2024, 0, i + 1)))}</span>)}</div>
      <div className="us-heatmap-grid" role="group" aria-label={monthLabel}>{days.map((day, index) => {
        if (!day) return <span key={`blank-${index}`} className="us-heatmap-blank" aria-hidden="true" />;
        const label = `${day.date} · ${day.future ? ui('Future date') : data ? `${number(day.tokens)} Token · ${ui('{0} requests', { 0: number(day.requests) })}` : error ? ui('Could not load this month') : ui('Loading month…')}`;
        return <button type="button" key={day.date} className="us-heatmap-day" data-date={day.date} data-level={data && !day.future ? heatLevel(day[metric], max) : undefined} data-future={day.future || undefined} aria-current={day.date === today ? 'date' : undefined} aria-label={label} title={label} aria-pressed={selected === day.date} disabled={day.future || !data} onMouseEnter={() => setSelected(day.date)} onMouseLeave={() => setSelected(undefined)} onFocus={() => setSelected(day.date)} onBlur={() => setSelected(undefined)} onClick={() => setSelected(day.date)}>{Number(day.date.slice(-2))}</button>;
      })}</div>
      <div className="us-heatmap-footer">
        <span>{data && !data.totals.requests ? ui('No usage this month') : ui('Local time')}</span>
        <div className="us-heatmap-legend" title={ui('Daily intensity relative to this month')} aria-label={ui('Daily intensity relative to this month')}><span>{ui('Less')}</span>{[0, 1, 2, 3, 4].map(level => <i key={level} data-level={level} aria-hidden="true" />)}<span>{ui('More')}</span></div>
      </div>
      {error && <div className="us-notice us-warning" role="alert"><span>{data ? ui('Could not refresh; showing previous results') : ui('Could not load this month')} · {ui(error)}</span><button type="button" className="us-button" onClick={() => setRetry(n => n + 1)}>{ui('Retry')}</button></div>}
    </div>
  </section>;
}
