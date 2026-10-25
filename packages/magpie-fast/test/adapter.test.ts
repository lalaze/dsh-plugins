import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { LlmRuntime, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { FastPool, requestOptions } from '../src/adapter.js';
import { apply, resolveGatewayKey } from '../src/index.js';
import { chatReply, collect, fakeTransport, MODEL, request, responsesReply, source } from './fixtures.js';

for (const protocol of ['openai-completions', 'openai-responses'] as const) {
  test(`${protocol}: 原提供商的请求带 priority；high、工具、用量与回放正常`, async () => {
    const ctx = new Context(); const wire = fakeTransport(() => protocol === 'openai-completions' ? chatReply() : responsesReply());
    const pool = new FastPool({ context: ctx, resolveKey: async () => 'test-key', fetch: wire.fetch });
    try {
      const input = request({ maxTokens: 42, tools: [{ name: 'lookup', description: 'Look up a value', parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } }] });
      Object.freeze(input); Object.freeze(input.messages);
      const chunks = await collect(pool.stream(source(protocol), input));
      assert.equal(wire.calls.length, 1, JSON.stringify(chunks)); const sent = wire.calls[0];
      assert.equal(sent.url, `https://magpie.example.invalid/v1/${protocol === 'openai-responses' ? 'responses' : 'chat/completions'}`);
      assert.equal(sent.headers.get('authorization'), 'Bearer test-key'); assert.equal(sent.headers.get('x-deployment'), 'test');
      assert.ok(sent.headers.get('user-agent')); assert.equal(sent.body.service_tier, 'priority'); assert.equal(sent.body.model, MODEL);
      assert.equal(protocol === 'openai-responses' ? sent.body.reasoning.effort : sent.body.reasoning_effort, 'high');
      assert.equal(protocol === 'openai-responses' ? sent.body.max_output_tokens : sent.body.max_completion_tokens, 42);
      assert.equal(sent.body.tools[0].type, 'function');
      assert.ok(chunks.some(c => c.type === 'text-delta' && c.text === 'hello'), JSON.stringify(chunks));
      assert.ok(chunks.some(c => c.type === 'usage' && c.usage.inputTokens === 10));
      assert.ok(chunks.some(c => c.type === 'finish' && c.reason.kind === 'stop' && c.replayState));
    } finally { pool.close(); await ctx.fiber.dispose(); }
  });
}
test('最终工具调用仍为完整 JSON', async () => {
  const ctx = new Context(); const wire = fakeTransport(() => chatReply(true));
  const pool = new FastPool({ context: ctx, resolveKey: async () => 'key', fetch: wire.fetch });
  try {
    const chunks = await collect(pool.stream(source(), request()));
    const end = chunks.find(c => c.type === 'block-end' && c.block.type === 'tool-call');
    assert.ok(end?.type === 'block-end' && end.block.type === 'tool-call', JSON.stringify(chunks));
    assert.equal(end.block.name, 'lookup'); assert.deepEqual(JSON.parse(end.block.arguments), { q: 'value' });
    assert.ok(chunks.some(c => c.type === 'finish' && c.reason.kind === 'tool-calls'));
  } finally { pool.close(); await ctx.fiber.dispose(); }
});
test('源配置和密钥在等待中保持同一代；重载不打断已开始的流', async () => {
  const ctx = new Context(); let key = 'first'; const src = source();
  let enter!: () => void; const entered = new Promise<void>(r => enter = r);
  let release!: () => void; const waiting = new Promise<void>(r => release = r);
  const wire = fakeTransport(async () => { enter(); await waiting; return chatReply(); });
  const pool = new FastPool({ context: ctx, resolveKey: async () => key, fetch: wire.fetch });
  const running = collect(pool.stream(src, request())); await entered;
  src.profile.baseURL = 'https://other.example.invalid/v1'; key = 'second'; pool.close(); release();
  const chunks = await running;
  assert.equal(wire.calls[0].headers.get('authorization'), 'Bearer first'); assert.equal(new URL(wire.calls[0].url).hostname, 'magpie.example.invalid');
  assert.ok(chunks.some(c => c.type === 'finish' && c.reason.kind === 'stop'));
  await ctx.fiber.dispose();
});
test('onPayload 组合已有回调；不修改输入，非 GPT 不注入', async () => {
  const body = Object.freeze({ model: MODEL }); const model = { id: MODEL } as Parameters<NonNullable<ReturnType<typeof requestOptions>['onPayload']>>[1];
  const options = requestOptions({ onPayload: async p => ({ ...(p as object), custom: true }) }, MODEL);
  assert.deepEqual(await options.onPayload!(body, model), { model: MODEL, custom: true, service_tier: 'priority' });
  assert.deepEqual(body, { model: MODEL }); assert.equal(await requestOptions(undefined, 'claude/opus').onPayload!(body, model), body);
});
test('取消与鉴权准备失败均返回终止块', async () => {
  const ctx = new Context(); const controller = new AbortController(); controller.abort(); let fetched = false;
  const pool = new FastPool({ context: ctx, resolveKey: async () => 'key', fetch: async () => { fetched = true; return chatReply(); } });
  const chunks = await collect(pool.stream(source(), request({ signal: controller.signal })));
  assert.ok(chunks.some(c => c.type === 'finish' && c.reason.kind === 'aborted')); assert.equal(fetched, false);
  pool.close(); await ctx.fiber.dispose();
});
test('插件只加开关：不注册新提供商，按会话生效，非 GPT 与关闭时走原链路', async () => {
  const wire = fakeTransport();
  const dir = await mkdtemp(join(tmpdir(), 'gpt-fast-plugin-')); const ctx = new Context(); await ctx.plugin(LlmRuntime);
  let handler!: (request: Request) => Promise<Response>; let originalCalls = 0;
  class Original extends LlmAdapter { async *stream(): AsyncIterable<StreamChunk> { originalCalls++; yield { type: 'finish', reason: { kind: 'stop' } }; } }
  ctx.llm.registerAdapter(['remote-magpie'], new Original());
  const original = ctx.llm.listProviders();
  ctx.provide('settings', { describe: () => [{ value: { providers: { 'remote-magpie': source().profile } } }] });
  ctx.provide('credentials', { resolve: async () => ({ value: 'test-gateway-key' }) });
  ctx.provide('connection', { fetch: { register: (spec: { fetch: typeof handler }) => { handler = spec.fetch; } } });
  try {
    await apply(ctx, { stateDir: dir }, { fetch: wire.fetch }); assert.deepEqual(ctx.llm.listProviders(), original);
    const get = () => handler(new Request(`https://dsh.invalid/api/magpie-fast?sessionId=session-a&provider=remote-magpie&model=${encodeURIComponent(MODEL)}`));
    assert.deepEqual(await (await get()).json(), { enabled: false, supported: true });
    const off = request({ reasoningEffort: undefined });
    await collect(ctx.llm.stream(off)); assert.equal(originalCalls, 1);
    const post = (enabled: unknown, model = MODEL) => handler(new Request('https://dsh.invalid/api/magpie-fast', { method: 'POST', body: JSON.stringify({ sessionId: 'session-a', provider: 'remote-magpie', model, enabled }) }));
    assert.equal((await post('yes')).status, 400); assert.equal((await post(true, 'claude/opus')).status, 409);
    assert.deepEqual(await (await post(true)).json(), { enabled: true, supported: true });
    const session = 'session-a' as NonNullable<GenerateOptions['sessionId']>;
    const fast = await collect(ctx.llm.stream(request({ sessionId: session, reasoningEffort: undefined })));
    assert.equal(wire.calls[0]?.body.service_tier, 'priority', JSON.stringify(fast));
    assert.equal(wire.calls[0]?.body.model, MODEL);
    await collect(ctx.llm.stream(request({ sessionId: session, model: 'claude/opus', reasoningEffort: undefined })));
    assert.equal(originalCalls, 2);
    // A request without this session is not intercepted, even while this session is enabled.
    await collect(ctx.llm.stream(off)); assert.equal(originalCalls, 3);
    assert.equal((await post(false)).status, 200);
    assert.deepEqual(ctx.llm.listProviders(), original);
  } finally { await ctx.fiber.dispose(); await rm(dir, { recursive: true, force: true }); }
});
test('复用 host 凭据服务；命名引用缺失不降级为假密钥', async () => {
  const ctx = new Context(); let resolved = '';
  ctx.provide('credentials', { resolve: async (ref: string) => { resolved = ref; return { value: '  stored-key  ' }; } });
  assert.equal(await resolveGatewayKey(ctx, source()), 'stored-key'); assert.equal(resolved, 'MAGPIE_GATEWAY_KEY');
  ctx.set('credentials', { resolve: async () => undefined }); await assert.rejects(resolveGatewayKey(ctx, source()), /Missing gateway credential/);
  await ctx.fiber.dispose();
});
