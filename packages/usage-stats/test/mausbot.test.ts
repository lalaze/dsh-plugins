import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { combine, report, type UsageReport } from '../src/domain.js';
import { MausbotUsage, mausbotProvider, mausbotWorkspace, parseMausbotLine } from '../src/mausbot.js';
import type { LinkService } from '../src/machines.js';
import { apply, Config } from '../src/index.js';

test('OpenMausBot 行解析：input 拆分为未缓存输入与缓存读写，零用量超时记为未知用量，memory 不污染会话筛选', () => {
  const codex = parseMausbotLine(JSON.stringify({
    botId: 'b1', botName: 'MausBot', threadId: 't1', instanceId: 'codex', driverKind: 'codex', model: 'gpt-6.2-sol',
    input: 2_430_393, output: 3_160, cachedInput: 2_410_496, reasoning: 969,
    trigger: { kind: 'user', label: 'Chrome on Mac' }, turnId: 'turn-1',
    startedAt: '2026-11-18T08:25:05.360Z', endedAt: '2026-11-18T08:27:54.642Z',
    outcome: { status: 'ok' }, usageStatus: 'complete', at: '2026-11-18T08:27:54.666Z',
  }), 'id-1')!;
  assert.equal(codex.record.provider, 'mausbot-codex');
  assert.equal(codex.record.sessionId, 'mausbot:t1');
  assert.equal(codex.record.status, 'completed');
  assert.equal(codex.record.durationMs, 169_282);
  assert.deepEqual(codex.record.usage, {
    inputTokens: 19_897,
    outputTokens: 3_160,
    cacheReadTokens: 2_410_496,
    reasoningTokens: 969,
  });
  // Total tokens must equal OpenMausBot's input (incl. cache) + output, without double-counting cache or reasoning.
  const codexReport = report([{ ...codex.record, workspace: mausbotWorkspace(codex.botName) }], { groupBy: 'provider' });
  assert.equal(codexReport.totals.totalTokens, 2_430_393 + 3_160);

  const claude = parseMausbotLine(JSON.stringify({
    botId: 'b1', botName: 'MausBot', threadId: 't2', instanceId: 'claude', driverKind: 'claudeAgent', model: 'claude-sonnet-5',
    input: 1000, output: 200, cachedInput: 600, cacheWrite: 150,
    startedAt: '2026-11-18T09:00:00.000Z', endedAt: '2026-11-18T09:00:05.000Z',
    outcome: { status: 'interrupted', reason: 'interrupted' }, usageStatus: 'complete', at: '2026-11-18T09:00:05.010Z',
    trigger: { kind: 'owner' },
  }), 'id-2')!;
  assert.equal(claude.record.provider, 'mausbot-claude');
  assert.equal(claude.record.status, 'cancelled');
  assert.deepEqual(claude.record.usage, { inputTokens: 250, outputTokens: 200, cacheReadTokens: 600, cacheWriteTokens: 150 });

  const timedOut = parseMausbotLine(JSON.stringify({
    botId: 'b2', botName: '新闻', threadId: 't3', instanceId: 'pi', driverKind: 'piAgent', model: 'workbuddy/cn:deepseek-v4.1-flash',
    input: 0, output: 0, cachedInput: 0,
    startedAt: '2026-11-12T22:00:24.795Z', endedAt: '2026-11-12T22:01:27.325Z',
    outcome: { status: 'error', reason: 'Request timed out.' }, usageStatus: 'complete', at: '2026-11-12T22:01:27.371Z',
    trigger: { kind: 'routine', label: '论坛热点' },
  }), 'id-3')!;
  assert.equal(timedOut.record.status, 'error');
  assert.equal(timedOut.record.usage, undefined);
  assert.equal(timedOut.record.purpose, 'routine');

  const memory = parseMausbotLine(JSON.stringify({
    botId: 'b1', botName: 'MausBot', threadId: 'memory-a4475d9f-e5ac-493c-ae1b-549dd6e0327c',
    instanceId: 'claude', driverKind: 'claudeAgent', model: 'claude-haiku-5-5',
    input: 5046, output: 4, cachedInput: 649, trigger: { kind: 'bot', botId: 'b1' }, at: '2026-11-11T03:23:16.452Z',
  }), 'id-4')!;
  assert.equal(memory.record.sessionId, undefined);
  assert.equal(memory.record.purpose, 'memory');
  assert.equal(memory.record.startedAt, '2026-11-11T03:23:16.452Z');
  assert.equal(memory.record.durationMs, 0);

  assert.equal(mausbotProvider('openai-compat', 'openrouter'), 'mausbot-openrouter');
  assert.equal(mausbotProvider('openai-compat', 'openai'), 'mausbot-openai');
  assert.equal(mausbotWorkspace('MausBot'), 'MausBot');
  assert.equal(mausbotWorkspace('新闻'), 'MausBot · 新闻');
});

