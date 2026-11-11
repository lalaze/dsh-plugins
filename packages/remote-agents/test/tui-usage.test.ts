import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenSshTransport } from '@dsh-plugins/remote-core/ssh.js';
import type { State } from '../src/core/store.js';
import type { RemoteUsageRecord } from '../src/agents/usage.js';
import { WorkspaceFiles } from '../src/workspace/files.js';
import { tuiClaudeSession } from '../src/workspace/tui.js';
import { QUIET_MS, readClaudeUsage, readCodexUsage, TuiUsage, tuiUsageChunks, type TuiUsageChunk, type TuiUsageEntry } from '../src/workspace/tui-usage.js';

const SESSION = '0f8c2a51-4b7e-4c3d-8e9f-1a2b3c4d5e6f', THREAD = '01a1aa8c-2934-7d21-bc0b-3d7917d3158e';
/** A Claude Code reply line, with what its log puts around the usage. */
const reply = (id: string, at: string, usage: { in?: number; out: number; read?: number; write?: number }, model = 'claude-fable-5-2', text = 'hello') => JSON.stringify({
  parentUuid: 'p', isSidechain: false,
  message: { model, id, type: 'message', role: 'assistant', content: [{ type: 'text', text }], container: null, stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: usage.in ?? 1, cache_creation_input_tokens: usage.write ?? 0, cache_read_input_tokens: usage.read ?? 0, output_tokens: usage.out, iterations: [{ input_tokens: 9, output_tokens: 9 }] } },
  toolInputStreamMs: 3, wireToolInputs: { toolu_1: { command: 'ls "a"' } }, serverClassifierRequest: 'x', requestId: `req_${id}`, type: 'assistant', uuid: 'u', timestamp: at,
});
const turnEnd = (at: string, durationMs: number) => JSON.stringify({ parentUuid: 'p', isSidechain: false, type: 'system', subtype: 'turn_duration', durationMs, timestamp: at });
const prompt = (text: string, at: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: text }, promptSource: 'typed', timestamp: at });
const chunk = (lines: string[], file = 'main', from = 0, end = from + 100): TuiUsageChunk => ({ file, from, end, capped: false, lines });
const codex = (type: string, at: string, payload: Record<string, unknown> = {}) => JSON.stringify(type === 'turn_context' ? { timestamp: at, type, payload } : { timestamp: at, type: 'event_msg', payload: { type, ...payload } });
const tokens = (input: number, cached: number, output: number) => ({ info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output } } });

test('a Claude Code turn counts each request once, across its lines and reads, and its subagents with it', () => {
  const first = readClaudeUsage(undefined, [chunk([
    reply('msg_1', '2026-11-10T16:00:01.000Z', { in: 2, out: 50, read: 1000, write: 200 }, undefined, 'thinking'),
    reply('msg_1', '2026-11-10T16:00:02.000Z', { in: 2, out: 50, read: 1000, write: 200 }),
    reply('msg_2', '2026-11-10T16:00:05.000Z', { in: 1, out: 10, read: 1200 }),
  ])], Date.parse('2026-11-10T16:00:06Z'));
  assert.deepEqual(first.turns, [], 'nothing counts until the turn ends');
  assert.equal(first.cursor.read.main, 100);
  const second = readClaudeUsage(first.cursor, [
    chunk([
      // The last request's other part: its usage grew while the reply streamed.
      reply('msg_2', '2026-11-10T16:00:06.000Z', { in: 1, out: 30, read: 1200 }),
      reply('msg_3', '2026-11-10T16:00:20.000Z', { in: 1, out: 5, read: 1300 }, 'claude-opus-5-5'),
      reply('msg_9', '2026-11-10T16:00:21.000Z', { in: 0, out: 0 }, '<synthetic>'),
      turnEnd('2026-11-10T16:00:21.500Z', 21_000),
    ], 'main', 100, 220),
    chunk([reply('msg_s1', '2026-11-10T16:00:10.000Z', { in: 3, out: 7, read: 400 }, 'claude-haiku-5-5')], 'agent-a1b2.jsonl', 0, 80),
  ], Date.parse('2026-11-10T16:00:22Z'));
  assert.deepEqual(second.turns, [{ startedAt: '2026-11-10T16:00:01.000Z', durationMs: 21_000, models: [
    { model: 'claude-fable-5-2', usage: { inputTokens: 3, outputTokens: 80, cacheReadTokens: 2200, cacheWriteTokens: 200 } },
    { model: 'claude-haiku-5-5', usage: { inputTokens: 3, outputTokens: 7, cacheReadTokens: 400 } },
    { model: 'claude-opus-5-5', usage: { inputTokens: 1, outputTokens: 5, cacheReadTokens: 1300 } },
  ] }]);
  assert.deepEqual(second.cursor.read, { main: 220, 'agent-a1b2.jsonl': 80 });
  assert.equal(second.cursor.open, undefined);
  const again = readClaudeUsage(second.cursor, [chunk([], 'main', 220, 220)], Date.parse('2026-11-10T17:00:00Z'));
  assert.deepEqual(again.turns, [], 'a read with nothing new counts nothing');
  assert.deepEqual(again.cursor, second.cursor);
});

