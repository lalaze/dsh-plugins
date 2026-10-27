const list = (value) => Array.isArray(value) ? value : [];
const count = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
const capitalize = (value) => value ? value[0].toUpperCase() + value.slice(1) : value;
/** Context fill, or nothing until the CLI has reported a window size. */
export function contextUsage(used, max) {
    const tokens = count(used), size = count(max);
    return tokens !== undefined && size ? { used: tokens, max: size } : undefined;
}
/** Codex `thread/tokenUsage/updated`: the last request's total is what the context window holds. */
export const codexContext = (usage) => contextUsage(usage?.last?.totalTokens ?? usage?.last?.total_tokens, usage?.modelContextWindow ?? usage?.model_context_window);
const optional = (key, value) => value ? { [key]: value } : {};
/** Claude's `result.usage`: the whole turn, across every model call it made. */
export function claudeTurnUsage(usage) {
    const input = count(usage?.input_tokens), output = count(usage?.output_tokens);
    if (input === undefined || output === undefined)
        return undefined;
    return { inputTokens: input, outputTokens: output, ...optional('cacheReadTokens', count(usage?.cache_read_input_tokens)), ...optional('cacheWriteTokens', count(usage?.cache_creation_input_tokens)) };
}
/** Codex counters, whose input includes cached input. */
function codexCounters(value) {
    const pick = (camel, snake) => count(value?.[camel] ?? value?.[snake]) ?? 0;
    return { input: pick('inputTokens', 'input_tokens'), cached: pick('cachedInputTokens', 'cached_input_tokens'), output: pick('outputTokens', 'output_tokens'), reasoning: pick('reasoningOutputTokens', 'reasoning_output_tokens'), total: pick('totalTokens', 'total_tokens') };
}
/** Codex reports running thread totals; a turn used the difference since the previous turn ended. */
export function codexTurnUsage(total, before) {
    if (!total)
        return undefined;
    const now = codexCounters(total), then = codexCounters(before);
    // A new or compacted thread restarts its counters; its total is then this turn's usage.
    const base = Object.values(now).some((value, i) => value < Object.values(then)[i]) ? codexCounters(undefined) : then;
    const input = now.input - base.input, cached = now.cached - base.cached, output = now.output - base.output;
    if (input + output <= 0)
        return undefined;
    return { inputTokens: Math.max(0, input - cached), outputTokens: output, ...optional('cacheReadTokens', cached), ...optional('reasoningTokens', now.reasoning - base.reasoning), ...optional('totalTokens', now.total - base.total) };
}
/** ACP's optional `PromptResponse.usage` for one prompt turn. */
export function acpTurnUsage(usage) {
    const input = count(usage?.inputTokens), output = count(usage?.outputTokens);
    if (input === undefined || output === undefined)
        return undefined;
    const read = count(usage?.cachedReadTokens), write = count(usage?.cachedWriteTokens), total = count(usage?.totalTokens);
    // ACP leaves open whether input includes cached tokens; a total that adds up with them listed separately says it does not.
    const separate = total !== undefined && input + output + (read ?? 0) + (write ?? 0) === total;
    return { inputTokens: separate ? input : Math.max(0, input - (read ?? 0) - (write ?? 0)), outputTokens: output, ...optional('cacheReadTokens', read), ...optional('cacheWriteTokens', write), ...optional('reasoningTokens', count(usage?.thoughtTokens)), ...optional('totalTokens', count(usage?.totalTokens)) };
}
/** Claude API usage of one assistant message: everything sent plus what it generated. */
export function claudeMessageTokens(usage) {
    const parts = [usage?.input_tokens, usage?.cache_creation_input_tokens, usage?.cache_read_input_tokens, usage?.output_tokens].map(count);
    return parts[0] === undefined ? undefined : parts.reduce((sum, part) => sum + (part ?? 0), 0);
}
function windowLabel(minutes) {
    if (minutes === 300)
        return 'Session';
    if (minutes === 10_080)
        return 'Weekly';
    if (!minutes)
        return 'Limit';
    return minutes % 1440 === 0 ? `${minutes / 1440}d` : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
}
function percent(value) {
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : undefined;
}
function codexWindows(snapshot, prefix) {
    return ['primary', 'secondary'].flatMap(key => {
        const window = snapshot?.[key], used = percent(window?.usedPercent);
        if (used === undefined)
            return [];
        const label = windowLabel(count(window.windowDurationMins));
        const resetsAt = count(window.resetsAt);
        return [{ id: `${prefix ?? 'codex'}:${key}`, label: prefix ? `${prefix} · ${label}` : label, usedPercent: used, ...(resetsAt ? { resetsAt: new Date(resetsAt * 1000).toISOString() } : {}) }];
    });
}
/** Codex `account/read` and `account/rateLimits/read`. Extra metered buckets follow the main one. */
export function codexAccountUsage(account, limits, checkedAt = new Date().toISOString()) {
    const main = limits?.rateLimits, plan = account?.account?.planType ?? main?.planType;
    const others = Object.entries(limits?.rateLimitsByLimitId ?? {}).filter(([id]) => id !== (main?.limitId ?? 'codex'));
    const credits = main?.credits;
    return {
        provider: 'codex', checkedAt,
        ...(typeof plan === 'string' && plan !== 'unknown' ? { plan: capitalize(plan) } : {}),
        ...(typeof account?.account?.email === 'string' ? { email: account.account.email } : {}),
        windows: [...codexWindows(main), ...others.flatMap(([id, snapshot]) => codexWindows(snapshot, String(snapshot?.limitName ?? id)))],
        ...(credits?.unlimited ? { credits: 'Unlimited' } : credits?.hasCredits && typeof credits.balance === 'string' ? { credits: credits.balance } : {}),
    };
}
const CLAUDE_WINDOWS = [['five_hour', 'Session'], ['seven_day', 'Weekly'], ['seven_day_opus', 'Weekly · Opus'], ['seven_day_sonnet', 'Weekly · Sonnet']];
/** Claude `initialize` account details and the `get_usage` control response behind `/usage`. */
export function claudeAccountUsage(account, usage, checkedAt = new Date().toISOString()) {
    const limits = usage?.rate_limits, plan = typeof usage?.subscription_type === 'string' ? capitalize(usage.subscription_type) : account?.subscriptionType;
    const windows = [
        ...CLAUDE_WINDOWS.map(([id, label]) => ({ id, label, window: limits?.[id] })),
        ...list(limits?.model_scoped).map((window, index) => ({ id: `model_scoped:${index}`, label: `Weekly · ${window?.display_name ?? 'Model'}`, window })),
    ].flatMap(({ id, label, window }) => {
        const used = percent(window?.utilization);
        return used === undefined ? [] : [{ id, label, usedPercent: used, ...(typeof window.resets_at === 'string' ? { resetsAt: window.resets_at } : {}) }];
    });
    return {
        provider: 'claude', checkedAt, windows,
        ...(typeof plan === 'string' && plan ? { plan } : {}),
        ...(typeof account?.email === 'string' ? { email: account.email } : {}),
        ...(typeof limits?.extra_usage?.is_enabled === 'boolean' ? { extraUsage: limits.extra_usage.is_enabled } : {}),
    };
}
/** Read plan limits through the CLI itself, so credentials never leave the SSH host. */
export async function readAccountUsage(peer, protocol, claudeAccount) {
    if (protocol === 'codex') {
        const [account, limits] = await Promise.all([peer.request('account/read', {}, 20_000).catch(() => undefined), peer.request('account/rateLimits/read', {}, 20_000)]);
        return codexAccountUsage(account, limits);
    }
    if (protocol === 'claude')
        return claudeAccountUsage(claudeAccount, await peer.control({ subtype: 'get_usage' }, 20_000));
    throw new Error('This CLI does not report plan limits');
}
