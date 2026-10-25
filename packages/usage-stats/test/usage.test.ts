import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { LlmAdapter, LlmRuntime, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { report, parseQuery, toCsv, type UsageRecord } from '../src/domain.js';
import { observe } from '../src/observe.js';
import { UsageStore } from '../src/store.js';
import { apply } from '../src/index.js';

const record = (overrides: Partial<UsageRecord> = {}): UsageRecord => ({ id: 'r', startedAt: '2026-10-21T12:00:00.000Z', provider: 'deepseek', model: 'chat', sessionId: 's', purpose: 'conversation', status: 'completed', durationMs: 10, usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40, reasoningTokens: 5 }, ...overrides });
const options: GenerateOptions = { provider: 'deepseek', model: 'chat', messages: [{ role: 'user', content: [{ type: 'text', text: 'private prompt' }] }] };
async function* stream(chunks: StreamChunk[]) { yield* chunks; }
async function collect(source: AsyncIterable<StreamChunk>) { const result: StreamChunk[] = []; for await (const chunk of source) result.push(chunk); return result; }
const stop: StreamChunk = { type: 'finish', reason: { kind: 'stop' } };

test('DSH 与 Claude SSH 汇总：缓存不重复计入，推理不额外累加；有无用量分开', () => {
  const records = [record(), record({ provider: 'claude-ssh-host', model: 'sonnet', usage: { inputTokens: 2, outputTokens: 3, cacheReadTokens: 7, cacheWriteTokens: 11 } }), record({ status: 'error', usage: undefined })];
  const data = report(records, { groupBy: 'source' });
  assert.equal(data.totals.totalTokens, 123);
  assert.equal(data.totals.requests, 3); assert.equal(data.totals.withUsage, 2); assert.equal(data.totals.errors, 1);
  assert.equal(data.groups.find(g => g.key === 'claude-ssh')?.totals.totalTokens, 23);
  assert.equal(report(records, { groupBy: 'model', source: 'claude-ssh' }).totals.requests, 1);
  assert.equal(report(records, { groupBy: 'model', source: 'dsh' }).totals.requests, 2);
});
test('优先使用供应商明确的总量；模型名相同但服务商不同不会合并', () => {
  const records = [record({ usage: { inputTokens: 1, outputTokens: 2, totalTokens: 9 } }), record({ provider: 'other' })];
  const data = report(records, { groupBy: 'model' });
  assert.equal(data.groups.length, 2); assert.equal(data.totals.totalTokens, 109);
});
test('日期首尾包含，模型/服务商/会话筛选一致；无会话辅助请求仍计入', () => {
  const records = [record({ startedAt: '2026-10-20T23:59:59.999Z' }), record(), record({ startedAt: '2026-10-21T23:59:59.999Z', sessionId: undefined, purpose: 'session-title' }), record({ startedAt: '2026-10-22T00:00:00.000Z' })];
  const query = parseQuery(new URL('http://example.test/?from=2026-10-21&to=2026-10-21&groupBy=session&provider=deepseek&model=chat'));
  assert.equal(report(records, query).totals.requests, 2);
  assert.equal(report(records, { ...query, sessionId: 's' }).totals.requests, 1);
  assert.equal(report(records, query).groups.length, 2);
  assert.equal(report([], { groupBy: 'day' }).totals.totalTokens, 0);
});
test('拒绝无效日期、倒序日期、未知分组及未知来源', () => {
  for (const q of ['from=2026-02-30', 'from=2026-2-1', 'from=2026-11-01&to=2026-10-01', 'groupBy=bad', 'source=bad']) assert.throws(() => parseQuery(new URL(`http://example.test/?${q}`)));
});
test('多次 usage 采用最终快照，不改变原始流；不保存提示词或回复', async () => {
  const saved: UsageRecord[] = [];
  const chunks: StreamChunk[] = [{ type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } }, { type: 'usage', usage: { inputTokens: 10, outputTokens: 20 } }, stop];
  const output = await collect(observe(options, () => stream(chunks), async r => { saved.push(r); }, error => assert.fail(String(error))));
  assert.deepEqual(output, chunks); assert.equal(output[0], chunks[0]);
  assert.equal(saved.length, 1); assert.deepEqual(saved[0].usage, { inputTokens: 10, outputTokens: 20 });
  assert.equal(saved[0].status, 'completed'); assert.doesNotMatch(JSON.stringify(saved), /private prompt|messages|content/);
});
test('失败和取消保留已返回用量；供应商不返回用量时保持未知', async () => {
  for (const kind of ['error', 'aborted'] as const) {
    const saved: UsageRecord[] = [];
    await collect(observe(options, () => stream([{ type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } }, { type: 'finish', reason: { kind, failure: { code: 'TEST', message: 'failure' } } }]), async r => { saved.push(r); }, error => assert.fail(String(error))));
    assert.equal(saved[0].status, kind === 'error' ? 'error' : 'cancelled'); assert.ok(saved[0].usage);
  }
  const saved: UsageRecord[] = [];
  await collect(observe(options, () => stream([stop]), async r => { saved.push(r); }, error => assert.fail(String(error))));
  assert.equal(saved[0].usage, undefined);
});
test('消费者提前关闭仍落盘一次，并释放上游生成器', async () => {
  let released = false; const saved: UsageRecord[] = [];
  async function* upstream() { try { yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } } as StreamChunk; yield stop; } finally { released = true; } }
  for await (const _ of observe(options, upstream, async r => { saved.push(r); }, error => assert.fail(String(error)))) break;
  assert.equal(released, true); assert.equal(saved.length, 1); assert.equal(saved[0].status, 'cancelled');
});
test('落盘失败不破坏模型调用或遮蔽原始错误', async () => {
  let warnings = 0; const failure = new Error('upstream');
  const save = async () => { throw new Error('disk'); }; const warn = () => { warnings++; };
  assert.deepEqual(await collect(observe(options, () => stream([stop]), save, warn)), [stop]);
  async function* upstream(): AsyncGenerator<StreamChunk> { throw failure; }
  await assert.rejects(collect(observe(options, upstream, save, warn)), e => e === failure);
  assert.equal(warnings, 2);
});
test('并发记录串行持久化、重启可读、数据文件仅当前用户可读写', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-usage-'));
  try {
    const path = join(root, 'state', 'usage.json'); const store = new UsageStore(path); await store.load();
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.append(record({ id: String(i) }))));
    const restored = new UsageStore(path); await restored.load(); assert.equal(restored.snapshot().length, 20);
    assert.equal(new Set(restored.snapshot().map(r => r.id)).size, 20);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const snapshot = store.snapshot(); snapshot[0].model = 'changed'; assert.equal(store.snapshot()[0].model, 'chat');
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('写入失败计数且后续写入可恢复；不覆盖损坏的旧文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-usage-'));
  try {
    const block = join(root, 'blocked'); await writeFile(block, 'not a directory');
    const store = new UsageStore(join(block, 'usage.json')); await assert.rejects(store.append(record()));
    assert.equal(store.failedWrites, 1); assert.equal(store.snapshot().length, 0);
    await rm(block); await store.append(record()); assert.equal(store.snapshot().length, 1);
    const path = join(root, 'bad.json'); await writeFile(path, '{bad'); await assert.rejects(new UsageStore(path).load());
    assert.equal(await readFile(path, 'utf8'), '{bad');
    await writeFile(path, JSON.stringify({ version: 1, records: [record({ usage: { inputTokens: -1, outputTokens: 0 } })] }));
    await assert.rejects(new UsageStore(path).load(), /Invalid usage data format/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('CSV 正确转义，并中和分组名称中的电子表格公式', () => {
  const csv = toCsv(report([record({ provider: '=cmd,"x"' })], { groupBy: 'model' }));
  assert.ok(csv.startsWith('\uFEFF')); assert.ok(csv.includes('"\'=cmd,""x"" / chat"'));
  assert.ok(csv.endsWith('\r\n'));
});
test('插件钩子覆盖两类调用；API、筛选和 CSV 共用持久化结果', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-usage-'));
  let dispose = () => {};
  try {
    let handler: ((o: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => AsyncIterable<StreamChunk>) | undefined;
    let fetcher: ((r: Request) => Promise<Response>) | undefined;
    const ctx = { effect: (setup: () => () => void) => { dispose = setup(); }, on: (event: string, fn: typeof handler, scope: unknown) => { assert.equal(event, 'llm/stream'); assert.deepEqual(scope, { global: true, prepend: true }); handler = fn; }, connection: { fetch: { register: (route: { path: string; methods: string[]; fetch: typeof fetcher }) => { assert.equal(route.path, '/api/usage-stats'); assert.deepEqual(route.methods, ['GET']); fetcher = route.fetch; } } } } as unknown as Context;
    await apply(ctx, { stateDir: root });
    for (const provider of ['deepseek', 'claude-ssh-host']) await collect(handler!({ ...options, provider }, () => stream([{ type: 'usage', usage: { inputTokens: 2, outputTokens: 3 } }, stop])));
    const response = await fetcher!(new Request('http://example.test/api/usage-stats?groupBy=source'));
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const data = await response.json(); assert.equal(data.totals.requests, 2); assert.equal(data.totals.totalTokens, 10); assert.equal(data.groups.length, 2);
    const filtered = await (await fetcher!(new Request('http://example.test/api/usage-stats?source=claude-ssh'))).json(); assert.equal(filtered.totals.requests, 1);
    const csv = await fetcher!(new Request('http://example.test/api/usage-stats?source=claude-ssh&format=csv')); assert.match(csv.headers.get('Content-Type')!, /text\/csv/); assert.match(await csv.text(), /"1"/);
    assert.equal((await fetcher!(new Request('http://example.test/api/usage-stats?from=bad'))).status, 400);
    assert.equal((await fetcher!(new Request('http://example.test/api/usage-stats?format=bad'))).status, 400);
  } finally { dispose(); await rm(root, { recursive: true, force: true }); }
});
test('真实 Cordis 与 LlmRuntime waterfall 经适配器派发后恰好采集一次', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-usage-runtime-')); const ctx = new Context();
  try {
    await ctx.plugin(LlmRuntime);
    let fetcher: ((request: Request) => Promise<Response>) | undefined;
    const scope = ctx.extend({ connection: { fetch: { register: (route: { fetch: typeof fetcher }) => { fetcher = route.fetch; } } } });
    await apply(scope, { stateDir: root });
    class Adapter extends LlmAdapter {
      override async *stream(): AsyncGenerator<StreamChunk> {
        yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 3 } }; yield stop;
      }
    }
    ctx.llm.registerAdapter(['deepseek', 'claude-ssh-fixture'], new Adapter());
    for (const provider of ['deepseek', 'claude-ssh-fixture']) {
      const chunks = await collect(ctx.llm.stream({ ...options, provider }));
      assert.equal(chunks.at(-1)?.type, 'finish');
    }
    const data = await (await fetcher!(new Request('http://example.test/api/usage-stats?groupBy=source'))).json();
    assert.equal(data.totals.requests, 2); assert.equal(data.totals.totalTokens, 10); assert.equal(data.totals.withUsage, 2);
    assert.deepEqual(data.groups.map((g: { totals: { requests: number } }) => g.totals.requests), [1, 1]);
  } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); }
});
test('调用进行时重载插件，新旧调用均保留在 API 与重启后的文件中', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-usage-reload-')); const ctx = new Context();
  try {
    await ctx.plugin(LlmRuntime);
    let fetcher: ((request: Request) => Promise<Response>) | undefined;
    const scope = ctx.extend({ connection: { fetch: { register: (route: { fetch: typeof fetcher }) => { fetcher = route.fetch; } } } });
    const plugin = { apply: (c: Context) => apply(c, { stateDir: root }) };
    let fiber = await scope.plugin(plugin);
    class Adapter extends LlmAdapter {
      override async *stream(): AsyncGenerator<StreamChunk> {
        yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 3 } }; yield stop;
      }
    }
    ctx.llm.registerAdapter(['deepseek'], new Adapter());
    const old = ctx.llm.stream({ ...options, model: 'old' })[Symbol.asyncIterator]();
    await old.next();
    await fiber.dispose();
    fiber = await scope.plugin(plugin);
    await collect(ctx.llm.stream({ ...options, model: 'new' }));
    while (!(await old.next()).done) { /* Finish the call owned by the disposed plugin. */ }
    const data = await (await fetcher!(new Request('http://example.test/api/usage-stats?groupBy=model'))).json();
    assert.equal(data.totals.requests, 2);
    assert.equal(data.totals.totalTokens, 10);
    await fiber.dispose();
    const restored = new UsageStore(join(root, 'usage.json')); await restored.load();
    assert.deepEqual(restored.snapshot().map(r => r.model).sort(), ['new', 'old']);
    await restored.append(record({ model: 'offline' }));
    fiber = await scope.plugin(plugin);
    const reloaded = await (await fetcher!(new Request('http://example.test/api/usage-stats'))).json();
    assert.equal(reloaded.totals.requests, 3);
  } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); }
});
