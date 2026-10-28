/** Remote CLI turns: dsh-remote-agents routes are `remote-cli-<cli>`; records from the retired dsh-claude-ssh source are `claude-ssh-<host>`. */
export const sourceOf = (provider) => provider.startsWith('remote-cli-') || provider.startsWith('claude-ssh-') ? 'remote-agents' : 'dsh';
export const SOURCE_LABELS = { dsh: "DSH model calls", 'remote-agents': "Remote agents" };
/** dsh-remote-agents chat routes are `<machine>/<cli>/<model>[/<speed>]`; statistics keep the model and speed. */
export function remoteModel(route) {
    const [, cli, model, tier, ...extra] = route.split('/');
    if (!cli || !model || extra.length)
        return route;
    try {
        return decodeURIComponent(model) + (tier ? ` · ${decodeURIComponent(tier)}` : '');
    }
    catch {
        return route;
    }
}
export const DIMENSIONS = ['provider', 'workspace', 'model', 'vendor', 'host'];
const isDimension = (value) => DIMENSIONS.includes(value);
const counters = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens'];
const CLI_LABELS = { claude: 'Claude Code', codex: 'Codex', grok: 'Grok', codebuddy: 'CodeBuddy', antigravity: 'Antigravity', dsh: 'DSH' };
/** Remote turns are named by their CLI, which merges a CLI's turns across machines; DSH providers keep their ID. */
export function providerLabel(provider) {
    const cli = /^remote-cli-(.+)$/.exec(provider)?.[1];
    return cli ? CLI_LABELS[cli] ?? cli : provider.startsWith('claude-ssh-') ? 'Claude Code' : provider;
}
/** Older remote main-chat records kept the chat route as their model. */
export const modelOf = (r) => r.provider.startsWith('remote-cli-') ? remoteModel(r.model) : r.model;
// The same model-name and provider rules dsh-session-models uses for its vendor icons.
const MODEL_VENDORS = [
    [/claude|sonnet|opus|haiku/i, 'Anthropic'], [/deepseek/i, 'DeepSeek'], [/gemini|gemma/i, 'Google'], [/grok/i, 'xAI'], [/qwen|qwq/i, 'Qwen'],
    [/kimi|moonshot/i, 'Moonshot'], [/\bglm|chatglm/i, 'Zhipu'], [/doubao/i, 'Doubao'], [/minimax|\babab/i, 'MiniMax'],
    [/mistral|codestral|devstral|magistral/i, 'Mistral'], [/\bgpt|\bo[1-9](?:-|$)|codex|chatgpt/i, 'OpenAI'],
];
const PROVIDER_VENDORS = [
    [/anthropic|claude/i, 'Anthropic'], [/openai|codex|azure/i, 'OpenAI'], [/deepseek|^dsh$/i, 'DeepSeek'], [/gemini|google|vertex/i, 'Google'],
    [/xai|grok/i, 'xAI'], [/qwen|dashscope|bailian|alibaba/i, 'Qwen'], [/moonshot|kimi/i, 'Moonshot'], [/zhipu|bigmodel|glm/i, 'Zhipu'],
    [/doubao|volcengine/i, 'Doubao'], [/minimax/i, 'MiniMax'], [/mistral/i, 'Mistral'], [/antigravity/i, 'Google'], [/codebuddy/i, 'Tencent'],
];
export function vendorOf(r) {
    const model = modelOf(r), provider = r.provider.replace(/^remote-cli-/, '');
    return MODEL_VENDORS.find(([pattern]) => pattern.test(model))?.[1] ?? PROVIDER_VENDORS.find(([pattern]) => pattern.test(provider))?.[1] ?? 'Other';
}
/** Group key and label; placeholder labels (empty or `?` keys) are translated by the dashboard. */
function dimension(r, by) {
    if (by === 'provider') {
        const label = providerLabel(r.provider);
        return [label, label];
    }
    if (by === 'workspace')
        return r.workspace ? [r.workspace, r.workspace] : ['', "No workspace"];
    if (by === 'model') {
        const model = modelOf(r);
        return [model, model];
    }
    if (by === 'vendor') {
        const vendor = vendorOf(r);
        return [vendor, vendor];
    }
    return r.host ? [r.host, r.host] : sourceOf(r.provider) === 'dsh' ? ['', "This computer"] : ['?', "Unknown host"];
}
export function validUsage(value) {
    if (!value || typeof value !== 'object')
        return false;
    const usage = value;
    return counters.every(key => usage[key] === undefined ? key !== 'inputTokens' && key !== 'outputTokens' : Number.isSafeInteger(usage[key]) && Number(usage[key]) >= 0);
}
export function validRecord(value) {
    if (!value || typeof value !== 'object')
        return false;
    const r = value;
    return typeof r.id === 'string' && typeof r.startedAt === 'string' && Number.isFinite(Date.parse(r.startedAt)) &&
        typeof r.provider === 'string' && typeof r.model === 'string' && typeof r.purpose === 'string' &&
        (r.sessionId === undefined || typeof r.sessionId === 'string') && ['completed', 'error', 'cancelled'].includes(r.status) &&
        (r.host === undefined || typeof r.host === 'string' && r.host.length <= 1024) && (r.workspace === undefined || typeof r.workspace === 'string' && r.workspace.length <= 4096) &&
        Number.isFinite(r.durationMs) && r.durationMs >= 0 && (r.usage === undefined || validUsage(r.usage));
}
function emptyTotals() {
    return { requests: 0, completed: 0, errors: 0, cancelled: 0, withUsage: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 0 };
}
function add(t, r) {
    t.requests++;
    if (r.status === 'error')
        t.errors++;
    else
        t[r.status]++;
    if (!r.usage)
        return;
    t.withUsage++;
    for (const key of counters)
        if (key !== 'totalTokens')
            t[key] += r.usage[key] ?? 0;
    // Reasoning is a subset of output, while cache counters are disjoint from uncached input.
    t.totalTokens += r.usage.totalTokens ?? r.usage.inputTokens + r.usage.outputTokens + (r.usage.cacheReadTokens ?? 0) + (r.usage.cacheWriteTokens ?? 0);
}
function date(value) {
    if (value === null || value === '')
        return undefined;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)
        throw new Error("Date must be a valid YYYY-MM-DD");
    return value;
}
export function parseQuery(url) {
    const p = url.searchParams;
    const groupBy = p.get('groupBy') ?? 'day';
    if (!isDimension(groupBy) && !['day', 'session', 'source'].includes(groupBy))
        throw new Error("Unsupported grouping");
    const rawSource = p.get('source');
    let source;
    if (rawSource === 'dsh' || rawSource === 'remote-agents')
        source = rawSource;
    else if (rawSource)
        throw new Error("Unsupported request source");
    const from = date(p.get('from'));
    const to = date(p.get('to'));
    if (from && to && from > to)
        throw new Error("Start date must not be later than end date");
    const filter = (key) => { const value = p.get(key) || undefined; if (value && value.length > 1024)
        throw new Error("Filter value is too long"); return value; };
    const tz = p.get('tz');
    let tzOffset;
    if (tz !== null && tz !== '') {
        tzOffset = Number(tz);
        if (!Number.isInteger(tzOffset) || tzOffset < -840 || tzOffset > 840)
            throw new Error("Unsupported time zone offset");
    }
    return { from, to, groupBy: groupBy, source, provider: filter('provider'), model: filter('model'), sessionId: filter('sessionId'), ...(tzOffset ? { tzOffset } : {}) };
}
export function report(records, query, failedWrites = 0) {
    const totals = emptyTotals();
    const groups = new Map();
    const series = new Map();
    const sources = new Map();
    const breakdowns = Object.fromEntries(DIMENSIONS.map(by => [by, new Map()]));
    const accumulate = (map, key, label, r) => {
        let group = map.get(key);
        if (!group) {
            group = { key, label, totals: emptyTotals() };
            map.set(key, group);
        }
        add(group.totals, r);
    };
    for (const r of records) {
        const day = query.tzOffset ? new Date(Date.parse(r.startedAt) + query.tzOffset * 60_000).toISOString().slice(0, 10) : r.startedAt.slice(0, 10);
        if ((query.from && day < query.from) || (query.to && day > query.to) || (query.provider && r.provider !== query.provider) || (query.model && modelOf(r) !== query.model) || (query.sessionId && r.sessionId !== query.sessionId) || (query.source && sourceOf(r.provider) !== query.source))
            continue;
        add(totals, r);
        if (!isDimension(query.groupBy)) {
            const key = query.groupBy === 'day' ? day : query.groupBy === 'source' ? sourceOf(r.provider) : r.sessionId ?? '';
            const label = query.groupBy === 'source' ? SOURCE_LABELS[sourceOf(r.provider)] : query.groupBy === 'session' ? r.sessionId ?? "No session (auxiliary call)" : day;
            accumulate(groups, key, label, r);
        }
        accumulate(series, day, day, r);
        accumulate(sources, sourceOf(r.provider), SOURCE_LABELS[sourceOf(r.provider)], r);
        for (const by of DIMENSIONS)
            accumulate(breakdowns[by], ...dimension(r, by), r);
    }
    const largest = (map) => [...map.values()].sort((a, b) => b.totals.totalTokens - a.totals.totalTokens || b.totals.requests - a.totals.requests || a.label.localeCompare(b.label));
    const by = query.groupBy;
    return { totals, groups: isDimension(by) ? largest(breakdowns[by]) : [...groups.values()].sort((a, b) => by === 'day' ? b.key.localeCompare(a.key) : b.totals.totalTokens - a.totals.totalTokens || a.label.localeCompare(b.label)),
        series: [...series.values()].sort((a, b) => a.key.localeCompare(b.key)),
        sources: [...sources.values()].sort((a, b) => a.key.localeCompare(b.key)),
        breakdowns: Object.fromEntries(DIMENSIONS.map(by => [by, largest(breakdowns[by])])),
        filters: { providers: [...new Set(records.map(r => r.provider))].sort(), models: [...new Set(records.map(modelOf))].sort(), sessions: [...new Set(records.flatMap(r => r.sessionId ? [r.sessionId] : []))].sort() },
        query, recordedSince: records.reduce((first, r) => !first || r.startedAt < first ? r.startedAt : first, undefined), failedWrites, generatedAt: new Date().toISOString() };
}
export function toCsv(data) {
    const keys = Object.keys(emptyTotals());
    const cell = (value) => `"${String(value).replace(/^[=+@\-\t\r]/, "'$&").replaceAll('"', '""')}"`;
    return '\uFEFF' + [['group', ...keys], ...data.groups.map(g => [g.label, ...keys.map(key => g.totals[key])])].map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
}