/** Claude Code's line for a turn stopped with Esc during a reply, a tool, or between requests. */
const interrupted = (at: string, messageId: string, sidechain = false) => JSON.stringify({ parentUuid: 'p', isSidechain: sidechain, type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] }, timestamp: at, interruptedMessageId: messageId });

test('a Claude Code turn stopped with Esc counts at once, without waiting for its log to go quiet', () => {
  const start = Date.parse('2026-11-10T16:58:00Z');
  const result = readClaudeUsage(undefined, [
    chunk([
      reply('msg_1', '2026-11-10T16:58:08.000Z', { in: 2, out: 4, write: 22324 }),
      interrupted('2026-11-10T16:58:12.000Z', 'msg_1'),
      reply('msg_2', '2026-11-10T17:01:32.000Z', { in: 2, out: 95, read: 26279 }),
      // An interrupted subagent says nothing about the conversation's turn.
      interrupted('2026-11-10T17:01:40.000Z', 'msg_x', true),
      interrupted('2026-11-10T17:01:48.000Z', 'msg_2'),
      reply('msg_3', '2026-11-10T17:02:06.000Z', { in: 2, out: 147 }),
      interrupted('2026-11-10T17:02:09.500Z', 'msg_3'),
      // Esc at a permission prompt also logs the turn's duration, which then finds the turn already ended.
      turnEnd('2026-11-10T17:02:09.556Z', 2484),
    ]),
    chunk([interrupted('2026-11-10T17:01:41.000Z', 'msg_y')], 'agent-a1.jsonl'),
  ], start + 5 * 60_000);
  assert.deepEqual(result.turns.map(turn => [turn.startedAt, turn.durationMs, turn.models[0].usage.outputTokens]), [
    ['2026-11-10T16:58:08.000Z', 4000, 4], ['2026-11-10T17:01:32.000Z', 16_000, 95], ['2026-11-10T17:02:06.000Z', 3500, 147],
  ]);
  assert.equal(result.cursor.open, undefined);
});

test('a Claude Code turn that never logs its end counts once its log has been quiet a while', () => {
  const start = Date.parse('2026-11-10T16:00:00Z');
  const open = readClaudeUsage(undefined, [chunk([prompt('hi', '2026-11-10T16:00:00.000Z'), reply('msg_1', '2026-11-10T16:00:04.000Z', { out: 9 })])], start + 5_000);
  assert.ok(open.cursor.open);
  const still = readClaudeUsage(open.cursor, [chunk([], 'main', 100, 100)], start + QUIET_MS - 60_000);
  assert.deepEqual(still.turns, [], 'a long tool run is not taken for an end');
  const growing = readClaudeUsage(open.cursor, [chunk([prompt('more', '2026-11-10T16:40:00.000Z')], 'main', 100, 150)], start + QUIET_MS + 60_000);
  assert.deepEqual(growing.turns, [], 'nor is a log that still grows');
  const ended = readClaudeUsage(open.cursor, [chunk([], 'main', 100, 100)], start + QUIET_MS + 60_000);
  assert.deepEqual(ended.turns, [{ startedAt: '2026-11-10T16:00:04.000Z', durationMs: 0, models: [{ model: 'claude-fable-5-2', usage: { inputTokens: 1, outputTokens: 9 } }] }]);
  assert.equal(ended.cursor.open, undefined);
});

