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
export type Source = 'dsh' | 'remote-agents' | 'mausbot';
export type SourceFilter = Source | 'without-mausbot';
/** Remote CLI turns: dsh-remote-agents routes are `remote-cli-<cli>`; records from the retired dsh-claude-ssh source are `claude-ssh-<host>`. OpenMausBot ledger rows are `mausbot-<engine>`. */
export const sourceOf = (provider: string): Source => provider.startsWith('mausbot-') ? 'mausbot' : provider.startsWith('remote-cli-') || provider.startsWith('claude-ssh-') ? 'remote-agents' : 'dsh';
export const SOURCE_LABELS: Record<Source, string> = { dsh: "DSH model calls", 'remote-agents': "Remote agents", mausbot: "MausBot" };
/** dsh-remote-agents chat routes are `<machine>/<cli>/<model>[/<speed>]`; statistics keep the model and speed. */
export function remoteModel(route: string): string {
  const [, cli, model, tier, ...extra] = route.split('/');
  if (!cli || !model || extra.length) return route;
  try { return decodeURIComponent(model) + (tier ? ` · ${decodeURIComponent(tier)}` : ''); } catch { return route; }
}
/** `tzOffset` is minutes east of UTC for day boundaries; without it days are UTC. */
export interface Query { from?: string; to?: string; provider?: string; model?: string; sessionId?: string; source?: SourceFilter; groupBy: GroupBy; tzOffset?: number }
export interface UsageGroup {
  key: string; label: string; totals: Totals;
  /** All-machines reports: the machine whose DSH holds this workspace. */
  machine?: string;
}
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
  /** Reports over several machines (`machines=`): every machine DSH Link knows, and whether its usage is in the totals. */
  machines?: MachineUsage[];
}
/**
 * One machine of an all-machines report. `counted`: its usage is in the totals (`stale` when its last answer stood in
 * for one that failed); `skipped`: not selected; `offline`: DSH Link cannot reach it; `failed`: it did not answer.
 */
export interface MachineUsage {
  id: string; name: string; self?: true; state: 'counted' | 'skipped' | 'offline' | 'failed'; error?: string; stale?: true; asOf?: string; totals?: Totals;
  /** Records left out because another machine has the same ones (copies from shared conversations). */
  copies?: number;
}
const counters = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens'] as const;
const CLI_LABELS: Record<string, string> = {
  claude: 'Claude Code', codex: 'Codex', grok: 'Grok', codebuddy: 'CodeBuddy', antigravity: 'Antigravity', dsh: 'DSH',
  pi: 'Pi', gemini: 'Gemini CLI', kimi: 'Kimi', qwen: 'Qwen Code', opencode: 'OpenCode', cursor: 'Cursor',
  droid: 'Droid', copilot: 'GitHub Copilot', 'command-code': 'Command Code', kiro: 'Kiro', cline: 'Cline',
  hermes: 'Hermes', deepseek: 'DeepSeek', 'muse-code': 'Muse Code', openai: 'OpenAI', openrouter: 'OpenRouter',
};
/** Remote turns are named by their CLI, while MausBot turns are prefixed `MausBot · <engine>` so bot usage stays distinct. */
export function providerLabel(provider: string): string {
  const remote = /^remote-cli-(.+)$/.exec(provider)?.[1];
  if (remote) return CLI_LABELS[remote] ?? remote;
  const bot = /^mausbot-(.+)$/.exec(provider)?.[1];
  if (bot) return `MausBot · ${CLI_LABELS[bot] ?? bot}`;
  return provider.startsWith('claude-ssh-') ? 'Claude Code' : provider;
}
/** Older remote main-chat records kept the chat route as their model. */
export const modelOf = (r: Pick<UsageRecord, 'provider' | 'model'>) => r.provider.startsWith('remote-cli-') ? remoteModel(r.model) : r.model;
// The same model-name and provider rules dsh-session-models uses for its vendor icons.
const MODEL_VENDORS: readonly (readonly [RegExp, string])[] = [
  [/claude|sonnet|opus|haiku/i, 'Anthropic'], [/deepseek/i, 'DeepSeek'], [/gemini|gemma/i, 'Google'], [/grok/i, 'xAI'], [/qwen|qwq/i, 'Qwen'],
  [/kimi|moonshot/i, 'Moonshot'], [/\bglm|chatglm/i, 'Zhipu'], [/doubao/i, 'Doubao'], [/minimax|\babab/i, 'MiniMax'],
  [/mistral|codestral|devstral|magistral/i, 'Mistral'], [/\bgpt|\bo[1-9](?:-|$)|codex|chatgpt/i, 'OpenAI'], [/codebuddy|workbuddy/i, 'Tencent'],
];
const PROVIDER_VENDORS: readonly (readonly [RegExp, string])[] = [
  [/anthropic|claude/i, 'Anthropic'], [/openai|codex|azure/i, 'OpenAI'], [/deepseek|^dsh$/i, 'DeepSeek'], [/gemini|google|vertex/i, 'Google'],
  [/xai|grok/i, 'xAI'], [/qwen|dashscope|bailian|alibaba/i, 'Qwen'], [/moonshot|kimi/i, 'Moonshot'], [/zhipu|bigmodel|glm/i, 'Zhipu'],
  [/doubao|volcengine/i, 'Doubao'], [/minimax/i, 'MiniMax'], [/mistral/i, 'Mistral'], [/antigravity/i, 'Google'], [/codebuddy|workbuddy/i, 'Tencent'],
];
export function vendorOf(r: Pick<UsageRecord, 'provider' | 'model'>): string {
  const model = modelOf(r), provider = r.provider.replace(/^(?:remote-cli|mausbot)-/, '');
  return MODEL_VENDORS.find(([pattern]) => pattern.test(model))?.[1] ?? PROVIDER_VENDORS.find(([pattern]) => pattern.test(provider))?.[1] ?? 'Other';
}
/** The DSH workspace a record belongs to, as the sidebar names it; `key` is stable across renames. */
export type WorkspaceNames = (r: UsageRecord) => { key: string; title: string } | undefined;
/**
 * Group key and label; placeholder labels (empty or `?` keys) are translated by the dashboard. A record is grouped under
 * its DSH workspace when one is known, otherwise under its MausBot bot or the directory it recorded.
 */
