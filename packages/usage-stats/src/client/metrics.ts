import type { UsageGroup } from '../domain.js';

const DAY = 86_400_000;
const iso = (time: number) => new Date(time).toISOString().slice(0, 10);
const pad = (value: number) => String(value).padStart(2, '0');
/** Today in the viewer's time zone, the day the dashboard and the header pill both count. */
export const localDay = (now = new Date()) => `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
/** Minutes east of UTC, the API's `tz`, so its day boundaries match `localDay`. */
export const localOffset = (now = new Date()) => String(-now.getTimezoneOffset());
export function dateRange(preset: 'today' | '7d' | '30d' | 'all', now = new Date()): { from: string; to: string } {
  if (preset === 'all') return { from: '', to: '' };
  const today = Date.parse(localDay(now));
  return { from: iso(today - (preset === '7d' ? 6 : preset === '30d' ? 29 : 0) * DAY), to: iso(today) };
}
export interface TrendBucket { from: string; to: string; tokens: number; requests: number }
/** Include quiet dates and bound the number of bars even for multi-year histories. */
export function trendBuckets(series: UsageGroup[], from?: string, to?: string): TrendBucket[] {
  if (!series.length) return [];
  const sorted = [...series].sort((a, b) => a.key.localeCompare(b.key));
  const start = Date.parse(from || sorted[0].key); const end = Date.parse(to || sorted.at(-1)!.key);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
  const days = Math.round((end - start) / DAY) + 1; const width = Math.max(1, Math.ceil(days / 48));
  const buckets: TrendBucket[] = Array.from({ length: Math.ceil(days / width) }, (_, i) => ({ from: iso(start + i * width * DAY), to: iso(Math.min(end, start + ((i + 1) * width - 1) * DAY)), tokens: 0, requests: 0 }));
  for (const day of sorted) {
    const index = Math.floor((Date.parse(day.key) - start) / DAY / width);
    if (buckets[index]) { buckets[index].tokens += day.totals.totalTokens; buckets[index].requests += day.totals.requests; }
  }
  return buckets;
}
const ENGLISH = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const CHINESE = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const YI = 100_000_000;
/**
 * A token count in short form: K/M/B, such as 13M or 9.8M. In Chinese, counts from 1亿 up read in 亿 with two decimals,
 * cut rather than rounded so they never read higher than the count: 113,600,000 is 1.13亿. Below 1亿 they stay K/M, as
 * Chinese compact notation keeps every digit there (1304万). `scale`, the largest value of a chart axis, puts all of the
 * axis's labels in its unit.
 */
export const compact = (value: number, language = 'en', scale = value) =>
  language === 'zh' && scale >= YI ? `${CHINESE.format(Math.floor(value / 1_000_000) / 100)}亿` : ENGLISH.format(value);

/** A calendar month in the viewer's date domain; UTC arithmetic avoids DST gaps. */
export function monthRange(month: string): { from: string; to: string } {
  const start = Date.parse(`${month}-01T00:00:00Z`);
  if (!/^\d{4}-\d{2}$/.test(month) || !Number.isFinite(start) || iso(start).slice(0, 7) !== month) throw new Error('Invalid month');
  const date = new Date(start);
  date.setUTCMonth(date.getUTCMonth() + 1);
  return { from: iso(start), to: iso(date.getTime() - DAY) };
}
export function shiftMonth(month: string, offset: number): string {
  const date = new Date(`${monthRange(month).from}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + offset);
  return iso(date.getTime()).slice(0, 7);
}
export interface CalendarDay { date: string; tokens: number; requests: number; future: boolean }
/** Monday-first, six fixed weeks. Quiet days are zero; padding is not a real date. */
export function calendarDays(month: string, series: UsageGroup[], today = localDay()): (CalendarDay | null)[] {
  const { from, to } = monthRange(month);
  const start = Date.parse(from), count = Number(to.slice(-2));
  const leading = (new Date(start).getUTCDay() + 6) % 7;
  const totals = new Map(series.map(day => [day.key, day.totals]));
  return Array.from({ length: 42 }, (_, index) => {
    const day = index - leading + 1;
    if (day < 1 || day > count) return null;
    const date = iso(start + (day - 1) * DAY), value = totals.get(date);
    return { date, tokens: value?.totalTokens ?? 0, requests: value?.requests ?? 0, future: date > today };
  });
}
/** Zero has no fill; positive usage occupies four relative intensity bands. */
export function heatLevel(value: number, max: number): number {
  return value <= 0 || max <= 0 ? 0 : Math.min(4, Math.max(1, Math.ceil(value / max * 4)));
}