test('a Claude Code log written anew is read from its start, its old last request forgotten', () => {
  const first = readClaudeUsage(undefined, [chunk([reply('msg_1', '2026-11-10T16:00:01.000Z', { out: 5 }), turnEnd('2026-11-10T16:00:02.000Z', 1000)], 'main', 0, 500)]);
  assert.equal(first.turns.length, 1);
  const anew = readClaudeUsage(first.cursor, [chunk([reply('msg_1', '2026-11-10T17:00:01.000Z', { out: 5 }), turnEnd('2026-11-10T17:00:02.000Z', 1000)], 'main', 0, 120)]);
  assert.equal(anew.turns.length, 1, 'the same message ID in a new log is a new request');
  assert.equal(anew.cursor.read.main, 120);
});

test('a Codex turn uses what its running totals grew by, also when it was stopped or its totals started over', () => {
  const first = readCodexUsage(undefined, [chunk([
    codex('task_started', '2026-11-05T07:11:21.000Z'),
    codex('turn_context', '2026-11-05T07:11:22.000Z', { model: 'gpt-6-luna' }),
    codex('token_count', '2026-11-05T07:11:30.000Z', { info: null }),
    codex('token_count', '2026-11-05T07:12:27.000Z', tokens(18366, 6912, 3508)),
    codex('task_complete', '2026-11-05T07:12:28.000Z'),
    codex('task_started', '2026-11-05T07:12:32.000Z'),
  ])], 'gpt-default');
  assert.deepEqual(first.turns, [{ startedAt: '2026-11-05T07:11:21.000Z', durationMs: 67_000, models: [{ model: 'gpt-6-luna', usage: { inputTokens: 11454, outputTokens: 3508, cacheReadTokens: 6912, totalTokens: 21874 } }] }]);
  const second = readCodexUsage(first.cursor, [chunk([
    codex('token_count', '2026-11-05T07:12:34.000Z', tokens(40253, 25088, 3514)),
    codex('turn_aborted', '2026-11-05T07:12:35.000Z'),
    codex('task_started', '2026-11-05T08:00:00.000Z'),
    codex('turn_aborted', '2026-11-05T08:00:01.000Z'),
    codex('task_started', '2026-11-05T09:00:00.000Z'),
    codex('token_count', '2026-11-05T09:00:09.000Z', tokens(500, 100, 20)),
    codex('task_complete', '2026-11-05T09:00:10.000Z'),
  ], 'main', 100, 300)], 'gpt-default');
  assert.deepEqual(second.turns, [
    { startedAt: '2026-11-05T07:12:32.000Z', durationMs: 3000, models: [{ model: 'gpt-6-luna', usage: { inputTokens: 3711, outputTokens: 6, cacheReadTokens: 18176, totalTokens: 21893 } }] },
    { startedAt: '2026-11-05T09:00:00.000Z', durationMs: 10_000, models: [{ model: 'gpt-6-luna', usage: { inputTokens: 400, outputTokens: 20, cacheReadTokens: 100, totalTokens: 520 } }] },
  ], 'a turn stopped before any request counts nothing');
  const unnamed = readCodexUsage(undefined, [chunk([codex('task_started', '2026-11-05T07:11:21.000Z'), codex('token_count', '2026-11-05T07:11:25.000Z', tokens(10, 0, 2)), codex('task_complete', '2026-11-05T07:11:26.000Z')])], 'gpt-default');
  assert.equal(unnamed.turns[0].models[0].model, 'gpt-default', 'without a turn context the conversation\'s model stands');
});

