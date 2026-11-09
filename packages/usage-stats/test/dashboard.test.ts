import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compact, dateRange, localDay, localOffset, trendBuckets, monthRange, shiftMonth, calendarDays, heatLevel } from '../src/client/metrics.js';
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
test('中文界面从 1 亿起以“亿”显示 Token 数，保留两位小数且不进位，以下仍为 K/M', () => {
  assert.equal(compact(113_600_000, 'zh'), '1.13亿');
  assert.equal(compact(119_999_999, 'zh'), '1.19亿');
  assert.equal(compact(100_000_000, 'zh'), '1亿');
  assert.equal(compact(1_234_500_000_000, 'zh'), '12,345亿');
  assert.equal(compact(13_040_000, 'zh'), '13M', '不出现 1304万');
  assert.equal(compact(113_600_000, 'en'), '113.6M');
  assert.equal(compact(113_600_000), '113.6M');
  // 图表纵轴按最大值的单位显示，避免同一轴上混用“亿”和 M。
  assert.equal(compact(60_000_000, 'zh', 120_000_000), '0.6亿');
  assert.equal(compact(60_000_000, 'en', 120_000_000), '60M');
});

test('月历覆盖整月、固定六周，按周一排列并正确处理闰年与跨年', () => {
  assert.deepEqual(monthRange('2024-02'), { from: '2024-02-01', to: '2024-02-29' });
  assert.deepEqual(monthRange('2025-02'), { from: '2025-02-01', to: '2025-02-28' });
  assert.equal(shiftMonth('2026-01', -1), '2025-12');
  assert.equal(shiftMonth('2026-12', 1), '2027-01');
  assert.throws(() => monthRange('2026-13'));
  assert.throws(() => monthRange('2026-2'));
  const days = calendarDays('2024-02', [], '2024-02-10');
  assert.equal(days.length, 42);
  assert.deepEqual(days.slice(0, 3), [null, null, null]);
  assert.equal(days.filter(Boolean).length, 29);
  assert.equal(days[3]?.date, '2024-02-01');
  assert.equal(days[12]?.future, false);
  assert.equal(days[13]?.future, true);
  assert.equal(calendarDays('2026-11', [])[6]?.date, '2026-11-01', '周日开头');
  assert.equal(calendarDays('2026-03', []).filter(Boolean).length, 31);
});
test('热度图补齐零用量，忽略其他月份数据，并分别计算 Token 和调用次数', () => {
  const data = report([record('2024-02-01', 'a', 20), record('2024-02-01', 'b', 30), record('2024-02-29', 'a', 10), record('2024-03-01', 'a', 100)], { groupBy: 'day' });
  const days = calendarDays('2024-02', data.series, '2024-03-01').filter(day => day !== null);
  assert.equal(days.length, 29);
  assert.equal(days[0].tokens, 50); assert.equal(days[0].requests, 2);
  assert.equal(days[1].tokens, 0); assert.equal(days[1].requests, 0);
  assert.equal(days.reduce((sum, day) => sum + day.tokens, 0), 60);
  assert.equal(days.reduce((sum, day) => sum + day.requests, 0), 3);
  assert.equal(days.some(day => day.future), false);
  assert.deepEqual([0, 1, 25, 26, 50, 51, 75, 76, 100].map(value => heatLevel(value, 100)), [0, 1, 1, 2, 2, 3, 3, 4, 4]);
  assert.equal(heatLevel(0, 0), 0); assert.equal(heatLevel(10, 10), 4);
});
