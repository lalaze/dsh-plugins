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
export const compact = (value: number) => new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
