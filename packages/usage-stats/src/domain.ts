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
  /** Remote turns: the machine's saved name. DSH model calls run on this computer and leave it unset. */
  host?: string;
  /** The conversation's workspace directory: remote for remote turns, local for DSH model calls. */
  workspace?: string;
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
export type Source = 'dsh' | 'remote-agents';
/** Remote CLI turns: dsh-remote-agents routes are `remote-cli-<cli>`; records from the retired dsh-claude-ssh source are `claude-ssh-<host>`. */
export const sourceOf = (provider: string): Source => provider.startsWith('remote-cli-') || provider.startsWith('claude-ssh-') ? 'remote-agents' : 'dsh';
export const SOURCE_LABELS: Record<Source, string> = { dsh: "DSH model calls", 'remote-agents': "Remote agents" };
/** dsh-remote-agents chat routes are `<machine>/<cli>/<model>[/<speed>]`; statistics keep the model and speed. */
export function remoteModel(route: string): string {
  const [, cli, model, tier, ...extra] = route.split('/');
  if (!cli || !model || extra.length) return route;
  try { return decodeURIComponent(model) + (tier ? ` · ${decodeURIComponent(tier)}` : ''); } catch { return route; }
}
/** `tzOffset` is minutes east of UTC for day boundaries; without it days are UTC. */
export interface Query { from?: string; to?: string; provider?: string; model?: string; sessionId?: string; source?: Source; groupBy: GroupBy; tzOffset?: number }
export interface UsageGroup { key: string; label: string; totals: Totals }
/** The dashboard's usage breakdowns: CLI or provider, workspace, model, model vendor and machine. */
export type Dimension = 'provider' | 'workspace' | 'model' | 'vendor' | 'host';
export const DIMENSIONS: readonly Dimension[] = ['provider', 'workspace', 'model', 'vendor', 'host'];
/** Detail rows follow a dashboard category; `day`, `session` and `source` remain for API clients. */
export type GroupBy = Dimension | 'day' | 'session' | 'source';
const isDimension = (value: string): value is Dimension => (DIMENSIONS as readonly string[]).includes(value);
export interface UsageReport {
  totals: Totals;
  groups: UsageGroup[];
  /** Every breakdown of the filtered records, largest first. */
  breakdowns: Record<Dimension, UsageGroup[]>;
  series: UsageGroup[];
  sources: UsageGroup[];
  filters: { providers: string[]; models: string[]; sessions: string[] };
  query: Query;
  recordedSince?: string;
  failedWrites: number;
  generatedAt: string;
}
const counters = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens'] as const;
const CLI_LABELS: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', grok: 'Grok', codebuddy: 'CodeBuddy', antigravity: 'Antigravity', dsh: 'DSH' };
/** Remote turns are named by their CLI, which merges a CLI's turns across machines; DSH providers keep their ID. */
export function providerLabel(provider: string): string {
  const cli = /^remote-cli-(.+)$/.exec(provider)?.[1];
  return cli ? CLI_LABELS[cli] ?? cli : provider.startsWith('claude-ssh-') ? 'Claude Code' : provider;
}
/** Older remote main-chat records kept the chat route as their model. */
export const modelOf = (r: Pick<UsageRecord, 'provider' | 'model'>) => r.provider.startsWith('remote-cli-') ? remoteModel(r.model) : r.model;
// The same model-name and provider rules dsh-session-models uses for its vendor icons.
const MODEL_VENDORS: readonly (readonly [RegExp, string])[] = [
  [/claude|sonnet|opus|haiku/i, 'Anthropic'], [/deepseek/i, 'DeepSeek'], [/gemini|gemma/i, 'Google'], [/grok/i, 'xAI'], [/qwen|qwq/i, 'Qwen'],
  [/kimi|moonshot/i, 'Moonshot'], [/\bglm|chatglm/i, 'Zhipu'], [/doubao/i, 'Doubao'], [/minimax|\babab/i, 'MiniMax'],
  [/mistral|codestral|devstral|magistral/i, 'Mistral'], [/\bgpt|\bo[1-9](?:-|$)|codex|chatgpt/i, 'OpenAI'],
];
const PROVIDER_VENDORS: readonly (readonly [RegExp, string])[] = [
  [/anthropic|claude/i, 'Anthropic'], [/openai|codex|azure/i, 'OpenAI'], [/deepseek|^dsh$/i, 'DeepSeek'], [/gemini|google|vertex/i, 'Google'],
  [/xai|grok/i, 'xAI'], [/qwen|dashscope|bailian|alibaba/i, 'Qwen'], [/moonshot|kimi/i, 'Moonshot'], [/zhipu|bigmodel|glm/i, 'Zhipu'],
  [/doubao|volcengine/i, 'Doubao'], [/minimax/i, 'MiniMax'], [/mistral/i, 'Mistral'], [/antigravity/i, 'Google'], [/codebuddy/i, 'Tencent'],
];
export function vendorOf(r: Pick<UsageRecord, 'provider' | 'model'>): string {
  const model = modelOf(r), provider = r.provider.replace(/^remote-cli-/, '');
  return MODEL_VENDORS.find(([pattern]) => pattern.test(model))?.[1] ?? PROVIDER_VENDORS.find(([pattern]) => pattern.test(provider))?.[1] ?? 'Other';
}
/** The DSH workspace a record belongs to, as the sidebar names it; `key` is stable across renames. */
export type WorkspaceNames = (r: UsageRecord) => { key: string; title: string } | undefined;
/**
 * Group key and label; placeholder labels (empty or `?` keys) are translated by the dashboard. A record is grouped under
 * its DSH workspace when one is known, otherwise under the directory it recorded.
 */
