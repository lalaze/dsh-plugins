import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { combine, fingerprint, report, shares, type Query, type UsageRecord, type UsageReport } from '../src/domain.js';
import { MachineReports, ownQuery, type LinkService } from '../src/machines.js';
import { apply } from '../src/index.js';

const record = (overrides: Partial<UsageRecord> = {}): UsageRecord => ({ id: 'r', startedAt: '2026-11-16T12:00:00.000Z', provider: 'deepseek', model: 'chat', purpose: 'conversation', status: 'completed', durationMs: 1, usage: { inputTokens: 10, outputTokens: 0 }, ...overrides });
const query: Query = { groupBy: 'provider' };

test('全部机器合计：各机自己的记录相加，本机调用按机器名分开，同名目录不合并并标出机器', () => {
  const hub = report([record(), record({ provider: 'remote-cli-claude', model: 'local-machine/claude/opus', host: 'code', workspace: '/root/app', usage: { inputTokens: 100, outputTokens: 0 } })], query);
  const code = report([record({ startedAt: '2026-11-15T12:00:00.000Z', workspace: '/root/app', usage: { inputTokens: 1000, outputTokens: 0 } }), record({ sessionId: 's2', status: 'error', usage: undefined })], query);
  const data = combine([{ id: 'hub', name: 'mac-mini', self: true, state: 'counted', report: hub }, { id: 'm1', name: 'code', state: 'counted', report: code }, { id: 'm2', name: 'docker', state: 'offline', error: 'offline' }], query);
  assert.equal(data.totals.totalTokens, 1110); assert.equal(data.totals.requests, 4); assert.equal(data.totals.errors, 1); assert.equal(data.totals.withUsage, 3);
  // The hub's remote turn on code and code's own DSH calls are both code's usage.
  assert.deepEqual(data.breakdowns.host.map(g => [g.key, g.totals.totalTokens]), [['code', 1100], ['mac-mini', 10]]);
  const workspaces = data.breakdowns.workspace.filter(g => g.label === '/root/app');
  assert.equal(workspaces.length, 2); assert.deepEqual(workspaces.map(g => g.machine).sort(), ['code', 'mac-mini']);
  assert.equal(data.breakdowns.workspace.find(g => g.key === '')?.totals.requests, 2, 'records outside every workspace stay one row');
  assert.deepEqual(data.groups, data.breakdowns.provider);
  assert.deepEqual(data.series.map(g => [g.key, g.totals.totalTokens]), [['2026-11-15', 1000], ['2026-11-16', 110]]);
  assert.equal(data.recordedSince, '2026-11-15T12:00:00.000Z');
  assert.deepEqual(data.filters.sessions, ['s2']);
  assert.deepEqual(data.machines?.map(m => [m.name, m.state, m.totals?.totalTokens]), [['mac-mini', 'counted', 110], ['code', 'counted', 1000], ['docker', 'offline', undefined]]);
  // Named workspaces keep their prefix, so the page still shows their name rather than a path.
  const named = combine([{ id: 'm1', name: 'code', state: 'counted', report: { ...code, breakdowns: { ...code.breakdowns, workspace: [{ key: 'workspace:w1', label: 'app', totals: code.totals }] } } }], query);
  assert.equal(named.breakdowns.workspace[0].key, 'workspace:m1:w1');
  // Day grouping merges by date, newest first.
  const days = combine([{ id: 'a', name: 'a', state: 'counted', report: report([record()], { groupBy: 'day' }) }, { id: 'b', name: 'b', state: 'counted', report: report([record(), record({ startedAt: '2026-11-14T12:00:00.000Z' })], { groupBy: 'day' }) }], { groupBy: 'day' });
  assert.deepEqual(days.groups.map(g => [g.key, g.totals.requests]), [['2026-11-16', 2], ['2026-11-14', 1]]);
});

function fakeLink(answers: Record<string, () => { status: number; text: string } | Promise<{ status: number; text: string }>>, states: Record<string, string> = {}) {
  const calls: string[] = [];
  const link: LinkService = {
    version: 1,
    self: () => ({ id: 'self-id', name: 'hub' }),
    machines: () => Object.keys(answers).map(id => ({ id, name: `name-${id}`, state: states[id] ?? 'online' })),
    get: async (id, path) => { calls.push(`${id} ${path}`); return answers[id]!(); },
  };
  return { link, calls };
}
const json = (data: unknown, status = 200) => ({ status, text: JSON.stringify(data) });