function dimension(r: UsageRecord, by: Dimension, workspaces?: WorkspaceNames): [string, string] {
  if (by === 'provider') { const label = providerLabel(r.provider); return [label, label]; }
  if (by === 'workspace') {
    const named = workspaces?.(r);
    if (named) return [`workspace:${named.key}`, named.title];
    if (r.workspace) return [sourceOf(r.provider) === 'mausbot' ? `workspace:mausbot:${r.workspace}` : r.workspace, r.workspace];
    return ['', "No workspace"];
  }
  if (by === 'model') { const model = modelOf(r); return [model, model]; }
  if (by === 'vendor') { const vendor = vendorOf(r); return [vendor, vendor]; }
  return r.host ? [r.host, r.host] : sourceOf(r.provider) !== 'remote-agents' ? ['', "This computer"] : ['?', "Unknown host"];
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
  let source: SourceFilter | undefined;
  if (rawSource === 'dsh' || rawSource === 'remote-agents' || rawSource === 'mausbot' || rawSource === 'without-mausbot') source = rawSource;
  else if (rawSource) throw new Error("Unsupported request source");
  const from = date(p.get('from')); const to = date(p.get('to'));
  if (from && to && from > to) throw new Error("Start date must not be later than end date");
  const filter = (key: string) => { const value = p.get(key) || undefined; if (value && value.length > 1024) throw new Error("Filter value is too long"); return value; };
  const tz = p.get('tz');
  let tzOffset: number | undefined;
  if (tz !== null && tz !== '') { tzOffset = Number(tz); if (!Number.isInteger(tzOffset) || tzOffset < -840 || tzOffset > 840) throw new Error("Unsupported time zone offset"); }
  return { from, to, groupBy: groupBy as GroupBy, source, provider: filter('provider'), model: filter('model'), sessionId: filter('sessionId'), ...(tzOffset ? { tzOffset } : {}) };
}
const largest = (map: Map<string, UsageGroup>) => [...map.values()].sort((a, b) => b.totals.totalTokens - a.totals.totalTokens || b.totals.requests - a.totals.requests || a.label.localeCompare(b.label));
const byKey = (map: Map<string, UsageGroup>) => [...map.values()].sort((a, b) => a.key.localeCompare(b.key));
/** Detail rows of a non-category grouping: days newest first, sessions and sources largest first. */
const detailOrder = (map: Map<string, UsageGroup>, by: GroupBy) => [...map.values()].sort((a, b) => by === 'day' ? b.key.localeCompare(a.key) : b.totals.totalTokens - a.totals.totalTokens || a.label.localeCompare(b.label));
function sum(into: Totals, from: Totals): void { for (const key of Object.keys(into) as (keyof Totals)[]) into[key] += Number.isFinite(from[key]) ? from[key] : 0; }