test('a Codex subagent thread\'s turns count toward the conversation\'s turn running then, under its own model', () => {
  const CHILD = '01a1ab1c-a93a-7242-ab5b-507292cd48da', child = `thread-${CHILD}`;
  const first = readCodexUsage(undefined, [
    chunk([
      codex('task_started', '2026-11-05T09:49:00.000Z'),
      codex('turn_context', '2026-11-05T09:49:00.500Z', { model: 'gpt-6-astra' }),
      codex('token_count', '2026-11-05T09:49:30.000Z', tokens(1000, 800, 50)),
      codex('token_count', '2026-11-05T09:50:30.000Z', tokens(3000, 2400, 90)),
      codex('task_complete', '2026-11-05T09:51:00.000Z'),
    ]),
    // The reviewer of approval requests, read in the same go, with two turns of its own in the conversation's turn.
    chunk([
      codex('task_started', '2026-11-05T09:49:38.000Z'),
      codex('turn_context', '2026-11-05T09:49:38.100Z', { model: 'codex-auto-review' }),
      codex('token_count', '2026-11-05T09:49:41.000Z', tokens(100, 60, 5)),
      codex('task_complete', '2026-11-05T09:49:42.000Z'),
      codex('task_started', '2026-11-05T09:50:01.000Z'),
      codex('token_count', '2026-11-05T09:50:05.000Z', tokens(300, 200, 9)),
      codex('task_complete', '2026-11-05T09:50:06.000Z'),
      // One after the conversation's turn ended waits for its next.
      codex('task_started', '2026-11-05T09:52:00.000Z'),
      codex('token_count', '2026-11-05T09:52:03.000Z', tokens(400, 250, 10)),
      codex('task_complete', '2026-11-05T09:52:04.000Z'),
    ], child),
  ], 'gpt-default');
  assert.deepEqual(first.turns, [{ startedAt: '2026-11-05T09:49:00.000Z', durationMs: 120_000, models: [
    { model: 'codex-auto-review', usage: { inputTokens: 100, outputTokens: 9, cacheReadTokens: 200, totalTokens: 309 } },
    { model: 'gpt-6-astra', usage: { inputTokens: 600, outputTokens: 90, cacheReadTokens: 2400, totalTokens: 3090 } },
  ] }]);
  assert.deepEqual(first.cursor.read, { main: 100, [child]: 100 });
  const second = readCodexUsage(first.cursor, [
    chunk([codex('task_started', '2026-11-05T10:00:00.000Z'), codex('token_count', '2026-11-05T10:00:05.000Z', tokens(3500, 2800, 95)), codex('task_complete', '2026-11-05T10:00:06.000Z')], 'main', 100, 200),
    chunk([], child, 100, 100),
  ], 'gpt-default');
  assert.deepEqual(second.turns, [{ startedAt: '2026-11-05T10:00:00.000Z', durationMs: 6000, models: [
    { model: 'codex-auto-review', usage: { inputTokens: 50, outputTokens: 1, cacheReadTokens: 50, totalTokens: 101 } },
    { model: 'gpt-6-astra', usage: { inputTokens: 100, outputTokens: 5, cacheReadTokens: 400, totalTokens: 505 } },
  ] }]);
});

async function home(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tui-usage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  class LocalTransport extends OpenSshTransport {
    constructor() { super('ssh://test.invalid'); }
    protected override spawnRemote(command: string): ChildProcessWithoutNullStreams {
      const env: NodeJS.ProcessEnv = { ...process.env, SHELL: '/bin/sh', HOME: root };
      delete env.CLAUDE_CONFIG_DIR; delete env.CODEX_HOME;
      return spawn('/bin/sh', ['-c', command], { stdio: ['pipe', 'pipe', 'pipe'], env });
    }
  }
  return { root, files: new WorkspaceFiles(new LocalTransport()) };
}
const read = async (files: WorkspaceFiles, entries: TuiUsageEntry[], cap?: number) => tuiUsageChunks((await files.tuiUsageLines(entries, undefined, cap)).toString());

