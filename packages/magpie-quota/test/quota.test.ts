import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { gatewayURL, readSources, type Source } from '../src/config.js';
import { apply, resolveHeaders } from '../src/index.js';
import { normalizeQuotas } from '../src/normalize.js';
import { QuotaError, QuotaService, type ResolvedSource } from '../src/service.js';
import { summary } from '../src/types.js';

const row = (user = 'one@example.invalid') => ({ provider: 'codex', name: 'Codex', kind: 'subscription', user, plan: 'plus', last: true,
  readAt: '2026-10-23T10:00:00Z', windows: [{ name: '5 hours', remaining: 75, used: 25, resetsAt: '2026-10-23T15:00:00Z' }, { name: '7 days', remaining: 63, used: 37 }] });
const list = (...rows: unknown[]) => ({ object: 'list', data: rows });
const source = (): ResolvedSource => ({ id: 'remote-magpie', name: 'Office Magpie', profile: { baseURL: 'https://gateway.example.invalid/proxy/v1' }, headers: new Headers({ Authorization: 'Bearer source-secret-credential', 'X-Route': 'office' }) });

test('多账号、多窗口、卡片响应、积分、无限额及缺失读数分别处理', () => {
  const rows = normalizeQuotas(list(row(), row('two@example.invalid'), { ...row('credits'), windows: [{ name: 'Credits', used: 20, amount: 20, limit: 100, unit: 'credits' }] },
    { ...row('unlimited'), windows: [{ name: 'Unlimited', used: 0, unlimited: true }] }, { ...row('unknown'), windows: [{ name: 'Unknown' }], error: 'upstream failed' }));
  assert.equal(rows.length, 5); assert.notEqual(rows[0].id, rows[1].id);
  assert.deepEqual(summary(rows[0]), { text: '63%', remaining: 63 });
  assert.equal(rows[2].windows[0].remaining, 80); assert.equal(rows[2].windows[0].amount, 20);
  assert.deepEqual(summary(rows[3]), { text: '∞', remaining: null });
  assert.deepEqual(summary(rows[4]), { text: '—', remaining: null });
  assert.equal(rows[4].error, 'upstream failed');
  assert.throws(() => normalizeQuotas({ data: {} }));
  assert.throws(() => normalizeQuotas(list({ windows: [] })));
  assert.equal(normalizeQuotas(list({ ...row(), windows: [{ name: 'over', used: 120 }] }))[0].windows[0].remaining, 0);
  assert.equal(summary(normalizeQuotas(list({ ...row(), windows: [{ name: 'low', remaining: 0.3 }] }))[0]).text, '<1%');
});
test('响应按字段白名单过滤，账号 ID 不含上游密钥；旧数据时间及嵌套远端保留', () => {
  const secret = 'source-secret-credential';
  const [account] = normalizeQuotas(list({ ...row(secret), from: 'remote', alias: 'Friendly name', asOf: '2026-10-22T10:00:00Z', readDeferred: true,
    error: `bad ${secret}`, accessToken: secret, headers: { Authorization: secret }, holds: { token: secret } }), [secret]);
  assert.ok(!JSON.stringify(account).includes(secret)); assert.equal(account.user, '[redacted]'); assert.equal(account.refreshable, false);
  assert.equal(account.readDeferred, true); assert.equal(account.asOf, '2026-10-22T10:00:00Z');
});
test('网关路径保留反代前缀；拒绝非 HTTP 和带凭据的 URL', () => {
  for (const base of ['https://host.invalid/prefix/v1', 'https://host.invalid/prefix/v1/', 'https://host.invalid/prefix/']) assert.equal(gatewayURL(base, 'quotas').href, 'https://host.invalid/prefix/v1/magpie/quotas');
  assert.equal(gatewayURL('https://host.invalid/v1', 'refresh').pathname, '/v1/magpie/quotas/refresh');
  for (const base of ['file:///tmp/a', 'https://user:pass@host.invalid', 'https://host.invalid?a=b']) assert.throws(() => gatewayURL(base, 'quotas'));
});
test('提供商自动识别及显式 ID 选择，不请求其他厂商', () => {
  const descriptors = [{ value: { providers: { office: { baseURL: 'https://office.invalid/v1', name: 'Office Magpie' }, vendor: { baseURL: 'https://vendor.invalid/v1' } } } }];
  assert.deepEqual(readSources(descriptors, {}).map(s => s.id), ['office']);
  assert.deepEqual(readSources(descriptors, { providers: ['vendor'] }).map(s => s.id), ['vendor']);
  assert.equal(readSources(descriptors, { providers: ['missing'] }).length, 0);
});
test('后端复用凭据、保存的 API Key 及显式认证头，缺失远端密钥不伪造', async () => {
  const ctx = new Context(); const src: Source = source(); let reference = '';
  ctx.provide('credentials', { resolve: async (ref: string) => { reference = ref; return { value: '  saved-key  ' }; }, readRecord: async () => ({ kind: 'api-key', key: 'record-key' }) });
  try {
    assert.equal((await resolveHeaders(ctx, { ...src, profile: { ...src.profile, apiKeyEnv: 'MAGPIE_KEY' } })).get('authorization'), 'Bearer saved-key');
    assert.equal(reference, 'MAGPIE_KEY');
    assert.equal((await resolveHeaders(ctx, src)).get('authorization'), 'Bearer record-key');
    assert.equal((await resolveHeaders(ctx, { ...src, profile: { ...src.profile, apiKeyEnv: 'MISSING', headers: { 'x-api-key': 'explicit', 'X-Route': 'office' } } })).get('x-api-key'), 'explicit');
    ctx.set('credentials', { resolve: async () => undefined, readRecord: async () => undefined });
    await assert.rejects(resolveHeaders(ctx, src), /requires an existing provider/);
    await assert.rejects(resolveHeaders(ctx, { ...src, profile: { ...src.profile, apiKeyEnv: 'MISSING' } }), /Missing Magpie/);
    assert.equal((await resolveHeaders(ctx, { ...src, profile: { baseURL: 'http://127.0.0.1:3425/v1' } })).get('authorization'), 'Bearer magpie-dsh');
  } finally { await ctx.fiber.dispose(); }
});
test('并发查询合并且缓存，网络故障保留旧读数，权限拒绝立即移除旧账号', async () => {
  let now = 0; let status = 200; let calls = 0;
  const service = new QuotaService({ sources: async () => [source()], now: () => now, cacheSeconds: 10, fetch: async () => {
    calls++; if (status === 0) throw new Error('network'); return Response.json(list(row()), { status });
  } });
  try {
    await Promise.all([service.report(), service.report()]); assert.equal(calls, 1);
    await service.report(); assert.equal(calls, 1);
    now = 11000; status = 0; const stale = await service.report();
    assert.equal(stale.gateways[0].accounts.length, 1); assert.equal(stale.gateways[0].stale, true); assert.equal(stale.gateways[0].fetchedAt, new Date(0).toISOString());
    now = 22000; status = 403; const denied = await service.report();
    assert.equal(denied.gateways[0].accounts.length, 0); assert.equal(denied.gateways[0].error?.code, 'FORBIDDEN');
  } finally { service.close(); }
});
test('更换凭据后不复用之前账号缓存，上游错误不会回显密钥', async () => {
  let current = source(); let calls = 0;
  const service = new QuotaService({ sources: async () => [current], fetch: async () => {
    calls++; return calls === 1 ? Response.json(list({ ...row(), error: 'bad source-secret-credential' })) : Response.json({ error: { message: 'source-secret-credential' } }, { status: 401 });
  } });
  try {
    assert.ok(!JSON.stringify(await service.report()).includes('source-secret-credential'));
    current = { ...current, headers: new Headers({ Authorization: 'Bearer changed-key' }) };
    const report = await service.report(); assert.equal(calls, 2); assert.equal(report.gateways[0].accounts.length, 0);
    assert.equal(report.gateways[0].error?.code, 'UNAUTHORIZED');
  } finally { service.close(); }
});
test('单账号刷新使用服务器的原始账号，转换卡片后重读标准列表；刷新节流和未知账号校验', async () => {
  let now = 1000; let used = 37; const calls: Request[] = [];
  const user = 'two+alias@example.invalid';
  const service = new QuotaService({ sources: async () => [source()], now: () => now, fetch: async (input, init) => {
    const request = new Request(input, init); calls.push(request);
    if (request.method === 'POST') {
      const url = new URL(request.url); assert.equal(url.searchParams.get('provider'), 'codex'); assert.equal(url.searchParams.get('user'), user);
      assert.equal(request.headers.get('authorization'), 'Bearer source-secret-credential'); assert.equal(request.headers.get('x-route'), 'office');
      used = 20;
      return Response.json(list({ ...row(user), windows: [{ name: '7 days', used }] }));
    }
    return Response.json(list({ ...row(user), windows: [{ name: '7 days', used, remaining: 100 - used }] }));
  } });
  try {
    const initial = await service.report(); const id = initial.gateways[0].accounts[0].id;
    const updated = await service.refresh('remote-magpie', id);
    assert.equal(updated.gateways[0].accounts[0].windows[0].remaining, 80); assert.equal(updated.gateways[0].accounts[0].last, true);
    assert.deepEqual(calls.map(r => r.method), ['GET', 'POST', 'GET']);
    await assert.rejects(service.refresh('remote-magpie', id), (e: unknown) => e instanceof QuotaError && e.status === 429 && e.retryAfter === 30);
    await assert.rejects(service.refresh('remote-magpie', 'forged-account'), (e: unknown) => e instanceof QuotaError && e.status === 404);
    now += 30001; await service.refresh('remote-magpie', id); assert.equal(calls.filter(r => r.method === 'POST').length, 2);
  } finally { service.close(); }
});
test('嵌套远端不可错误刷新，格式错误及不存在接口可区分', async () => {
  let response = Response.json(list({ ...row(), provider: 'remote/codex', from: 'remote' }));
  const service = new QuotaService({ sources: async () => [source()], fetch: async () => response.clone(), now: () => 10000 });
  const initial = await service.report();
  await assert.rejects(service.refresh('remote-magpie', initial.gateways[0].accounts[0].id), (e: unknown) => e instanceof QuotaError && e.code === 'REMOTE_ACCOUNT');
  service.close();
  response = new Response('not JSON');
  const bad = new QuotaService({ sources: async () => [source()], fetch: async () => response.clone() });
  assert.equal((await bad.report()).gateways[0].error?.code, 'INVALID_RESPONSE'); bad.close();
  const old = new QuotaService({ sources: async () => [source()], fetch: async () => new Response('', { status: 404 }) });
  assert.equal((await old.report()).gateways[0].error?.code, 'UNSUPPORTED'); old.close();
});
test('DSH 注册鉴权接口：请求字段校验、缓存响应及插件卸载', async () => {
  const ctx = new Context(); let handler!: (request: Request) => Promise<Response>; let methods: string[] = [];
  ctx.provide('settings', { describe: () => [{ value: { providers: { 'remote-magpie': { baseURL: 'https://gateway.invalid/v1', headers: { Authorization: 'Bearer gateway-secret' } } } } }] });
  ctx.provide('connection', { fetch: { register: (spec: { path: string; methods: string[]; fetch: typeof handler }) => { assert.equal(spec.path, '/api/magpie-quota'); handler = spec.fetch; methods = spec.methods; } } });
  try {
    apply(ctx, {}, { fetch: async () => Response.json(list(row())) });
    assert.deepEqual(methods, ['GET', 'POST']);
    const response = await handler(new Request('https://dsh.invalid/api/magpie-quota'));
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    const report = await response.json(); assert.equal(report.gateways[0].accounts.length, 1); assert.ok(!JSON.stringify(report).includes('gateway-secret'));
    for (const body of ['bad-json', '{}', JSON.stringify({ gatewayId: 'remote-magpie', accountId: 42 }), 'x'.repeat(8200)]) {
      assert.equal((await handler(new Request('https://dsh.invalid/api/magpie-quota', { method: 'POST', body }))).status, 400);
    }
    assert.equal((await handler(new Request('https://dsh.invalid/api/magpie-quota', { method: 'POST', body: JSON.stringify({ gatewayId: 'arbitrary-url', accountId: 'fake' }) }))).status, 404);
  } finally { await ctx.fiber.dispose(); }
});
