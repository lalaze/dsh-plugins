import type { AccountUsage, ContextUsage, NativeProtocol, QuotaWindow } from './domain.js';
import type { JsonlPeer } from './ssh.js';

const list = (value: unknown): any[] => Array.isArray(value) ? value : [];
const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
const capitalize = (value: string) => value ? value[0].toUpperCase() + value.slice(1) : value;
/** Context fill, or nothing until the CLI has reported a window size. */
export function contextUsage(used: unknown, max: unknown): ContextUsage | undefined {
  const tokens = count(used), size = count(max);
  return tokens !== undefined && size ? { used: tokens, max: size } : undefined;
}
/** Codex `thread/tokenUsage/updated`: the last request's total is what the context window holds. */
export const codexContext = (usage: any) => contextUsage(usage?.last?.totalTokens ?? usage?.last?.total_tokens, usage?.modelContextWindow ?? usage?.model_context_window);
/** Claude API usage of one assistant message: everything sent plus what it generated. */
export function claudeMessageTokens(usage: any): number | undefined {
  const parts = [usage?.input_tokens, usage?.cache_creation_input_tokens, usage?.cache_read_input_tokens, usage?.output_tokens].map(count);
  return parts[0] === undefined ? undefined : parts.reduce<number>((sum, part) => sum + (part ?? 0), 0);
}

function windowLabel(minutes: number | undefined): string {
  if (minutes === 300) return 'Session';
  if (minutes === 10_080) return 'Weekly';
  if (!minutes) return 'Limit';
  return minutes % 1440 === 0 ? `${minutes / 1440}d` : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
}
function percent(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : undefined;
}
function codexWindows(snapshot: any, prefix?: string): QuotaWindow[] {
  return (['primary', 'secondary'] as const).flatMap(key => {
    const window = snapshot?.[key], used = percent(window?.usedPercent);
    if (used === undefined) return [];
    const label = windowLabel(count(window.windowDurationMins));
    const resetsAt = count(window.resetsAt);
    return [{ id: `${prefix ?? 'codex'}:${key}`, label: prefix ? `${prefix} · ${label}` : label, usedPercent: used, ...(resetsAt ? { resetsAt: new Date(resetsAt * 1000).toISOString() } : {}) }];
  });
}
/** Codex `account/read` and `account/rateLimits/read`. Extra metered buckets follow the main one. */
export function codexAccountUsage(account: any, limits: any, checkedAt = new Date().toISOString()): AccountUsage {
  const main = limits?.rateLimits, plan = account?.account?.planType ?? main?.planType;
  const others = Object.entries(limits?.rateLimitsByLimitId ?? {}).filter(([id]) => id !== (main?.limitId ?? 'codex'));
  const credits = main?.credits;
  return {
    provider: 'codex', checkedAt,
    ...(typeof plan === 'string' && plan !== 'unknown' ? { plan: capitalize(plan) } : {}),
    ...(typeof account?.account?.email === 'string' ? { email: account.account.email } : {}),
    windows: [...codexWindows(main), ...others.flatMap(([id, snapshot]: [string, any]) => codexWindows(snapshot, String(snapshot?.limitName ?? id)))],
    ...(credits?.unlimited ? { credits: 'Unlimited' } : credits?.hasCredits && typeof credits.balance === 'string' ? { credits: credits.balance } : {}),
  };
}
const CLAUDE_WINDOWS: [string, string][] = [['five_hour', 'Session'], ['seven_day', 'Weekly'], ['seven_day_opus', 'Weekly · Opus'], ['seven_day_sonnet', 'Weekly · Sonnet']];
/** Claude `initialize` account details and the `get_usage` control response behind `/usage`. */
export function claudeAccountUsage(account: any, usage: any, checkedAt = new Date().toISOString()): AccountUsage {
  const limits = usage?.rate_limits, plan = typeof usage?.subscription_type === 'string' ? capitalize(usage.subscription_type) : account?.subscriptionType;
  const windows: QuotaWindow[] = [
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
export async function readAccountUsage(peer: JsonlPeer, protocol: NativeProtocol, claudeAccount?: unknown): Promise<AccountUsage> {
  if (protocol === 'codex') {
    const [account, limits] = await Promise.all([peer.request('account/read', {}, 20_000).catch(() => undefined), peer.request('account/rateLimits/read', {}, 20_000)]);
    return codexAccountUsage(account, limits);
  }
  if (protocol === 'claude') return claudeAccountUsage(claudeAccount, await peer.control({ subtype: 'get_usage' }, 20_000));
  throw new Error('This CLI does not report plan limits');
}
