import type { TokenUsage } from '@deepseek-ai/dsh-llm';

export interface UsageRecord {
  id: string;
  startedAt: string;
  provider: string;
  model: string;
  sessionId?: string;
  purpose: string;
  status: 'completed' | 'error' | 'cancelled';
  durationMs: number;
  usage?: TokenUsage;
}
export interface Totals {
  requests: number;
  completed: number;
  errors: number;
  cancelled: number;
  withUsage: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}
export type GroupBy = 'day' | 'model' | 'session' | 'source';
export type Source = 'dsh' | 'claude-ssh' | 'remote-agents';
/** dsh-claude-ssh names providers `claude-ssh-<host>`; dsh-remote-agents names its CLI routes `remote-cli-<cli>`. */
export const sourceOf = (provider: string): Source => provider.startsWith('claude-ssh-') ? 'claude-ssh' : provider.startsWith('remote-cli-') ? 'remote-agents' : 'dsh';
export const SOURCE_LABELS: Record<Source, string> = { dsh: "DSH model calls", 'claude-ssh': "Remote Claude SSH", 'remote-agents': "Remote agents" };
/** dsh-remote-agents chat routes are `<machine>/<cli>/<model>[/<speed>]`; statistics keep the model and speed. */
export function remoteModel(route: string): string {
  const [, cli, model, tier, ...extra] = route.split('/');
  if (!cli || !model || extra.length) return route;
  try { return decodeURIComponent(model) + (tier ? ` · ${decodeURIComponent(tier)}` : ''); } catch { return route; }
}
export interface Query { from?: string; to?: string; provider?: string; model?: string; sessionId?: string; source?: Source; groupBy: GroupBy }
export interface UsageGroup { key: string; label: string; totals: Totals }
export interface UsageReport {
  totals: Totals;
  groups: UsageGroup[];
  series: UsageGroup[];
  sources: UsageGroup[];
  filters: { providers: string[]; models: string[]; sessions: string[] };
  query: Query;
  recordedSince?: string;
  failedWrites: number;
  generatedAt: string;
}
const counters = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens'] as const;
export function validUsage(value: unknown): value is TokenUsage {
  if (!value || typeof value !== 'object') return false;
  const usage = value as Record<string, unknown>;
  return counters.every(key => usage[key] === undefined ? key !== 'inputTokens' && key !== 'outputTokens' : Number.isSafeInteger(usage[key]) && Number(usage[key]) >= 0);
}
export function validRecord(value: unknown): value is UsageRecord {
  if (!value || typeof value !== 'object') return false;
  const r = value as UsageRecord;
  return typeof r.id === 'string' && typeof r.startedAt === 'string' && Number.isFinite(Date.parse(r.startedAt)) &&
    typeof r.provider === 'string' && typeof r.model === 'string' && typeof r.purpose === 'string' &&
    (r.sessionId === undefined || typeof r.sessionId === 'string') && ['completed', 'error', 'cancelled'].includes(r.status) &&
    Number.isFinite(r.durationMs) && r.durationMs >= 0 && (r.usage === undefined || validUsage(r.usage));
}
function emptyTotals(): Totals {
  return { requests: 0, completed: 0, errors: 0, cancelled: 0, withUsage: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 0 };
}
function add(t: Totals, r: UsageRecord): void {
  t.requests++;
  if (r.status === 'error') t.errors++; else t[r.status]++;
  if (!r.usage) return;
  t.withUsage++;
  for (const key of counters) if (key !== 'totalTokens') t[key] += r.usage[key] ?? 0;
  // Reasoning is a subset of output, while cache counters are disjoint from uncached input.
  t.totalTokens += r.usage.totalTokens ?? r.usage.inputTokens + r.usage.outputTokens + (r.usage.cacheReadTokens ?? 0) + (r.usage.cacheWriteTokens ?? 0);
}
function date(value: string | null): string | undefined {
  if (value === null || value === '') return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new Error("Date must be a valid YYYY-MM-DD (UTC)");
  return value;
}
export function parseQuery(url: URL): Query {
  const p = url.searchParams;
  const groupBy = p.get('groupBy') ?? 'day';
  if (!['day', 'model', 'session', 'source'].includes(groupBy)) throw new Error("Unsupported grouping");
  const rawSource = p.get('source');
  let source: Source | undefined;
  if (rawSource === 'dsh' || rawSource === 'claude-ssh' || rawSource === 'remote-agents') source = rawSource;
  else if (rawSource) throw new Error("Unsupported request source");
  const from = date(p.get('from')); const to = date(p.get('to'));
  if (from && to && from > to) throw new Error("Start date must not be later than end date");
  const filter = (key: string) => { const value = p.get(key) || undefined; if (value && value.length > 1024) throw new Error("Filter value is too long"); return value; };
  return { from, to, groupBy: groupBy as GroupBy, source, provider: filter('provider'), model: filter('model'), sessionId: filter('sessionId') };
}
export function report(records: readonly UsageRecord[], query: Query, failedWrites = 0): UsageReport {
  const totals = emptyTotals();
  const groups = new Map<string, UsageGroup>();
  const series = new Map<string, UsageGroup>(); const sources = new Map<string, UsageGroup>();
  const accumulate = (map: Map<string, UsageGroup>, key: string, label: string, r: UsageRecord) => {
    let group = map.get(key);
    if (!group) { group = { key, label, totals: emptyTotals() }; map.set(key, group); }
    add(group.totals, r);
  };
  for (const r of records) {
    const day = r.startedAt.slice(0, 10);
    if ((query.from && day < query.from) || (query.to && day > query.to) || (query.provider && r.provider !== query.provider) || (query.model && r.model !== query.model) || (query.sessionId && r.sessionId !== query.sessionId) || (query.source && sourceOf(r.provider) !== query.source)) continue;
    const key = query.groupBy === 'day' ? day : query.groupBy === 'source' ? sourceOf(r.provider) : query.groupBy === 'model' ? JSON.stringify([r.provider, r.model]) : r.sessionId ?? '';
    const label = query.groupBy === 'source' ? SOURCE_LABELS[sourceOf(r.provider)] : query.groupBy === 'model' ? `${r.provider} / ${r.model}` : query.groupBy === 'session' ? r.sessionId ?? "No session (auxiliary call)" : day;
    add(totals, r); accumulate(groups, key, label, r);
    accumulate(series, day, day, r);
    accumulate(sources, sourceOf(r.provider), SOURCE_LABELS[sourceOf(r.provider)], r);
  }
  return { totals, groups: [...groups.values()].sort((a, b) => query.groupBy === 'day' ? b.key.localeCompare(a.key) : b.totals.totalTokens - a.totals.totalTokens || a.label.localeCompare(b.label)),
    series: [...series.values()].sort((a, b) => a.key.localeCompare(b.key)),
    sources: [...sources.values()].sort((a, b) => a.key.localeCompare(b.key)),
    filters: { providers: [...new Set(records.map(r => r.provider))].sort(), models: [...new Set(records.map(r => r.model))].sort(), sessions: [...new Set(records.flatMap(r => r.sessionId ? [r.sessionId] : []))].sort() },
    query, recordedSince: records.reduce<string | undefined>((first, r) => !first || r.startedAt < first ? r.startedAt : first, undefined), failedWrites, generatedAt: new Date().toISOString() };
}
export function toCsv(data: UsageReport): string {
  const keys = Object.keys(emptyTotals()) as Array<keyof Totals>;
  const cell = (value: string | number) => `"${String(value).replace(/^[=+@\-\t\r]/, "'$&").replaceAll('"', '""')}"`;
  return '\uFEFF' + [['group', ...keys], ...data.groups.map(g => [g.label, ...keys.map(key => g.totals[key])])].map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
}