/** A machine's own report (or why there is none) for {@link combine}. */
export interface MachinePart { id: string; name: string; self?: true; state: MachineUsage['state']; error?: string; stale?: true; asOf?: string; report?: UsageReport; shares?: RecordShare[]; copies?: number }
/**
 * Takes out records another machine also has. Machines go by name, so every machine keeps the same copy: the first
 * machine by name that has a record keeps it. A machine whose records are not known (`shares` missing) keeps all.
 */
export function withoutCopies(parts: readonly MachinePart[], query: Query): MachinePart[] {
  const order = [...parts].filter(part => part.report && part.shares).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const seen = new Set<string>(), removed = new Map<MachinePart, RecordShare[]>();
  for (const part of order) {
    const copies = part.shares!.filter(share => seen.has(share.f));
    for (const share of part.shares!) seen.add(share.f);
    if (copies.length) removed.set(part, copies);
  }
  return parts.map(part => removed.has(part) ? { ...part, report: subtract(part.report!, removed.get(part)!, query), copies: removed.get(part)!.length } : part);
}
/**
 * Several machines' reports as one, each machine's DSH counting its own calls (a turn is recorded only by the DSH that
 * ran it, so nothing is counted twice). By host, a machine's own DSH model calls ("This computer") go under its name;
 * its workspaces stay apart from another machine's same folder and carry the machine's name.
 */
export function combine(all: readonly MachinePart[], query: Query): UsageReport {
  const parts = withoutCopies(all, query);
  const totals = emptyTotals();
  const merge = (map: Map<string, UsageGroup>, group: UsageGroup, key = group.key, label = group.label, machine?: string) => {
    let into = map.get(key);
    if (!into) { into = { key, label, totals: emptyTotals(), ...(machine ? { machine } : {}) }; map.set(key, into); }
    sum(into.totals, group.totals);
  };
  const breakdowns = Object.fromEntries(DIMENSIONS.map(by => [by, new Map<string, UsageGroup>()])) as Record<Dimension, Map<string, UsageGroup>>;
  const groups = new Map<string, UsageGroup>(), series = new Map<string, UsageGroup>(), sources = new Map<string, UsageGroup>();
  const providers = new Set<string>(), models = new Set<string>(), sessions = new Set<string>();
  let recordedSince: string | undefined, failedWrites = 0;
  const machines: MachineUsage[] = [];
  /** A group's key and label in the combined report, as {@link combine} describes. */
  const place = (by: Dimension, group: UsageGroup, part: MachinePart): [string, string, string?] => {
    if (by === 'host' && group.key === '') return [part.name, part.name];
    if (by !== 'workspace' || group.key === '') return [group.key, group.label];
    return [group.key.startsWith('workspace:') ? `workspace:${part.id}:${group.key.slice(10)}` : `${part.id}:${group.key}`, group.label, part.name];
  };
  for (const part of parts) {
    const data = part.report;
    machines.push({ id: part.id, name: part.name, ...(part.self ? { self: true as const } : {}), state: part.state, ...(part.error ? { error: part.error } : {}), ...(part.stale ? { stale: true as const } : {}), ...(part.asOf ? { asOf: part.asOf } : {}), ...(part.copies ? { copies: part.copies } : {}), ...(data ? { totals: data.totals } : {}) });
    if (!data) continue;
    sum(totals, data.totals);
    for (const by of DIMENSIONS) for (const group of data.breakdowns?.[by] ?? []) merge(breakdowns[by], group, ...place(by, group, part));
    if (!isDimension(query.groupBy)) for (const group of data.groups ?? []) merge(groups, group);
    for (const group of data.series ?? []) merge(series, group);
    for (const group of data.sources ?? []) merge(sources, group);
    for (const value of data.filters?.providers ?? []) providers.add(value);
    for (const value of data.filters?.models ?? []) models.add(value);
    for (const value of data.filters?.sessions ?? []) sessions.add(value);
    if (data.recordedSince && (!recordedSince || data.recordedSince < recordedSince)) recordedSince = data.recordedSince;
    failedWrites += data.failedWrites || 0;
  }
  const by = query.groupBy;
  return { totals, groups: isDimension(by) ? largest(breakdowns[by]) : detailOrder(groups, by), series: byKey(series), sources: byKey(sources),
    breakdowns: Object.fromEntries(DIMENSIONS.map(by => [by, largest(breakdowns[by])])) as Record<Dimension, UsageGroup[]>,
    filters: { providers: [...providers].sort(), models: [...models].sort(), sessions: [...sessions].sort() },
    query, ...(recordedSince ? { recordedSince } : {}), failedWrites, generatedAt: new Date().toISOString(), machines };
}

