export const sourceOf = (provider) => provider.startsWith('claude-ssh-') ? 'claude-ssh' : 'dsh';
const counters = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens'];
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
        throw new Error("Date must be a valid YYYY-MM-DD (UTC)");
    return value;
}
export function parseQuery(url) {
    const p = url.searchParams;
    const groupBy = p.get('groupBy') ?? 'day';
    if (!['day', 'model', 'session', 'source'].includes(groupBy))
        throw new Error("Unsupported grouping");
    const rawSource = p.get('source');
    let source;
    if (rawSource === 'dsh' || rawSource === 'claude-ssh')
        source = rawSource;
    else if (rawSource)
        throw new Error("Unsupported request source");
    const from = date(p.get('from'));
    const to = date(p.get('to'));
    if (from && to && from > to)
        throw new Error("Start date must not be later than end date");
    const filter = (key) => { const value = p.get(key) || undefined; if (value && value.length > 1024)
        throw new Error("Filter value is too long"); return value; };
    return { from, to, groupBy: groupBy, source, provider: filter('provider'), model: filter('model'), sessionId: filter('sessionId') };
}
export function report(records, query, failedWrites = 0) {
    const totals = emptyTotals();
    const groups = new Map();
    const series = new Map();
    const sources = new Map();
    const accumulate = (map, key, label, r) => {
        let group = map.get(key);
        if (!group) {
            group = { key, label, totals: emptyTotals() };
            map.set(key, group);
        }
        add(group.totals, r);
    };
    for (const r of records) {
        const day = r.startedAt.slice(0, 10);
        if ((query.from && day < query.from) || (query.to && day > query.to) || (query.provider && r.provider !== query.provider) || (query.model && r.model !== query.model) || (query.sessionId && r.sessionId !== query.sessionId) || (query.source && sourceOf(r.provider) !== query.source))
            continue;
        const key = query.groupBy === 'day' ? day : query.groupBy === 'source' ? sourceOf(r.provider) : query.groupBy === 'model' ? JSON.stringify([r.provider, r.model]) : r.sessionId ?? '';
        const label = query.groupBy === 'source' ? sourceOf(r.provider) === 'dsh' ? "DSH model calls" : "Remote Claude SSH" : query.groupBy === 'model' ? `${r.provider} / ${r.model}` : query.groupBy === 'session' ? r.sessionId ?? "No session (auxiliary call)" : day;
        add(totals, r);
        accumulate(groups, key, label, r);
        accumulate(series, day, day, r);
        accumulate(sources, sourceOf(r.provider), sourceOf(r.provider) === 'dsh' ? "DSH model calls" : "Remote Claude SSH", r);
    }
    return { totals, groups: [...groups.values()].sort((a, b) => query.groupBy === 'day' ? b.key.localeCompare(a.key) : b.totals.totalTokens - a.totals.totalTokens || a.label.localeCompare(b.label)),
        series: [...series.values()].sort((a, b) => a.key.localeCompare(b.key)),
        sources: [...sources.values()].sort((a, b) => a.key.localeCompare(b.key)),
        filters: { providers: [...new Set(records.map(r => r.provider))].sort(), models: [...new Set(records.map(r => r.model))].sort(), sessions: [...new Set(records.flatMap(r => r.sessionId ? [r.sessionId] : []))].sort() },
        query, recordedSince: records.reduce((first, r) => !first || r.startedAt < first ? r.startedAt : first, undefined), failedWrites, generatedAt: new Date().toISOString() };
}
export function toCsv(data) {
    const keys = Object.keys(emptyTotals());
    const cell = (value) => `"${String(value).replace(/^[=+@\-\t\r]/, "'$&").replaceAll('"', '""')}"`;
    return '\uFEFF' + [['group', ...keys], ...data.groups.map(g => [g.label, ...keys.map(key => g.totals[key])])].map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
}