function dimension(r: UsageRecord, by: Dimension, workspaces?: WorkspaceNames): [string, string] {
  if (by === 'provider') { const label = providerLabel(r.provider); return [label, label]; }
  if (by === 'workspace') {
    const named = workspaces?.(r);
    return named ? [`workspace:${named.key}`, named.title] : r.workspace ? [r.workspace, r.workspace] : ['', "No workspace"];
  }
  if (by === 'model') { const model = modelOf(r); return [model, model]; }
  if (by === 'vendor') { const vendor = vendorOf(r); return [vendor, vendor]; }
  return r.host ? [r.host, r.host] : sourceOf(r.provider) === 'dsh' ? ['', "This computer"] : ['?', "Unknown host"];
}
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
    (r.host === undefined || typeof r.host === 'string' && r.host.length <= 1024) && (r.workspace === undefined || typeof r.workspace === 'string' && r.workspace.length <= 4096) &&
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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new Error("Date must be a valid YYYY-MM-DD");
  return value;
}
export function parseQuery(url: URL): Query {
  const p = url.searchParams;
  const groupBy = p.get('groupBy') ?? 'day';
  if (!isDimension(groupBy) && !['day', 'session', 'source'].includes(groupBy)) throw new Error("Unsupported grouping");
  const rawSource = p.get('source');
  let source: Source | undefined;
  if (rawSource === 'dsh' || rawSource === 'remote-agents') source = rawSource;
  else if (rawSource) throw new Error("Unsupported request source");
  const from = date(p.get('from')); const to = date(p.get('to'));
  if (from && to && from > to) throw new Error("Start date must not be later than end date");
  const filter = (key: string) => { const value = p.get(key) || undefined; if (value && value.length > 1024) throw new Error("Filter value is too long"); return value; };
  const tz = p.get('tz');
  let tzOffset: number | undefined;
  if (tz !== null && tz !== '') { tzOffset = Number(tz); if (!Number.isInteger(tzOffset) || tzOffset < -840 || tzOffset > 840) throw new Error("Unsupported time zone offset"); }
  return { from, to, groupBy: groupBy as GroupBy, source, provider: filter('provider'), model: filter('model'), sessionId: filter('sessionId'), ...(tzOffset ? { tzOffset } : {}) };
}
export function report(records: readonly UsageRecord[], query: Query, failedWrites = 0, workspaces?: WorkspaceNames): UsageReport {
  const totals = emptyTotals();
  const groups = new Map<string, UsageGroup>();
  const series = new Map<string, UsageGroup>(); const sources = new Map<string, UsageGroup>();
  const breakdowns = Object.fromEntries(DIMENSIONS.map(by => [by, new Map<string, UsageGroup>()])) as Record<Dimension, Map<string, UsageGroup>>;
  const accumulate = (map: Map<string, UsageGroup>, key: string, label: string, r: UsageRecord) => {
    let group = map.get(key);
    if (!group) { group = { key, label, totals: emptyTotals() }; map.set(key, group); }
    add(group.totals, r);
  };
  for (const r of records) {
    const day = query.tzOffset ? new Date(Date.parse(r.startedAt) + query.tzOffset * 60_000).toISOString().slice(0, 10) : r.startedAt.slice(0, 10);
    if ((query.from && day < query.from) || (query.to && day > query.to) || (query.provider && r.provider !== query.provider) || (query.model && modelOf(r) !== query.model) || (query.sessionId && r.sessionId !== query.sessionId) || (query.source && sourceOf(r.provider) !== query.source)) continue;
    add(totals, r);
    if (!isDimension(query.groupBy)) {
      const key = query.groupBy === 'day' ? day : query.groupBy === 'source' ? sourceOf(r.provider) : r.sessionId ?? '';
      const label = query.groupBy === 'source' ? SOURCE_LABELS[sourceOf(r.provider)] : query.groupBy === 'session' ? r.sessionId ?? "No session (auxiliary call)" : day;
      accumulate(groups, key, label, r);
    }
    accumulate(series, day, day, r);
    accumulate(sources, sourceOf(r.provider), SOURCE_LABELS[sourceOf(r.provider)], r);
    for (const by of DIMENSIONS) accumulate(breakdowns[by], ...dimension(r, by, workspaces), r);
  }
  const largest = (map: Map<string, UsageGroup>) => [...map.values()].sort((a, b) => b.totals.totalTokens - a.totals.totalTokens || b.totals.requests - a.totals.requests || a.label.localeCompare(b.label));
  const by = query.groupBy;
  return { totals, groups: isDimension(by) ? largest(breakdowns[by]) : [...groups.values()].sort((a, b) => by === 'day' ? b.key.localeCompare(a.key) : b.totals.totalTokens - a.totals.totalTokens || a.label.localeCompare(b.label)),
    series: [...series.values()].sort((a, b) => a.key.localeCompare(b.key)),
    sources: [...sources.values()].sort((a, b) => a.key.localeCompare(b.key)),
    breakdowns: Object.fromEntries(DIMENSIONS.map(by => [by, largest(breakdowns[by])])) as Record<Dimension, UsageGroup[]>,
    filters: { providers: [...new Set(records.map(r => r.provider))].sort(), models: [...new Set(records.map(modelOf))].sort(), sessions: [...new Set(records.flatMap(r => r.sessionId ? [r.sessionId] : []))].sort() },
    query, recordedSince: records.reduce<string | undefined>((first, r) => !first || r.startedAt < first ? r.startedAt : first, undefined), failedWrites, generatedAt: new Date().toISOString() };
}
export function toCsv(data: UsageReport): string {
  const keys = Object.keys(emptyTotals()) as Array<keyof Totals>;
  const cell = (value: string | number) => `"${String(value).replace(/^[=+@\-\t\r]/, "'$&").replaceAll('"', '""')}"`;
  return '\uFEFF' + [['group', ...keys], ...data.groups.map(g => [g.label, ...keys.map(key => g.totals[key])])].map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
}