/** A record's date in the query's time zone. */
const dayOf = (r: UsageRecord, query: Query) => query.tzOffset ? new Date(Date.parse(r.startedAt) + query.tzOffset * 60_000).toISOString().slice(0, 10) : r.startedAt.slice(0, 10);
const matchesSource = (r: UsageRecord, source?: SourceFilter) => !source || (source === 'without-mausbot' ? sourceOf(r.provider) !== 'mausbot' : sourceOf(r.provider) === source);
const matches = (r: UsageRecord, query: Query, day = dayOf(r, query)) => !((query.from && day < query.from) || (query.to && day > query.to) || (query.provider && r.provider !== query.provider) || (query.model && modelOf(r) !== query.model) || (query.sessionId && r.sessionId !== query.sessionId) || !matchesSource(r, query.source));

/**
 * One record of a conversation another machine's DSH also has, with where it counts in this machine's report, so that a
 * copy can be taken out again. While DSHes shared conversations, both recorded their turns; such copies match in
 * every field but the random id.
 */
export interface RecordShare { f: string; day: string; source: Source; session: string; keys: Record<Dimension, string>; totals: Totals }
/** What makes two machines' records the same turn. */
export const fingerprint = (r: UsageRecord) => [r.sessionId ?? '', r.startedAt, r.provider, r.model, r.status, ...counters.map(key => r.usage?.[key] ?? '')].join('|');
/** The query's records of the given conversations. */
export function shares(records: readonly UsageRecord[], query: Query, sessions: ReadonlySet<string>, workspaces?: WorkspaceNames): RecordShare[] {
  const out: RecordShare[] = [];
  for (const r of records) {
    if (!r.sessionId || !sessions.has(r.sessionId)) continue;
    const day = dayOf(r, query);
    if (!matches(r, query, day)) continue;
    const totals = emptyTotals(); add(totals, r);
    out.push({ f: fingerprint(r), day, source: sourceOf(r.provider), session: r.sessionId, keys: Object.fromEntries(DIMENSIONS.map(by => [by, dimension(r, by, workspaces)[0]])) as Record<Dimension, string>, totals });
  }
  return out;
}
/** A machine's report without the given records. */
export function subtract(data: UsageReport, removed: readonly RecordShare[], query: Query): UsageReport {
  const out = JSON.parse(JSON.stringify(data)) as UsageReport;
  const take = (list: UsageGroup[] | undefined, key: string, share: RecordShare) => {
    const group = list?.find(g => g.key === key);
    if (group) for (const name of Object.keys(group.totals) as (keyof Totals)[]) group.totals[name] -= share.totals[name] ?? 0;
  };
  for (const share of removed) {
    for (const name of Object.keys(out.totals) as (keyof Totals)[]) out.totals[name] -= share.totals[name] ?? 0;
    for (const by of DIMENSIONS) take(out.breakdowns?.[by], share.keys[by], share);
    take(out.series, share.day, share);
    take(out.sources, share.source, share);
    if (!isDimension(query.groupBy)) take(out.groups, query.groupBy === 'day' ? share.day : query.groupBy === 'source' ? share.source : share.session, share);
  }
  const kept = (list: UsageGroup[] = []) => list.filter(g => g.totals.requests > 0);
  for (const by of DIMENSIONS) if (out.breakdowns?.[by]) out.breakdowns[by] = kept(out.breakdowns[by]);
  out.series = kept(out.series); out.sources = kept(out.sources); out.groups = isDimension(query.groupBy) ? out.breakdowns?.[query.groupBy] ?? [] : kept(out.groups);
  return out;
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
    const day = dayOf(r, query);
    if (!matches(r, query, day)) continue;
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
  const by = query.groupBy;
  return { totals, groups: isDimension(by) ? largest(breakdowns[by]) : detailOrder(groups, by),
    series: byKey(series),
    sources: byKey(sources),
    breakdowns: Object.fromEntries(DIMENSIONS.map(by => [by, largest(breakdowns[by])])) as Record<Dimension, UsageGroup[]>,
    filters: { providers: [...new Set(records.map(r => r.provider))].sort(), models: [...new Set(records.map(modelOf))].sort(), sessions: [...new Set(records.flatMap(r => r.sessionId ? [r.sessionId] : []))].sort() },
    query, recordedSince: records.reduce<string | undefined>((first, r) => !first || r.startedAt < first ? r.startedAt : first, undefined), failedWrites, generatedAt: new Date().toISOString() };
}
export function toCsv(data: UsageReport): string {
  const keys = Object.keys(emptyTotals()) as Array<keyof Totals>;
  const cell = (value: string | number) => `"${String(value).replace(/^[=+@\-\t\r]/, "'$&").replaceAll('"', '""')}"`;
  return '\uFEFF' + [['group', ...keys], ...data.groups.map(g => [g.label, ...keys.map(key => g.totals[key])])].map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
}