test('TUI logs are read on the real shell: whole lines only, without message text, each file from where it was left', async t => {
  const { root, files } = await home(t), project = join(root, '.claude/projects/-srv-app'), agents = join(project, SESSION, 'subagents');
  await mkdir(agents, { recursive: true });
  const main = join(project, `${SESSION}.jsonl`), secret = 'a reply text worth megabytes';
  const lines = [prompt('hi', '2026-11-10T16:00:00.000Z'), reply('msg_1', '2026-11-10T16:00:01.000Z', { out: 5 }, undefined, secret), JSON.stringify({ type: 'attachment' }), interrupted('2026-11-10T16:00:01.500Z', 'msg_1')];
  await writeFile(main, lines.join('\n') + '\n' + turnEnd('2026-11-10T16:00:02.000Z', 2000).slice(0, 20));
  await writeFile(join(agents, 'agent-a1.jsonl'), reply('msg_s', '2026-11-10T16:00:01.500Z', { out: 3 }) + '\n');
  const before = Buffer.byteLength(lines.join('\n') + '\n');
  const first = await read(files, [{ cli: 'claude', id: SESSION, read: {} }]);
  assert.equal(first.more, false);
  const [mainChunk, agentChunk] = first.entries.get(0)!;
  assert.deepEqual([mainChunk.file, mainChunk.from, mainChunk.end], ['main', 0, before], 'the line still being written waits');
  assert.equal(mainChunk.lines.length, 2, 'only lines that can hold usage or end a turn come');
  assert.equal(JSON.parse(mainChunk.lines[1]).interruptedMessageId, 'msg_1');
  assert.ok(!mainChunk.lines[0].includes(secret) && !mainChunk.lines[0].includes('wireToolInputs'));
  assert.deepEqual(JSON.parse(mainChunk.lines[0]).message.content, []);
  assert.equal(JSON.parse(mainChunk.lines[0]).message.usage.output_tokens, 5);
  assert.deepEqual([agentChunk.file, agentChunk.lines.length], ['agent-a1.jsonl', 1]);
  await appendFile(main, turnEnd('2026-11-10T16:00:02.000Z', 2000).slice(20) + '\n');
  const second = await read(files, [{ cli: 'claude', id: SESSION, read: { main: mainChunk.end, 'agent-a1.jsonl': agentChunk.end } }]);
  const [mainAgain, agentAgain] = second.entries.get(0)!;
  assert.equal(mainAgain.from, before);
  assert.deepEqual(mainAgain.lines.map(line => JSON.parse(line).subtype), ['turn_duration']);
  assert.deepEqual([agentAgain.from, agentAgain.end, agentAgain.lines], [agentChunk.end, agentChunk.end, []]);
  const none = await read(files, [{ cli: 'claude', id: '0f8c2a51-0000-4c3d-8e9f-1a2b3c4d5e6f', read: {} }, { cli: 'claude', id: '$(touch x)', read: {} }]);
  assert.equal(none.entries.size, 0, 'a session that is not there, or an odd ID, reads nothing');
});

test('a long TUI log is read in parts, and a line longer than a part is passed over', async t => {
  const { root, files } = await home(t), project = join(root, '.claude/projects/-srv-app');
  await mkdir(project, { recursive: true });
  const main = join(project, `${SESSION}.jsonl`), lines = [reply('msg_1', '2026-11-10T16:00:01.000Z', { out: 1 }), JSON.stringify({ type: 'big', data: 'x'.repeat(2000) }), reply('msg_2', '2026-11-10T16:00:02.000Z', { out: 2 })];
  await writeFile(main, lines.join('\n') + '\n');
  let read_: Record<string, number> = {}, seen: string[] = [], rounds = 0, more = true;
  while (more && rounds++ < 10) {
    const result = await read(files, [{ cli: 'claude', id: SESSION, read: read_ }], 1500);
    const [part] = result.entries.get(0)!;
    seen = [...seen, ...part.lines.map(line => JSON.parse(line).message.id)];
    read_ = { main: part.end }; more = result.more;
  }
  assert.deepEqual(seen, ['msg_1', 'msg_2']);
  assert.equal(read_.main, Buffer.byteLength(lines.join('\n') + '\n'));
});