test('增量读取月度账本：目录不存在时静默为空，追加写入、半行缓冲与机器人改名均不丢不重', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mausbot-'));
  try {
    const reader = new MausbotUsage(join(root, 'missing'));
    assert.deepEqual(await reader.records(), []);

    const usageDir = join(root, 'omb', 'usage');
    await mkdir(join(usageDir, 'spans'), { recursive: true });
    await writeFile(join(usageDir, 'notes.txt'), 'ignored\n');
    await writeFile(join(usageDir, '2026-10.jsonl'), JSON.stringify({
      botId: 'b-news', botName: '旧闻', threadId: 't-oct', driverKind: 'grokAgent', model: 'grok-4.7',
      input: 1000, output: 50, cachedInput: 800, trigger: { kind: 'user' }, at: '2026-10-31T23:00:00.000Z',
    }) + '\n');
    const nov = join(usageDir, '2026-11.jsonl');
    const firstNov = JSON.stringify({
      botId: 'b-main', botName: 'MausBot', threadId: 't-nov', driverKind: 'antigravityAgent', model: 'gemini-4-hydrogen',
      input: 500, output: 20, cachedInput: 300, trigger: { kind: 'user' }, at: '2026-11-18T08:00:00.000Z',
    });
    // Include a corrupt line and an unfinished partial line at EOF.
    await writeFile(nov, `${firstNov}\n{corrupt\n{"botId":"b-news","botName":"新闻"`);

    const live = new MausbotUsage(join(root, 'omb'));
    const initial = await live.records();
    assert.equal(initial.length, 2);
    assert.deepEqual(initial.map(r => r.workspace), ['MausBot · 旧闻', 'MausBot']);

    // Finish the partial line; the earlier valid row is kept once and the bot rename updates October's workspace label too.
    await appendFile(nov, ',"threadId":"t-nov-2","driverKind":"piAgent","model":"workbuddy/cn:deepseek-v4.1-flash","input":2000,"output":100,"cachedInput":1500,"trigger":{"kind":"routine"},"at":"2026-11-18T08:05:00.000Z"}\n');
    const updated = await live.records();
    assert.equal(updated.length, 3);
    assert.equal(new Set(updated.map(r => r.id)).size, 3);
    assert.deepEqual(updated.map(r => r.workspace), ['MausBot · 新闻', 'MausBot', 'MausBot · 新闻']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('API 与互联多机汇总：Mac mini 上的 MausBot 用量计入本机与全部机器，其他机器无目录不重复计入', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-usage-mausbot-api-'));
  try {
    const stateDir = join(root, 'state');
    const mausbotDir = join(root, 'mausbot');
    await mkdir(stateDir, { recursive: true });
    await mkdir(join(mausbotDir, 'usage'), { recursive: true });
    await writeFile(join(stateDir, 'usage.json'), JSON.stringify({
      version: 1,
      records: [
        { id: 'dsh-1', startedAt: '2026-11-18T06:00:00.000Z', provider: 'deepseek', model: 'deepseek-chat', sessionId: 's-dsh', purpose: 'conversation', status: 'completed', durationMs: 100, usage: { inputTokens: 100, outputTokens: 50 } },
        { id: 'rem-1', startedAt: '2026-11-18T06:10:00.000Z', provider: 'remote-cli-codex', model: 'gpt-6.2-sol', sessionId: 's-rem', purpose: 'conversation', status: 'completed', durationMs: 200, host: 'mac-mini', workspace: '/Volumes/data/code/dsh-plugins', usage: { inputTokens: 300, outputTokens: 100 } },
      ],
    }));
    await writeFile(join(mausbotDir, 'usage', '2026-11.jsonl'), [
      JSON.stringify({
        botId: 'b1', botName: 'MausBot', threadId: 't1', instanceId: 'codex', driverKind: 'codex', model: 'gpt-6.2-sol',
        input: 1000, output: 200, cachedInput: 700, startedAt: '2026-11-18T07:00:00.000Z', endedAt: '2026-11-18T07:01:00.000Z',
        outcome: { status: 'ok' }, usageStatus: 'complete', trigger: { kind: 'user' }, at: '2026-11-18T07:01:00.000Z',
      }),
      JSON.stringify({
        botId: 'b2', botName: '新闻/热点', threadId: 't2', instanceId: 'pi', driverKind: 'piAgent', model: 'workbuddy/cn:deepseek-v4.1-flash',
        input: 2000, output: 300, cachedInput: 1500, startedAt: '2026-11-18T08:00:00.000Z', endedAt: '2026-11-18T08:02:00.000Z',
        outcome: { status: 'ok' }, usageStatus: 'complete', trigger: { kind: 'routine' }, at: '2026-11-18T08:02:00.000Z',
      }),
    ].join('\n') + '\n');

    // Configure Mac mini DSH instance with DSH Link seeing a MacBook Air that has no OpenMausBot directory.
    const airReport = report([
      { id: 'air-1', startedAt: '2026-11-18T09:00:00.000Z', provider: 'anthropic', model: 'claude-sonnet-5', sessionId: 's-air', purpose: 'conversation', status: 'completed', durationMs: 50, usage: { inputTokens: 80, outputTokens: 20 } },
    ], { groupBy: 'provider' });
    const link: LinkService = {
      version: 1,
      self: () => ({ id: 'mini', name: 'mac-mini' }),
      machines: () => [{ id: 'air', name: 'macbook-air', state: 'online' }],
      get: async () => ({ status: 200, text: JSON.stringify(airReport) }),
    };
    let fetcher: ((r: Request) => Promise<Response>) | undefined;
    const ctx = {
      effect: () => {},
      on: () => () => {},
      get: (name: string) => name === 'dshLink' ? link : undefined,
      connection: { fetch: { register: (route: { fetch: typeof fetcher }) => { fetcher = route.fetch; } } },
    } as unknown as Context;
    await apply(ctx, { stateDir, mausbotDir });

    // Own report (what other machines pull from Mac mini via DSH Link): includes DSH + Remote Agents + MausBot.
    const own = await (await fetcher!(new Request('http://x/api/usage-stats?groupBy=provider'))).json() as UsageReport;
    assert.equal(own.totals.totalTokens, 150 + 400 + 1200 + 2300);
    assert.deepEqual(own.sources.map(s => [s.key, s.label, s.totals.totalTokens]), [
      ['dsh', 'DSH model calls', 150],
      ['mausbot', 'MausBot', 3500],
      ['remote-agents', 'Remote agents', 400],
    ]);
    // By provider merges remote-cli-codex and mausbot-codex under Codex, and shows Pi for piAgent.
    assert.deepEqual(own.breakdowns.provider.map(g => [g.label, g.totals.totalTokens]), [
      ['Pi', 2300],
      ['Codex', 1600],
      ['deepseek', 150],
    ]);
    // By vendor maps workbuddy/cn:deepseek-v4.1-flash -> DeepSeek and gpt-6.2-sol -> OpenAI.
    assert.deepEqual(own.breakdowns.vendor.map(g => [g.label, g.totals.totalTokens]), [
      ['DeepSeek', 2450],
      ['OpenAI', 1600],
    ]);
    // By workspace keeps named MausBot bots with `workspace:` prefix so slashes in bot names are not shortened as paths.
    assert.deepEqual(own.breakdowns.workspace.map(g => [g.key, g.label, g.totals.totalTokens]), [
      ['workspace:mausbot:MausBot · 新闻/热点', 'MausBot · 新闻/热点', 2300],
      ['workspace:mausbot:MausBot', 'MausBot', 1200],
      ['/Volumes/data/code/dsh-plugins', '/Volumes/data/code/dsh-plugins', 400],
      ['', 'No workspace', 150],
    ]);
    // Source filter isolates MausBot usage.
    const onlyMausbot = await (await fetcher!(new Request('http://x/api/usage-stats?source=mausbot'))).json() as UsageReport;
    assert.equal(onlyMausbot.totals.requests, 2);
    assert.equal(onlyMausbot.totals.totalTokens, 3500);

    // Combined report across machines (`machines=all`): Mac mini's MausBot usage lands under `mac-mini` host and carries `mac-mini` on workspace rows.
    const all = await (await fetcher!(new Request('http://x/api/usage-stats?machines=all&groupBy=host'))).json() as UsageReport;
    assert.equal(all.totals.totalTokens, 4050 + 100);
    assert.deepEqual(all.breakdowns.host.map(g => [g.key, g.totals.totalTokens]), [
      ['mac-mini', 4050],
      ['macbook-air', 100],
    ]);
    const botWorkspace = all.breakdowns.workspace.find(g => g.label === 'MausBot · 新闻/热点');
    assert.equal(botWorkspace?.machine, 'mac-mini');
    assert.ok(botWorkspace?.key.startsWith('workspace:'));

    // Also verify when MacBook Air asks Mac mini via combine: no double counting.
    const fromAir = combine([
      { id: 'air', name: 'macbook-air', self: true, state: 'counted', report: airReport },
      { id: 'mini', name: 'mac-mini', state: 'counted', report: own },
    ], { groupBy: 'host' });
    assert.equal(fromAir.totals.totalTokens, 4150);

    // Schema defaults populate mausbotDir when Cordis loads the plugin normally.
    const parsedConfig = Config({});
    assert.ok(typeof parsedConfig.mausbotDir === 'string' && parsedConfig.mausbotDir.length > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
