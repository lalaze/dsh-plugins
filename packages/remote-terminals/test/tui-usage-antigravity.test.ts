import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenSshTransport, type SshTransport } from '@dsh-plugins/remote-core/ssh.js';
import { antigravityCall, readAntigravityUsage } from '../src/tui-usage-antigravity.js';
import { tuiUsageChunks, type TuiUsageChunk, type TuiUsageCursor } from '../src/tui-usage.js';
import { ANTIGRAVITY_SQL_PYTHON, TuiRemote } from '../src/tui-remote.js';
import { callLine, callRow, PROMPT, RESPONSE, stateLine, stepLine, stepRow, TOOL } from './antigravity-fixture.js';

const CONVERSATION = '4353aa3e-2919-42f9-82bf-36cf61f370fc';
const part = (file: string, lines: string[], options: { from?: number; end?: number; capped?: boolean } = {}): TuiUsageChunk =>
  ({ file, from: options.from ?? 0, end: options.end ?? options.from ?? 0, capped: options.capped ?? false, lines });
const state = (running: boolean) => part('state', [stateLine(running)]);

test('an Antigravity call is read from its row: usage, model, the step it came after and how long it took', () => {
  assert.deepEqual(antigravityCall(3, callRow({ step: 41, model: 'gemini-4-carbon', input: 14148, output: 11685, cached: 104356, thinking: 11521, waitMs: 9_500, writeMs: 4_250 })), {
    index: 3, step: 41, model: 'gemini-4-carbon', durationMs: 13_750,
    usage: { inputTokens: 14148, outputTokens: 11685, cacheReadTokens: 104356, reasoningTokens: 11521, totalTokens: 130189 },
  });
  assert.equal(antigravityCall(0, Uint8Array.from([0, 1, 2])), undefined, 'a row that is not a call reads as nothing');
  assert.equal(antigravityCall(0, Uint8Array.from([0x0a, 0x05, 1])), undefined, 'nor does a cut one');
});

test('an Antigravity turn counts once Antigravity says it is idle, each call once, under the model it used', () => {
  const first = readAntigravityUsage(undefined, [
    state(true),
    part('calls', [
      callLine(0, { step: 0, model: 'gemini-4-carbon', input: 100, output: 10, thinking: 5, waitMs: 2000, writeMs: 1000 }),
      callLine(1, { step: 2, model: 'gemini-4-carbon', input: 20, output: 5, cached: 100, waitMs: 1000, writeMs: 1000 }),
    ], { end: 2 }),
    // Step 5 is the response of a call still running, which is written only once it is done.
    part('steps', [
      stepLine(0, PROMPT, '2026-11-17T12:00:00.000Z'), stepLine(1, RESPONSE, '2026-11-17T12:00:01.000Z'), stepLine(2, TOOL, '2026-11-17T12:00:05.000Z'),
      stepLine(3, RESPONSE, '2026-11-17T12:00:06.000Z'), stepLine(4, TOOL, '2026-11-17T12:00:15.000Z'), stepLine(5, RESPONSE, '2026-11-17T12:00:20.000Z'),
    ]),
  ], 'fallback', Date.parse('2026-11-17T12:00:21Z'));
  assert.deepEqual(first.turns, [], 'nothing counts while the turn runs');
  assert.deepEqual(first.cursor, { read: { calls: 2, steps: 4 }, open: { startedAt: '2026-11-17T12:00:00.000Z', seen: '2026-11-17T12:00:08.000Z', models: {
    'gemini-4-carbon': { inputTokens: 120, outputTokens: 15, reasoningTokens: 5, totalTokens: 235, cacheReadTokens: 100 },
  } } }, 'steps past the calls read wait for them');
  const second = readAntigravityUsage(first.cursor, [
    state(false),
    part('calls', [callLine(2, { step: 4, model: 'gemini-3.8-flash', input: 7, output: 3, cached: 50, waitMs: 2000, writeMs: 1000 })], { from: 2, end: 3 }),
    part('steps', [stepLine(4, TOOL, '2026-11-17T12:00:15.000Z'), stepLine(5, RESPONSE, '2026-11-17T12:00:20.000Z')], { from: 4 }),
  ], 'fallback', Date.parse('2026-11-17T12:00:30Z'));
  assert.deepEqual(second.turns, [{ startedAt: '2026-11-17T12:00:00.000Z', durationMs: 23_000, models: [
    { model: 'gemini-4-carbon', usage: { inputTokens: 120, outputTokens: 15, reasoningTokens: 5, totalTokens: 235, cacheReadTokens: 100 } },
    { model: 'gemini-3.8-flash', usage: { inputTokens: 7, outputTokens: 3, totalTokens: 60, cacheReadTokens: 50 } },
  ] }]);
  assert.deepEqual(second.cursor, { read: { calls: 3, steps: 6 } });
  const again = readAntigravityUsage(second.cursor, [state(false), part('calls', [], { from: 3, end: 3 }), part('steps', [], { from: 6 })], 'fallback');
  assert.deepEqual([again.turns, again.cursor], [[], second.cursor], 'a read with nothing new counts nothing');
});