test('逐台读取：离线、未响应分开标出；睡眠中的机器沿用上次结果并注明时间；同时刷新只问一次', async () => {
  const own = report([record()], query), peer = report([record({ usage: { inputTokens: 5, outputTokens: 0 } })], query);
  let failing = false;
  const { link, calls } = fakeLink({
    a: () => { if (failing) throw new Error('timed out'); return json(peer); },
    b: () => ({ status: 404, text: 'Not found' }),
    c: () => json(peer),
  }, { c: 'offline' });
  const reports = new MachineReports();
  const first = await reports.parts(link, 'all', 'from=2026-11-16&to=2026-11-16', () => own);
  assert.deepEqual(first.map(p => [p.name, p.state, p.error]), [['hub', 'counted', undefined], ['name-a', 'counted', undefined], ['name-b', 'failed', 'Usage statistics is not installed there'], ['name-c', 'offline', 'offline']]);
  assert.deepEqual(calls, ['a /api/usage-stats?from=2026-11-16&to=2026-11-16', 'b /api/usage-stats?from=2026-11-16&to=2026-11-16'], 'an offline machine is not asked');
  // Within a few seconds another page's refresh reuses the same answers.
  await reports.parts(link, 'all', 'from=2026-11-16&to=2026-11-16', () => own);
  assert.equal(calls.length, 2);
  // Later a machine stops answering: its last answer stands in, marked with its time.
  failing = true;
  const later = new MachineReports();
  await later.parts(link, 'all', 'x=1', () => own);
  (later as unknown as { shared: Map<string, unknown> }).shared.clear();
  const stale = (await later.parts(link, 'all', 'x=1', () => own)).find(p => p.id === 'a')!;
  assert.equal(stale.state, 'failed', 'nothing kept yet for this query');
  failing = false;
  await later.parts(link, 'all', 'x=2', () => own);
  (later as unknown as { shared: Map<string, unknown> }).shared.clear();
  failing = true;
  const kept = (await later.parts(link, 'all', 'x=2', () => own)).find(p => p.id === 'a')!;
  assert.equal(kept.state, 'counted'); assert.equal(kept.stale, true); assert.ok(kept.asOf); assert.equal(kept.report?.totals.totalTokens, 5); assert.equal(kept.error, 'timed out');
  // One machine: the others are listed as not selected and not asked.
  const before = calls.length;
  const one = await new MachineReports().parts(link, 'self', 'y=1', () => own);
  assert.deepEqual(one.map(p => p.state), ['counted', 'skipped', 'skipped', 'skipped']); assert.equal(calls.length, before);
  await assert.rejects(new MachineReports().parts(link, 'nope', '', () => own), /Unknown machine/);
  // Without DSH Link there is only this computer.
  const alone = await new MachineReports().parts(undefined, 'all', '', () => own);
  assert.equal(alone.length, 1); assert.equal(alone[0].self, true);
  assert.equal(ownQuery(new URL('http://x/api/usage-stats?from=a&machines=all&format=csv&groupBy=host')), 'from=a&groupBy=host');
});

