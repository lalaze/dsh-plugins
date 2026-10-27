import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claudeAccountUsage, claudeMessageTokens, codexAccountUsage, codexContext } from '../src/usage.js';
import { formatReset, formatTokens } from '../src/client/usage.js';
import { fixture } from './fakes.js';

const checkedAt = '2026-10-26T00:00:00.000Z';

test('Codex token reports and account limits become the ring and its plan windows', () => {
  assert.deepEqual(codexContext({ last: { totalTokens: 169_000 }, total: { totalTokens: 900_000 }, modelContextWindow: 1_000_000 }), { used: 169_000, max: 1_000_000 });
  assert.equal(codexContext({ last: { totalTokens: 10 }, modelContextWindow: null }), undefined, 'no window size, no ring value');
  const limits = {
    rateLimits: { limitId: 'codex', primary: { usedPercent: 18, windowDurationMins: 300, resetsAt: 1_793_053_276 }, secondary: { usedPercent: 3, windowDurationMins: 10_080, resetsAt: null }, credits: { hasCredits: false, unlimited: false, balance: '0' }, planType: 'plus' },
    rateLimitsByLimitId: { codex: {}, review: { limitName: 'Code review', primary: { usedPercent: 40, windowDurationMins: 1440 } } },
  };
  assert.deepEqual(codexAccountUsage({ account: { type: 'chatgpt', email: 'dev@example.com', planType: 'pro' } }, limits, checkedAt), {
    provider: 'codex', checkedAt, plan: 'Pro', email: 'dev@example.com',
    windows: [
      { id: 'codex:primary', label: 'Session', usedPercent: 18, resetsAt: new Date(1_793_053_276_000).toISOString() },
      { id: 'codex:secondary', label: 'Weekly', usedPercent: 3 },
      { id: 'Code review:primary', label: 'Code review · 1d', usedPercent: 40 },
    ],
  });
  assert.equal(codexAccountUsage({ account: { type: 'apiKey' } }, { rateLimits: { credits: { unlimited: true } } }, checkedAt).credits, 'Unlimited');
});

test('Claude usage reports keep the windows the account has and the extra usage switch', () => {
  assert.equal(claudeMessageTokens({ input_tokens: 3, cache_creation_input_tokens: 100, cache_read_input_tokens: 160_000, output_tokens: 900 }), 161_003);
  assert.equal(claudeMessageTokens({}), undefined);
  const usage = { subscription_type: 'max', rate_limits_available: true, rate_limits: {
    five_hour: { utilization: 18, resets_at: '2026-10-26T04:00:00Z' }, seven_day: { utilization: 35, resets_at: null }, seven_day_opus: null,
    model_scoped: [{ display_name: 'Fable', utilization: 60, resets_at: '2026-10-29T00:00:00Z' }], extra_usage: { is_enabled: false },
  } };
  assert.deepEqual(claudeAccountUsage({ email: 'dev@example.com', subscriptionType: 'Claude Max' }, usage, checkedAt), {
    provider: 'claude', checkedAt, plan: 'Max', email: 'dev@example.com', extraUsage: false,
    windows: [
      { id: 'five_hour', label: 'Session', usedPercent: 18, resetsAt: '2026-10-26T04:00:00Z' },
      { id: 'seven_day', label: 'Weekly', usedPercent: 35 },
      { id: 'model_scoped:0', label: 'Weekly · Fable', usedPercent: 60, resetsAt: '2026-10-29T00:00:00Z' },
    ],
  });
  assert.deepEqual(claudeAccountUsage({ subscriptionType: 'Claude Pro' }, { rate_limits_available: false, rate_limits: null }, checkedAt), { provider: 'claude', checkedAt, windows: [], plan: 'Claude Pro' });
});

test('ring labels use compact token counts and reset times', () => {
  assert.deepEqual([999, 9_734, 10_734, 169_400, 1_000_000, 1_250_000].map(formatTokens), ['999', '9.7k', '11k', '169k', '1m', '1.3m']);
  const now = Date.parse('2026-10-26T00:00:00Z');
  assert.equal(formatReset('2026-10-26T00:20:00Z', now), '20m');
  assert.equal(formatReset('2026-10-26T04:10:00Z', now), '4h');
  assert.equal(formatReset('2026-10-28T03:00:00Z', now), '2d');
  assert.equal(formatReset('not a date', now), undefined);
});

test('a conversation reports the context of its selected CLI and reads plan limits only on request', async t => {
  const { service, remote, hostId, request } = await fixture(t);
  const route = `${hostId}/codex/remote-model`;
  assert.equal(await service.usage('dsh-chat', { route }), null, 'no session and no route target');
  const target = { hostId, provider: 'codex' };
  remote.accountUsage = { provider: 'codex', windows: [{ id: 'codex:primary', label: 'Session', usedPercent: 10 }], checkedAt };
  assert.deepEqual(await service.usage('dsh-chat', { route, target, account: true }), { provider: 'codex', context: null, account: remote.accountUsage }, 'a new conversation can show its account before sending');
  assert.deepEqual(remote.accountReads.at(-1), { provider: 'codex', cwd: undefined, refresh: false });

  const agent = await service.create(request(), { chat: { sessionId: 'dsh-chat', route } });
  remote.live(agent.id).context = { used: 50_000, max: 400_000 };
  const reads = remote.accountReads.length;
  assert.deepEqual(await service.usage('dsh-chat', { route }), { provider: 'codex', context: { used: 50_000, max: 400_000 } });
  assert.equal(remote.accountReads.length, reads, 'polling the ring never contacts the SSH host');
  await service.usage('dsh-chat', { route, account: true, refresh: true });
  assert.deepEqual(remote.accountReads.at(-1), { provider: 'codex', cwd: '/srv/project', refresh: true });
  assert.equal(await service.usage('dsh-chat', { route: `${hostId}/claude/claude-model` }), null, 'another CLI of the same conversation has its own session');

  await service.archive(agent.id); remote.live(agent.id).context = undefined;
  await service.store.update(state => { state.tasks[0].context = { used: 60_000, max: 400_000 }; });
  assert.deepEqual((await service.usage('dsh-chat', { route }))?.context, { used: 60_000, max: 400_000 }, 'a detached session shows its saved context');

  remote.accountUsage = null;
  assert.equal((await service.usage('dsh-chat', { route, account: true }))?.account, undefined, 'CLIs without plan limits add no account section');
  remote.serverId = 'replaced-machine';
  const failed = await service.usage('dsh-chat', { route, account: true });
  assert.match(failed?.account?.error ?? '', /identity changed/);
  assert.deepEqual(failed?.account?.windows, []);
});