test('a prompt ends the Antigravity turn before it, a row that cannot be read is passed over, and a turn never said to end counts after a quiet half hour', () => {
  const first = readAntigravityUsage(undefined, [
    state(true),
    part('calls', [
      callLine(0, { step: 0, input: 10, output: 1 }),
      JSON.stringify({ g: 1, d: '00FF' }),
      callLine(2, { step: 2, model: 'gemini-4-hydrogen', input: 30, output: 3, writeMs: 4000 }),
    ], { end: 3 }),
    part('steps', [stepLine(0, PROMPT, '2026-11-17T12:00:00.000Z'), stepLine(1, RESPONSE, '2026-11-17T12:00:02.000Z'), stepLine(2, PROMPT, '2026-11-17T12:10:00.000Z'), stepLine(3, RESPONSE, '2026-11-17T12:10:01.000Z')]),
  ], 'gemini-4-carbon', Date.parse('2026-11-17T12:10:06Z'));
  assert.deepEqual(first.turns, [{ startedAt: '2026-11-17T12:00:00.000Z', durationMs: 2000, models: [{ model: 'gemini-4-carbon', usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 } }] }], 'a call that names no model is under the conversation\'s');
  assert.deepEqual(first.cursor.read, { calls: 3, steps: 4 });
  assert.equal(first.cursor.open?.startedAt, '2026-11-17T12:10:00.000Z');
  // The CLI was killed during the turn: Antigravity still says it runs.
  const empty = [state(true), part('calls', [], { from: 3, end: 3 }), part('steps', [], { from: 4 })];
  assert.deepEqual(readAntigravityUsage(first.cursor, empty, 'x', Date.parse('2026-11-17T12:39:00Z')).turns, []);
  assert.deepEqual(readAntigravityUsage(first.cursor, empty, 'x', Date.parse('2026-11-17T12:41:00Z')).turns, [
    { startedAt: '2026-11-17T12:10:00.000Z', durationMs: 5000, models: [{ model: 'gemini-4-hydrogen', usage: { inputTokens: 30, outputTokens: 3, totalTokens: 33 } }] },
  ]);
});

test('Antigravity calls read in parts: their steps follow them, and nothing ends while more calls wait', () => {
  const steps = [
    stepLine(0, PROMPT, '2026-11-17T12:00:00.000Z'), stepLine(1, RESPONSE, '2026-11-17T12:00:01.000Z'),
    stepLine(2, PROMPT, '2026-11-17T12:05:00.000Z'), stepLine(3, RESPONSE, '2026-11-17T12:05:01.000Z'),
  ];
  const first = readAntigravityUsage(undefined, [state(false), part('calls', [callLine(0, { step: 0, input: 10, output: 1 })], { end: 1, capped: true }), part('steps', steps)], 'm');
  assert.deepEqual([first.turns, first.cursor.read], [[], { calls: 1, steps: 2 }], 'the next prompt waits for the calls before it');
  const second = readAntigravityUsage(first.cursor, [state(false), part('calls', [callLine(1, { step: 2, input: 20, output: 2, writeMs: 2000 })], { from: 1, end: 2 }), part('steps', steps.slice(2), { from: 2 })], 'm');
  assert.deepEqual(second.turns.map(turn => [turn.startedAt, turn.durationMs, turn.models[0].usage.inputTokens]), [['2026-11-17T12:00:00.000Z', 1000, 10], ['2026-11-17T12:05:00.000Z', 3000, 20]]);
  assert.deepEqual(second.cursor, { read: { calls: 2, steps: 4 } });
});

