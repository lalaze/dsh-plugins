import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dateRange, localDay, localOffset, trendBuckets } from '../src/client/metrics.js';
import { report, type UsageRecord } from '../src/domain.js';

const record = (date: string, provider = 'deepseek', tokens = 10): UsageRecord => ({ id: date, startedAt: `${date}T12:00:00.000Z`, provider, model: 'chat', durationMs: 1, purpose: 'conversation', status: 'completed', usage: { inputTokens: tokens, outputTokens: 0 } });
test('图表和排行使用同一筛选结果，不随明细分组切换丢失日期轴', () => {
  const records = [record('2026-10-01'), record('2026-10-03', 'claude-ssh-dev', 20), record('2026-10-04', 'claude-ssh-dev', 30)];
  const data = report(records, { groupBy: 'session', source: 'remote-agents', to: '2026-10-03' });
  assert.equal(data.series.length, 1); assert.equal(data.series[0].key, '2026-10-03');
  assert.equal(data.sources.length, 1); assert.equal(data.sources[0].key, 'remote-agents');
  assert.equal(data.sources[0].totals.totalTokens, data.totals.totalTokens);
  assert.equal(data.series.reduce((n, g) => n + g.totals.requests, 0), data.totals.requests);
});
test('趋势补齐无调用日期，以相同时间间隔展示，并保留显式筛选边界', () => {
  const data = report([record('2026-10-01'), record('2026-10-03')], { groupBy: 'model' });
  const buckets = trendBuckets(data.series, '2026-09-30', '2026-10-04');
  assert.equal(buckets.length, 5); assert.deepEqual(buckets.map(b => b.tokens), [0, 10, 0, 10, 0]);
  assert.equal(buckets[0].from, '2026-09-30'); assert.equal(buckets.at(-1)?.to, '2026-10-04');
});
test('长时间范围最多 48 根柱，汇总后不丢失 Token 与调用次数', () => {
  const data = report([record('2024-01-01'), record('2026-10-21', 'claude-ssh-dev', 20)], { groupBy: 'model' });
  const buckets = trendBuckets(data.series);
  assert.ok(buckets.length <= 48); assert.equal(buckets.reduce((sum, b) => sum + b.tokens, 0), 30);
  assert.equal(buckets.reduce((sum, b) => sum + b.requests, 0), 2);
  assert.deepEqual(trendBuckets([]), []); assert.deepEqual(trendBuckets(data.series, '2026-10-21', '2024-01-01'), []);
});
test('快捷日期使用本地时区并包含今天，正确跨越月份和闰年边界', () => {
  const zone = process.env.TZ;
  process.env.TZ = 'Asia/Shanghai';
  try {
    // 本地 03-01 00:30 仍是 UTC 02-29，统计面板和标题栏标签都应算作 03-01。
    const midnight = new Date('2024-02-29T16:30:00Z');
    assert.deepEqual(dateRange('today', midnight), { from: '2024-03-01', to: '2024-03-01' });
    assert.equal(localDay(midnight), '2024-03-01'); assert.equal(localOffset(midnight), '480');
  } finally { if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone; }
  const now = new Date(2024, 2, 1, 1);
  assert.deepEqual(dateRange('today', now), { from: '2024-03-01', to: '2024-03-01' });
  assert.deepEqual(dateRange('7d', now), { from: '2024-02-24', to: '2024-03-01' });
  assert.deepEqual(dateRange('30d', now), { from: '2024-02-01', to: '2024-03-01' });
  assert.deepEqual(dateRange('all', now), { from: '', to: '' });
});