test('a Codex thread\'s log is found by its ID and read for its turns', async t => {
  const { root, files } = await home(t), sessions = join(root, '.codex/sessions/2026/11/05');
  await mkdir(sessions, { recursive: true });
  const lines = [codex('task_started', '2026-11-05T07:11:21.000Z'), JSON.stringify({ type: 'response_item', payload: { type: 'message', content: 'long' } }), codex('turn_context', '2026-11-05T07:11:22.000Z', { model: 'gpt-6-luna' }), codex('token_count', '2026-11-05T07:12:27.000Z', tokens(10, 4, 3)), codex('task_complete', '2026-11-05T07:12:28.000Z')];
  await writeFile(join(sessions, `rollout-2026-11-05T02-11-17-${THREAD}.jsonl`), lines.join('\n') + '\n');
  const result = await read(files, [{ cli: 'codex', id: THREAD, read: {} }]);
  const [main] = result.entries.get(0)!;
  assert.equal(main.lines.length, 4);
  assert.deepEqual(readCodexUsage(undefined, [main], 'x').turns.map(turn => turn.models[0].usage), [{ inputTokens: 6, outputTokens: 3, cacheReadTokens: 4, totalTokens: 13 }]);
});

test('a Codex thread\'s subagent threads are found by their parent, all at first and then among recent files, and read from where they were left', async t => {
  const { root, files } = await home(t), day = join(root, '.codex/sessions/2026/11/05');
  await mkdir(day, { recursive: true });
  const CHILD = '01a1ab1c-a93a-7242-ab5b-507292cd48da', GRANDCHILD = '01a1ab1d-0000-7242-ab5b-507292cd48da', OTHER = '01a1ab1e-0000-7242-ab5b-507292cd48da', OLDER = '01a1aa00-0000-7242-ab5b-507292cd48da';
  const meta = (id: string, parent?: string) => JSON.stringify({ timestamp: '2026-11-05T09:49:04.000Z', type: 'session_meta', payload: { id, ...(parent ? { parent_thread_id: parent } : {}), source: { subagent: { other: 'guardian' } }, base_instructions: 'x'.repeat(500) } });
  const turn = [codex('task_started', '2026-11-05T09:49:38.000Z'), codex('token_count', '2026-11-05T09:49:41.000Z', tokens(100, 60, 5)), codex('task_complete', '2026-11-05T09:49:42.000Z')];
  const write = (name: string, id: string, parent?: string) => writeFile(join(day, `rollout-2026-11-05T${name}-${id}.jsonl`), [meta(id, parent), ...turn].join('\n') + '\n');
  await write('04-30-00', THREAD);
  await write('04-49-04', CHILD, THREAD);
  await write('04-50-00', GRANDCHILD, CHILD);
  await write('04-51-00', OTHER, '01a1ffff-0000-7242-ab5b-507292cd48da');
  // Named as begun before the conversation's thread, so not looked at, whatever it says.
  await write('04-00-00', OLDER, THREAD);
  const first = await read(files, [{ cli: 'codex', id: THREAD, read: {} }]);
  const names = (result: typeof first) => (result.entries.get(0) ?? []).map(chunk => chunk.file).sort();
  assert.deepEqual(names(first), ['main', `thread-${CHILD}`], 'a subagent of a subagent waits for its parent to be known');
  const known = Object.fromEntries(first.entries.get(0)!.map(chunk => [chunk.file, chunk.end]));
  const second = await read(files, [{ cli: 'codex', id: THREAD, read: known }]);
  assert.deepEqual(names(second), ['main', `thread-${CHILD}`, `thread-${GRANDCHILD}`]);
  assert.deepEqual(second.entries.get(0)!.filter(chunk => chunk.file === `thread-${CHILD}`).map(chunk => [chunk.from, chunk.lines.length]), [[known[`thread-${CHILD}`], 0]], 'a known one is read on from where it was left');
  // Searching only recent files: none is recent enough here, yet the known ones are still read.
  const old = new Date(Date.now() - 3 * 3600_000);
  for (const file of await readdir(day)) await utimes(join(day, file), old, old);
  const recent = await read(files, [{ cli: 'codex', id: THREAD, read: { main: 0 }, since: 30 }]);
  assert.deepEqual(names(recent), ['main'], 'files unchanged in the window are not looked at');
  const knownRecent = await read(files, [{ cli: 'codex', id: THREAD, read: { main: 0, [`thread-${CHILD}`]: 0 }, since: 30 }]);
  assert.deepEqual(names(knownRecent), ['main', `thread-${CHILD}`]);
});

