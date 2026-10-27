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