test('接口：machines=all 汇总 DSH Link 的机器；不带参数只答本机，供其他机器读取', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-usage-machines-'));
  try {
    await writeFile(join(root, 'usage.json'), JSON.stringify({ version: 1, records: [record({ sessionId: 's' })] }));
    const peer: UsageReport = report([record({ usage: { inputTokens: 90, outputTokens: 0 } })], { groupBy: 'day' });
    const { link, calls } = fakeLink({ a: () => json(peer) });
    let fetcher: ((r: Request) => Promise<Response>) | undefined;
    const ctx = { effect: () => {}, on: () => () => {}, get: (name: string) => name === 'dshLink' ? link : undefined,
      connection: { fetch: { register: (route: { fetch: typeof fetcher }) => { fetcher = route.fetch; } } } } as unknown as Context;
    await apply(ctx, { stateDir: root });
    const own = await (await fetcher!(new Request('http://x/api/usage-stats'))).json() as UsageReport;
    assert.equal(own.totals.totalTokens, 10); assert.equal(own.machines, undefined); assert.equal(calls.length, 0);
    const all = await (await fetcher!(new Request('http://x/api/usage-stats?machines=all&tz=480'))).json() as UsageReport;
    assert.equal(all.totals.totalTokens, 100); assert.deepEqual(calls, ['a /api/usage-stats?tz=480']);
    assert.deepEqual(all.machines?.map(m => [m.name, m.self ?? false]), [['hub', true], ['name-a', false]]);
    const csv = await (await fetcher!(new Request('http://x/api/usage-stats?machines=all&format=csv&groupBy=host'))).text();
    assert.match(csv, /"hub"/); assert.match(csv, /"name-a"/);
    const answered = await (await fetcher!(new Request('http://x/api/usage-stats?shares=s,nope&tz=0'))).json() as { shares: { session: string; totals: { totalTokens: number } }[] };
    assert.deepEqual(answered.shares.map(share => [share.session, share.totals.totalTokens]), [['s', 10]]);
    assert.equal((await fetcher!(new Request('http://x/api/usage-stats?machines=../x'))).status, 400);
    assert.equal((await fetcher!(new Request('http://x/api/usage-stats?machines=zzz'))).status, 400);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('共享过的对话两边都记了同一轮：按记录指纹只计一次，名字靠前的机器保留，部分重叠只去掉相同的', () => {
  const turn = record({ id: 'x1', sessionId: 's1', provider: 'remote-cli-claude', model: 'opus', host: 'Mac mini', workspace: '/w', usage: { inputTokens: 1000, outputTokens: 0 } });
  const hubRecords = [turn, record({ id: 'h2', sessionId: 's2', usage: { inputTokens: 7, outputTokens: 0 } })];
  const airRecords = [{ ...turn, id: 'x2' }, record({ id: 'a2', sessionId: 's1', startedAt: '2026-11-16T13:00:00.000Z', provider: 'remote-cli-claude', model: 'opus', host: 'Mac mini', workspace: '/w', usage: { inputTokens: 50, outputTokens: 0 } })];
  assert.equal(fingerprint(turn), fingerprint({ ...turn, id: 'other' }), 'the random id is not part of it');
  assert.notEqual(fingerprint(turn), fingerprint({ ...turn, model: 'sonnet' }));
  const q: Query = { groupBy: 'session' };
  const one = new Set(['s1']);
  const parts = [
    { id: 'air', name: 'lalazemacbook-air', state: 'counted' as const, report: report(airRecords, q), shares: shares(airRecords, q, one) },
    { id: 'hub', name: 'lalazemac-mini', self: true as const, state: 'counted' as const, report: report(hubRecords, q), shares: shares(hubRecords, q, one) },
  ];
  const data = combine(parts, q);
  assert.equal(data.totals.totalTokens, 1057); assert.equal(data.totals.requests, 3);
  assert.deepEqual(data.groups.map(g => [g.key, g.totals.totalTokens]), [['s1', 1050], ['s2', 7]]);
  assert.deepEqual(data.breakdowns.host.map(g => [g.key, g.totals.totalTokens]), [['Mac mini', 1050], ['lalazemac-mini', 7]]);
  assert.deepEqual(data.machines?.map(m => [m.name, m.totals?.totalTokens, m.copies]), [['lalazemacbook-air', 50, 1], ['lalazemac-mini', 1007, undefined]]);
  assert.equal(data.breakdowns.workspace.find(g => g.machine === 'lalazemacbook-air')?.totals.totalTokens, 50, 'the copy left the Air\'s workspace row');
  // Without a machine's records nothing is taken out (an older version cannot say).
  assert.equal(combine([{ ...parts[0], shares: undefined }, parts[1]], q).totals.totalTokens, 2057);
});

test('只为两台以上机器都有的对话要指纹；旧版本答不出时照常计入，自己这边直接算', async () => {
  const turn = record({ sessionId: 's1', usage: { inputTokens: 1000, outputTokens: 0 } });
  const own = report([turn, record({ sessionId: 'own-only' })], query);
  const peer = report([{ ...turn, id: 'copy' }], query);
  const asked: string[] = [];
  const { link } = fakeLink({
    a: () => json(peer),
    old: () => json(report([{ ...turn, id: 'old-copy' }], query)),
  });
  link.get = async (id, path) => {
    asked.push(`${id} ${path}`);
    const url = new URL(path, 'http://x');
    if (url.searchParams.has('shares')) {
      if (id === 'old') return json(report([{ ...turn, id: 'old-copy' }], query)); // an older version ignores the parameter
      return json({ shares: shares([{ ...turn, id: 'copy' }], query, new Set(url.searchParams.get('shares')!.split(','))) });
    }
    return json(id === 'a' ? peer : report([{ ...turn, id: 'old-copy' }], query));
  };
  const reports = new MachineReports();
  const parts = await reports.parts(link, 'all', 'tz=480', () => own);
  let ownAsked: string[] = [];
  await reports.addShares(parts, link, 'tz=480', sessions => { ownAsked = [...sessions]; return shares([turn, record({ sessionId: 'own-only' })], query, sessions); });
  assert.deepEqual(ownAsked, ['s1'], 'only conversations another machine also has');
  assert.ok(asked.includes('a /api/usage-stats?tz=480&shares=s1'));
  assert.equal(parts.find(p => p.id === 'old')?.shares, undefined);
  const data = combine(parts, query);
  // hub keeps its record ("hub" < "name-a" < "name-old"), a's copy goes, the old version's copy stays.
  assert.equal(data.totals.totalTokens, 1010 + 1000);
  assert.deepEqual(data.machines?.map(m => [m.name, m.copies]), [['hub', undefined], ['name-a', 1], ['name-old', undefined]]);
});