test('TUI usage is saved before it is sent, per machine, once, and only for TUI conversations', async () => {
  const claudeId = 'tui-claude', codexId = 'tui-codex', claudeSession = tuiClaudeSession(claudeId);
  let state = { version: 1, hosts: [], tasks: [], tuiSessions: [claudeId, codexId, 'gone'], tuiDetails: { [codexId]: { cli: 'codex', thread: THREAD, model: 'gpt-x' } } } as unknown as State;
  const store = { snapshot: () => structuredClone(state), update: async (change: (draft: State) => void) => { const draft = structuredClone(state); change(draft); state = draft; saved.push(structuredClone(state)); } };
  const saved: State[] = [], records: RemoteUsageRecord[] = [], reads: { hostId: string; sessions: string[]; entries: TuiUsageEntry[] }[] = [], warnings: string[] = [];
  const outputs: Record<string, string[]> = {
    [claudeSession]: [`@ 0 0 300 0 main\n${reply('msg_1', '2026-11-10T16:00:01.000Z', { out: 5, read: 10 })}\n${turnEnd('2026-11-10T16:00:03.000Z', 2500)}\n`, '@ 0 300 300 0 main\n'],
    [THREAD]: [`@ 0 0 90 0 main\n${codex('task_started', '2026-11-05T07:11:21.000Z')}\n${codex('token_count', '2026-11-05T07:12:27.000Z', tokens(10, 4, 3))}\n${codex('task_complete', '2026-11-05T07:12:28.000Z')}\n`, '@ 0 90 90 0 main\n'],
  };
  const usage = new TuiUsage(store, {
    target: async id => { if (id === 'gone') throw new Error('not a remote workspace'); return id === claudeId ? { hostId: 'h1', label: 'mac-mini', cwd: '/srv/app' } : { hostId: 'h2', label: 'code', cwd: '/root/web' }; },
    read: async (hostId, sessions, entries) => {
      reads.push({ hostId, sessions: sessions.map(s => s.sessionId), entries: structuredClone(entries) as TuiUsageEntry[] });
      return outputs[entries[0].id].shift() ?? '';
    },
    emit: record => { assert.ok(saved.length, 'where reading got to is saved first'); records.push(record); },
    warn: message => warnings.push(message),
  });
  await usage.sweep();
  assert.deepEqual(reads.map(r => [r.hostId, r.sessions, r.entries.map(e => [e.cli, e.id])]), [['h1', [claudeId], [['claude', claudeSession]]], ['h2', [codexId], [['codex', THREAD]]]]);
  assert.deepEqual(records.map(({ id, ...record }) => record), [
    { startedAt: '2026-11-10T16:00:01.000Z', provider: 'remote-cli-claude', model: 'claude-fable-5-2', sessionId: claudeId, purpose: 'conversation', status: 'completed', durationMs: 2500, usage: { inputTokens: 1, outputTokens: 5, cacheReadTokens: 10 }, host: 'mac-mini', workspace: '/srv/app' },
    { startedAt: '2026-11-05T07:11:21.000Z', provider: 'remote-cli-codex', model: 'gpt-x', sessionId: codexId, purpose: 'conversation', status: 'completed', durationMs: 67_000, usage: { inputTokens: 6, outputTokens: 3, cacheReadTokens: 4, totalTokens: 13 }, host: 'code', workspace: '/root/web' },
  ]);
  assert.deepEqual(state.tuiDetails?.[claudeId]?.usage?.read, { main: 300 });
  assert.equal(state.tuiDetails?.[codexId]?.thread, THREAD, 'the rest of a conversation\'s details stay');
  await usage.sweep([claudeId, 'not-a-tui']);
  assert.deepEqual(reads.slice(2).map(r => r.entries.map(e => e.read)), [[{ main: 300 }]], 'only the given TUI conversations are read, from where they were left');
  assert.equal(records.length, 2, 'nothing is counted twice');
  assert.deepEqual(warnings, []);
  usage.close();
});

