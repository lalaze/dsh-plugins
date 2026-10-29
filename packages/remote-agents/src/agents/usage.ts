import { randomUUID } from 'node:crypto';
import type { AccountUsage, ContextUsage, FinishedTurn, HostConfig, NativeProtocol, QuotaWindow, Task, TokenUsage, TokenUsageBreakdown, TurnUsage } from '../core/domain.js';
import type { JsonlPeer } from '../core/ssh.js';
import { list } from '../core/domain.js';

const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
const capitalize = (value: string) => value ? value[0].toUpperCase() + value.slice(1) : value;
/** Context fill, or nothing until the CLI has reported a window size. */
export function contextUsage(used: unknown, max: unknown): ContextUsage | undefined {
  const tokens = count(used), size = count(max);
  return tokens !== undefined && size ? { used: tokens, max: size } : undefined;
}
/** Codex `thread/tokenUsage/updated`: the last request's total is what the context window holds. */
export const codexContext = (usage: any) => contextUsage(usage?.last?.totalTokens ?? usage?.last?.total_tokens, usage?.modelContextWindow ?? usage?.model_context_window);
const optional = (key: keyof TurnUsage, value: number | undefined) => value ? { [key]: value } : {};
/** One finished remote turn's usage, in dsh-usage-stats' record shape, with the machine and remote directory it ran in. */
export interface RemoteUsageRecord {
  id: string; startedAt: string; provider: string; model: string; sessionId?: string;
  purpose: 'conversation' | 'delegation' | 'remote-session'; status: 'completed' | 'error'; durationMs: number; usage: TurnUsage;
  host?: string; workspace?: string;
}
/**
 * Providers match the `remote-cli-<cli>` chat routes; sessions are the DSH conversation, or the agent for other turns.
 * The model is the one the CLI reported running, or the task's selection when it named none.
 */
export function remoteUsageRecord(task: Task, hosts: readonly HostConfig[], usage: TurnUsage, turn: FinishedTurn, now = Date.now()): RemoteUsageRecord {
  const started = turn.startedAt ? Date.parse(turn.startedAt) : NaN, host = hosts.find(h => h.id === task.hostId);
  return {
    id: randomUUID(), startedAt: new Date(Number.isFinite(started) ? started : now).toISOString(),
    provider: `remote-cli-${task.provider}`, model: turn.model ?? task.model, sessionId: task.chat?.sessionId ?? `remote-agent:${task.id}`,
    purpose: task.chat ? 'conversation' : task.origin === 'dsh' ? 'delegation' : 'remote-session', status: turn.failed ? 'error' : 'completed',
    durationMs: Number.isFinite(started) ? Math.max(0, now - started) : 0, usage,
    ...(host ? { host: host.label } : {}), workspace: task.executionCwd ?? task.cwd,
  };
}
/** Claude's `result.usage`: the whole turn, across every model call it made. */
export function claudeTurnUsage(usage: any): TurnUsage | undefined {
  const input = count(usage?.input_tokens), output = count(usage?.output_tokens);
  if (input === undefined || output === undefined) return undefined;
  return { inputTokens: input, outputTokens: output, ...optional('cacheReadTokens', count(usage?.cache_read_input_tokens)), ...optional('cacheWriteTokens', count(usage?.cache_creation_input_tokens)) };
}
/** Codex counters, whose input includes cached input. */
function codexCounters(value: any) {
  const pick = (camel: string, snake: string) => count(value?.[camel] ?? value?.[snake]) ?? 0;
  return { input: pick('inputTokens', 'input_tokens'), cached: pick('cachedInputTokens', 'cached_input_tokens'), output: pick('outputTokens', 'output_tokens'), reasoning: pick('reasoningOutputTokens', 'reasoning_output_tokens'), total: pick('totalTokens', 'total_tokens') };
}
/** Codex reports running thread totals; a turn used the difference since the previous turn ended. */
export function codexTurnUsage(total: any, before: any): TurnUsage | undefined {
  if (!total) return undefined;
  const now = codexCounters(total), then = codexCounters(before);
  // A new or compacted thread restarts its counters; its total is then this turn's usage.
  const base = Object.values(now).some((value, i) => value < Object.values(then)[i]) ? codexCounters(undefined) : then;
  const input = now.input - base.input, cached = now.cached - base.cached, output = now.output - base.output;
  if (input + output <= 0) return undefined;
  return { inputTokens: Math.max(0, input - cached), outputTokens: output, ...optional('cacheReadTokens', cached), ...optional('reasoningTokens', now.reasoning - base.reasoning), ...optional('totalTokens', now.total - base.total) };
}
/** ACP's optional `PromptResponse.usage` for one prompt turn. */
export function acpTurnUsage(usage: any): TurnUsage | undefined {
  const input = count(usage?.inputTokens), output = count(usage?.outputTokens);
  if (input === undefined || output === undefined) return undefined;
  const read = count(usage?.cachedReadTokens), write = count(usage?.cachedWriteTokens), total = count(usage?.totalTokens);
  // ACP leaves open whether input includes cached tokens; a total that adds up with them listed separately says it does not.
  const separate = total !== undefined && input + output + (read ?? 0) + (write ?? 0) === total;
  return { inputTokens: separate ? input : Math.max(0, input - (read ?? 0) - (write ?? 0)), outputTokens: output, ...optional('cacheReadTokens', read), ...optional('cacheWriteTokens', write), ...optional('reasoningTokens', count(usage?.thoughtTokens)), ...optional('totalTokens', count(usage?.totalTokens)) };
}
/** Claude API usage of one assistant message: everything sent plus what it generated. */
export function claudeMessageTokens(usage: any): number | undefined {
  const parts = [usage?.input_tokens, usage?.cache_creation_input_tokens, usage?.cache_read_input_tokens, usage?.output_tokens].map(count);
  return parts[0] === undefined ? undefined : parts.reduce<number>((sum, part) => sum + (part ?? 0), 0);
}

function tokenBreakdown(input: unknown, read: unknown, write: unknown, output: unknown): TokenUsageBreakdown | undefined {
  const fields = { inputTokens: count(input), cachedInputTokens: count(read), cacheWriteInputTokens: count(write), outputTokens: count(output) };
  const reported = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
  return Object.keys(reported).length ? reported : undefined;
}
/** Codex input already includes cached input; snapshots must not be added together. */
export function codexTokenUsage(usage: any): TokenUsage | undefined {
  const parse = (value: any) => tokenBreakdown(value?.inputTokens ?? value?.input_tokens, value?.cachedInputTokens ?? value?.cached_input_tokens,
    value?.cacheWriteInputTokens ?? value?.cache_write_input_tokens, value?.outputTokens ?? value?.output_tokens);
  const last = parse(usage?.last), total = parse(usage?.total);
  return last || total ? { ...(last ? { last } : {}), ...(total ? { total } : {}) } : undefined;
}
/** Claude's uncached input, cache reads and cache writes are disjoint counters. */
export function claudeTokenUsage(usage: any): TokenUsage | undefined {
  const input = [usage?.input_tokens, usage?.cache_read_input_tokens, usage?.cache_creation_input_tokens].map(count);
  // Without all three counters the complete input denominator is unknown.
  const totalInput = input.every(value => value !== undefined) ? input.reduce<number>((sum, value) => sum + value!, 0) : undefined;
  const last = tokenBreakdown(totalInput, usage?.cache_read_input_tokens, usage?.cache_creation_input_tokens, usage?.output_tokens);
  return last ? { last } : undefined;
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
