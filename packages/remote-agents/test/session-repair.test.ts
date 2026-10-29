import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { createToolResultMessage, MessageId, ToolCallId } from '@deepseek-ai/dsh-llm';
import { interruptedTurnClosers, KNOWN_SESSION_EVENT_TYPES, Session, SessionId } from '@deepseek-ai/dsh-session';
import { assertReleasedV4Relationships } from '@deepseek-ai/dsh-session-format-v3-to-v4';
import { repairRows, repairStoredSessions, zstdFrames, type Row } from '../src/chat/session-repair.js';

const step = { turn: 1, step: 1 }, id = ToolCallId('remote-1-1-cli'), args = JSON.stringify({ description: 'Codex on Build server:/srv/project' });
const nested = { rootCallId: id, parentCallId: id, subCallId: ToolCallId('remote-1-1-0123456789abcdef01234567'), name: 'Bash', arguments: { command: 'pnpm test' } };
const model = (content: unknown[], messageId: string) => ({ ...step, message: { id: MessageId(messageId), role: 'assistant', source: { kind: 'model', provider: 'remote-cli-codex', model: 'build/codex/gpt' }, content }, stream: [] });

/** A conversation as dsh-remote-agents 0.2.53 stored it: the row's tool/call before the message advertising it. */
function oldConversation(interrupted = false) {
  const session = Session.create(SessionId('session-old'));
  session.append('turn/start', { turn: 1 });
  session.append('user/message', { id: MessageId('u1'), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Run the tests' }] }, { surfaceOp: 'append' });
  session.append('request/header', { header: { config: { provider: 'remote-cli-codex', model: 'build/codex/gpt' } }, reason: 'initial' } as never);
  session.append('step/start', step);
  const call = session.append('tool/call', { ...step, callId: id, name: 'remote_cli', arguments: args }).seq;
  session.append('tool/ptc-dispatch-start', nested);
  (session.append as (type: string, data: unknown) => unknown)('session/title', { title: 'Run the tests', source: { kind: 'user' }, messageSeqs: [] });
  if (interrupted) return session;
  session.append('tool/ptc-dispatch', { ...nested, isError: false, content: [{ type: 'text', text: '42 tests pass' }] });
  session.append('assistant/message', model([{ type: 'tool-call', id, name: 'remote_cli', arguments: args }], `${id}:call`) as never, { surfaceOp: 'append' });
  session.append('tool/result', { ...step, message: createToolResultMessage({ callId: id, content: [{ type: 'text', text: 'Bash {"command":"pnpm test"}\n42 tests pass' }], isError: false }) }, { surfaceOp: 'append', sourceEventSeqs: [call] });
  session.append('assistant/message', model([{ type: 'text', text: 'All done' }], 'm2') as never, { surfaceOp: 'append' });
  session.append('step/end', step);
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  return session;
}
const rowsOf = (session: Session) => JSON.parse(JSON.stringify(session.snapshotEvents())) as Row[];
const validate = (session: Session, events: Row[]) => assertReleasedV4Relationships({ header: session.header, events, inheritedEventCount: 0 } as unknown as Parameters<typeof assertReleasedV4Relationships>[0], KNOWN_SESSION_EVENT_TYPES);

test('a 0.2.53 log becomes one DSH reopens: the advertising message moves ahead of its call', () => {
  const session = oldConversation(), rows = rowsOf(session);
  assert.throws(() => validate(session, rows), /tool\/call remote-1-1-cli has no advertised tool lifecycle/);
  const repaired = repairRows(rows)!;
  validate(session, repaired);
  assert.deepEqual(repaired.map(r => r.type), ['turn/start', 'user/message', 'request/header', 'step/start', 'assistant/message', 'tool/call',
    'tool/ptc-dispatch-start', 'session/title', 'tool/ptc-dispatch', 'tool/result', 'assistant/message', 'step/end', 'turn/end']);
  assert.deepEqual(repaired.map(r => r.seq), repaired.map((_, i) => i));
  const call = repaired.find(r => r.type === 'tool/call')!;
  assert.deepEqual(repaired.find(r => r.type === 'tool/result')!.sourceEventSeqs, [call.seq]);
  const messages = Session.create(session.id, repaired as never, session.header).deriveMessages();
  assert.deepEqual(messages.map(m => m.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.equal(repairRows(repaired), undefined, 'a repaired log needs nothing more');
});

test('a response cut off when DSH quit gets its advertising message, and DSH can close the turn', () => {
  const session = oldConversation(true), rows = rowsOf(session);
  assert.throws(() => validate(session, rows), /has no advertised tool lifecycle/);
  const repaired = repairRows(rows)!;
  validate(session, repaired);
  const message = repaired.find(r => r.type === 'assistant/message')!;
  assert.deepEqual(message.data.message.source, { kind: 'model', provider: 'remote-cli-codex', model: 'build/codex/gpt' });
  assert.deepEqual(message.data.message.content, [{ type: 'tool-call', id, name: 'remote_cli', arguments: args }]);
  // DSH appends these when it reopens a conversation whose last turn never ended.
  const closed = [...repaired, ...interruptedTurnClosers(repaired as never) as unknown as Row[]];
  validate(session, closed);
  assert.deepEqual(Session.create(session.id, closed as never, session.header).deriveMessages().map(m => m.role), ['user', 'assistant', 'tool']);
});

test('logs written in the current order are left alone', () => {
  const session = Session.create(SessionId('session-new'));
  session.append('turn/start', { turn: 1 }); session.append('step/start', step);
  session.append('assistant/message', model([{ type: 'tool-call', id, name: 'remote_cli', arguments: args }], `${id}:call`) as never, { surfaceOp: 'append' });
  const call = session.append('tool/call', { ...step, callId: id, name: 'remote_cli', arguments: args }).seq;
  session.append('tool/result', { ...step, message: createToolResultMessage({ callId: id, content: [{ type: 'text', text: 'done' }], isError: false }) }, { surfaceOp: 'append', sourceEventSeqs: [call] });
  assert.equal(repairRows(rowsOf(session)), undefined);
});

const checksum = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };
/** DSH's JSONL layout: a header frame, then one Zstandard frame per appended batch. */
async function storedLog(t: TestContext, session: Session, cut = [4, 7]) {
  const home = await mkdtemp(join(tmpdir(), 'remote-agents-repair-')); t.after(() => rm(home, { recursive: true, force: true }));
  const dir = join(home, 'sessions', '--srv-project--', session.id), path = join(dir, 'session.v4.jsonl.zstd'), rows = rowsOf(session);
  const header = { type: 'session', version: 4, id: session.id, createdAt: 1, cwd: '/srv/project', isSeeded: false, delegationDepth: 0 };
  const batches = [rows.slice(0, cut[0]), rows.slice(cut[0], cut[1]), rows.slice(cut[1])].filter(b => b.length);
  await mkdir(dir, { recursive: true });
  await writeFile(path, Buffer.concat([JSON.stringify(header) + '\n', ...batches.map(b => b.map(r => JSON.stringify(r) + '\n').join(''))].map(text => zstdCompressSync(text, checksum))));
  return { root: join(home, 'sessions'), state: join(home, 'storages', 'dsh-remote-agents'), path };
}
/** Decode every frame, as DSH's reader does; Node's one-shot decoder stops after the first. */
const decode = (buffer: Buffer) => zstdFrames(buffer)!.frames.flatMap(frame => zstdDecompressSync(frame).toString('utf8').split('\n').filter(Boolean));

test('stored logs are repaired once, keeping the original and the header frame', async t => {
  const session = oldConversation(), { root, state, path } = await storedLog(t, session);
  const original = await readFile(path);
  assert.deepEqual(await repairStoredSessions(root, state), [path]);
  const [header, ...rows] = decode(await readFile(path)).map(line => JSON.parse(line) as Row);
  assert.equal((header as unknown as { id: string }).id, session.id);
  validate(session, rows);
  assert.deepEqual(rows, repairRows(rowsOf(session)));
  assert.deepEqual(await readFile(join(state, 'session-backups', `${session.id}-session.v4.jsonl.zstd`)), original);
  const repaired = await readFile(path);
  assert.deepEqual(await repairStoredSessions(root, state), [], 'later starts skip the scan');
  assert.deepEqual(await readFile(path), repaired);
});

test('a conversation DSH has open is left alone, and the scan runs again next start', async t => {
  const session = oldConversation(), { root, state, path } = await storedLog(t, session), original = await readFile(path);
  assert.deepEqual(await repairStoredSessions(root, state, id => id === session.id), []);
  assert.deepEqual(await readFile(path), original);
  await assert.rejects(stat(join(state, 'session-repair.json')));
  assert.deepEqual(await repairStoredSessions(root, state), [path]);
});

test('a log torn when DSH quit mid-write keeps its complete lines', async t => {
  // The torn final frame holds step/end and turn/end; the advertising message and the result are in complete frames.
  const session = oldConversation(), { root, state, path } = await storedLog(t, session, [4, 11]);
  const raw = await readFile(path), { frames } = zstdFrames(raw)!;
  assert.equal(frames.length, 4, 'a header frame and three batches');
  await writeFile(path, raw.subarray(0, raw.length - 6));
  assert.deepEqual(await repairStoredSessions(root, state), [path]);
  const split = zstdFrames(await readFile(path))!, rows = decode(await readFile(path)).slice(1).map(line => JSON.parse(line) as Row);
  assert.equal(split.torn, undefined);
  validate(session, rows);
  assert.ok(rows.length >= 11 && rows.length < 13, `${rows.length} complete rows`);
  assert.deepEqual(rows.slice(0, 11), repairRows(rowsOf(session))!.slice(0, 11));
});