test('a machine that cannot be read is reported and read again next time, from the same place', async () => {
  let state = { version: 1, hosts: [], tasks: [], tuiSessions: ['a'] } as unknown as State, fail = true;
  const store = { snapshot: () => structuredClone(state), update: async (change: (draft: State) => void) => { const draft = structuredClone(state); change(draft); state = draft; } };
  const warnings: string[] = [], records: RemoteUsageRecord[] = [];
  const usage = new TuiUsage(store, {
    target: async () => ({ hostId: 'h1', label: 'mac-mini', cwd: '/srv/app' }),
    read: async () => { if (fail) throw new Error('SSH exited (255)'); return `@ 0 0 300 0 main\n${reply('msg_1', '2026-11-10T16:00:01.000Z', { out: 5 })}\n${turnEnd('2026-11-10T16:00:03.000Z', 2500)}\n`; },
    emit: record => records.push(record), warn: message => warnings.push(message),
  });
  await usage.sweep();
  assert.match(warnings[0], /mac-mini could not be read: SSH exited/);
  assert.equal(state.tuiDetails, undefined);
  fail = false;
  await usage.sweep();
  assert.equal(records.length, 1);
  usage.close();
});

test('Codex subagent threads are looked for in all files once, again at once when some turn up, then only in recent ones', async () => {
  const CHILD = '01a1ab1c-a93a-7242-ab5b-507292cd48da';
  let state = { version: 1, hosts: [], tasks: [], tuiSessions: ['c'], tuiDetails: { c: { cli: 'codex', thread: THREAD } } } as unknown as State;
  const store = { snapshot: () => structuredClone(state), update: async (change: (draft: State) => void) => { const draft = structuredClone(state); change(draft); state = draft; } };
  const sent: TuiUsageEntry[] = [], outputs = [`@ 0 0 50 0 main\n@ 0 0 40 0 thread-${CHILD}\n`, `@ 0 50 50 0 main\n@ 0 40 40 0 thread-${CHILD}\n`, `@ 0 50 50 0 main\n`];
  const usage = new TuiUsage(store, {
    target: async () => ({ hostId: 'h1', label: 'code', cwd: '/root/web' }),
    read: async (_host, _sessions, entries) => { sent.push(structuredClone(entries[0])); return outputs.shift() ?? ''; },
    emit: () => {},
  });
  await usage.sweep();
  assert.deepEqual(sent.map(entry => entry.since), [undefined, undefined], 'a new subagent thread makes the whole search run again at once');
  assert.deepEqual(sent[1].read, { main: 50, [`thread-${CHILD}`]: 40 });
  assert.ok(state.tuiDetails?.c?.usage?.scannedAt);
  await usage.sweep();
  assert.ok(sent[2].since! >= 10 && sent[2].since! <= 11, `then only files changed since, with a margin (${sent[2].since})`);
  usage.close();
});