/** This machine as a remote one, at a home of its own. */
async function home(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-agy-usage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  class LocalTransport extends OpenSshTransport {
    constructor() { super('ssh://test.invalid'); }
    protected override spawnRemote(command: string): ChildProcessWithoutNullStreams {
      return spawn('/bin/sh', ['-c', command], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, SHELL: '/bin/sh', HOME: root } });
    }
  }
  return { root, remote: new TuiRemote(new LocalTransport() as SshTransport) };
}
/** Antigravity's databases for one conversation, in WAL mode as Antigravity keeps them. */
async function store(root: string) {
  const dir = join(root, '.gemini/antigravity-cli'), path = join(dir, 'conversations', `${CONVERSATION}.db`);
  await mkdir(join(dir, 'conversations'), { recursive: true });
  const summaries = new DatabaseSync(join(dir, 'conversation_summaries.db'));
  summaries.exec("PRAGMA journal_mode=WAL; CREATE TABLE conversation_summaries (conversation_id text, title text NOT NULL DEFAULT '', status text NOT NULL DEFAULT '', not_fully_idle numeric NOT NULL DEFAULT false, PRIMARY KEY (conversation_id))");
  summaries.prepare('INSERT INTO conversation_summaries (conversation_id, status, not_fully_idle) VALUES (?, ?, ?)').run(CONVERSATION, 'CASCADE_RUN_STATUS_IDLE', 0);
  summaries.close();
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE steps (idx integer, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0, metadata blob, step_payload blob, PRIMARY KEY (idx)); CREATE TABLE gen_metadata (idx integer, data blob, size integer NOT NULL DEFAULT 0, PRIMARY KEY (idx))');
  const step = db.prepare('INSERT INTO steps (idx, step_type, status, metadata, step_payload) VALUES (?, ?, 3, ?, ?)');
  step.run(0, PROMPT, stepRow('2026-11-17T11:45:01.804Z'), Buffer.from('a prompt worth keeping private'));
  step.run(1, RESPONSE, stepRow('2026-11-17T11:45:01.904Z'), Buffer.alloc(4000));
  step.run(2, TOOL, stepRow('2026-11-17T11:46:44.000Z'), Buffer.alloc(9000));
  step.run(3, RESPONSE, stepRow('2026-11-17T11:46:45.000Z'), Buffer.alloc(4000));
  const call = db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)');
  call.run(0, callRow({ step: 0, model: 'gemini-4-carbon', input: 12663, output: 591, thinking: 446, waitMs: 96_703, writeMs: 7_262 }));
  call.run(1, callRow({ step: 2, model: 'gemini-4-carbon', input: 2000, output: 300, cached: 12000, waitMs: 3000, writeMs: 1000 }));
  return { path, db };
}
const expected = [{ startedAt: '2026-11-17T11:45:01.804Z', durationMs: 107_196, models: [{ model: 'gemini-4-carbon', usage: { inputTokens: 14663, outputTokens: 891, reasoningTokens: 446, totalTokens: 27554, cacheReadTokens: 12000 } }] }];
async function readAll(remote: TuiRemote, cap?: number) {
  let cursor: TuiUsageCursor | undefined, more = true, rounds = 0, bytes = 0;
  const turns = [];
  while (more && rounds++ < 10) {
    const output = (await remote.tuiUsageLines([{ cli: 'antigravity', id: CONVERSATION, read: cursor?.read ?? {} }], undefined, cap)).toString();
    bytes += output.length;
    const read = tuiUsageChunks(output), result = readAntigravityUsage(cursor, read.entries.get(0) ?? [], 'x');
    cursor = result.cursor; turns.push(...result.turns); more = read.more;
  }
  return { cursor, turns, rounds, bytes };
}

test('an Antigravity conversation\'s database is read on the real shell, open in Antigravity or closed, whole or in parts', async t => {
  const { root, remote } = await home(t), { path, db } = await store(root);
  assert.ok(existsSync(`${path}-shm`), 'open, it has the shared memory file a read-only connection uses');
  const open = await readAll(remote);
  assert.deepEqual([open.turns, open.cursor, open.rounds], [expected, { read: { calls: 2, steps: 4 } }, 1]);
  const raw = (await remote.tuiUsageLines([{ cli: 'antigravity', id: CONVERSATION, read: {} }])).toString();
  assert.ok(!raw.includes(Buffer.from('worth keeping').toString('hex').toUpperCase()), 'what the steps say is not fetched');
  db.close();
  assert.ok(!existsSync(`${path}-shm`), 'closed, it has none');
  const closed = await readAll(remote);
  assert.deepEqual([closed.turns, closed.cursor], [expected, { read: { calls: 2, steps: 4 } }]);
  const parts = await readAll(remote, 4096);
  assert.deepEqual([parts.turns, parts.rounds], [expected, 2], 'one call per read');
  const none = await remote.tuiUsageLines([{ cli: 'antigravity', id: '0f8c2a51-0000-4c3d-8e9f-1a2b3c4d5e6f', read: {} }, { cli: 'antigravity', id: '$(touch x)', read: {} }]);
  assert.equal(tuiUsageChunks(none.toString()).entries.size, 0, 'a conversation that is not there, or an odd ID, reads nothing');
});

test('without the sqlite3 command, Python reads Antigravity\'s databases the same way, open or closed', async t => {
  let python = true;
  try { execFileSync('python3', ['-c', 'import sqlite3'], { stdio: 'ignore' }); } catch { python = false; }
  if (!python) { t.skip('python3 with sqlite3 is not installed'); return; }
  const { root } = await home(t), { path, db } = await store(root), query = 'select count(*) || \' calls\' from gen_metadata';
  const run = (still: string) => execFileSync('python3', ['-c', ANTIGRAVITY_SQL_PYTHON, path, still, query, 'select step_type from steps where idx = 0'], { encoding: 'utf8' });
  assert.equal(run(''), '2 calls\n14\n');
  db.close();
  assert.equal(run('1'), '2 calls\n14\n');
});
