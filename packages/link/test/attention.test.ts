import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { AttentionTracker, type AttentionFrame } from '../src/attention.js';
import { AttentionBoard, SELF, serveEvents } from '../src/attention-board.js';

const event = (type: string, data: unknown, time = 1) => ({ type, data, time });

test('approvals, questions and turns become frames; a snapshot holds what still waits and runs', () => {
  const tracker = new AttentionTracker(session => session.id === 's1' ? 'Fix the build' : undefined);
  const frames: AttentionFrame[] = [];
  tracker.subscribe(frame => frames.push(frame));
  tracker.observe({ id: 's1' }, event('turn/start', { turn: 3 }));
  tracker.observe({ id: 's1' }, event('approval/asked', { id: 'a1', toolName: 'bash', reason: 'rm -rf build' }));
  tracker.observe({ id: 's1' }, event('tool/call', { name: 'ask_user_question', callId: 'q1', arguments: JSON.stringify({ questions: [{ question: 'Which branch?' }] }) }));
  let snapshot = tracker.snapshot();
  assert.deepEqual(snapshot.waiting.map(frame => [frame.kind, frame.key, frame.detail, frame.title]), [['approval', 'a1', 'rm -rf build', 'Fix the build'], ['question', 'q1', 'Which branch?', 'Fix the build']]);
  assert.deepEqual(snapshot.running.map(frame => frame.key), ['turn:3']);
  tracker.observe({ id: 's1' }, event('approval/decided', { id: 'a1', outcome: 'allowed-once' }));
  // A timed question's pending result keeps it open; the user's reply settles it.
  tracker.observe({ id: 's1' }, event('tool/result', { message: { toolCallId: 'q1', content: [{ type: 'text', text: '{"status":"pending"}' }] } }));
  assert.equal(tracker.snapshot().waiting.length, 1);
  tracker.observe({ id: 's1' }, event('user/message', { source: { kind: 'user-question-reply', callId: 'q1' } }));
  tracker.observe({ id: 's1' }, event('turn/end', { turn: 3, reason: { kind: 'completed' } }));
  snapshot = tracker.snapshot();
  assert.deepEqual([snapshot.waiting.length, snapshot.running.length], [0, 0]);
  assert.deepEqual(frames.map(frame => frame.kind), ['running', 'approval', 'question', 'resolved', 'resolved', 'idle', 'done']);
});

test('a stop is not news; a failure is', () => {
  const tracker = new AttentionTracker();
  const frames: AttentionFrame[] = [];
  tracker.subscribe(frame => frames.push(frame));
  tracker.observe({ id: 's' }, event('turn/start', { turn: 1 }));
  tracker.observe({ id: 's' }, event('turn/end', { turn: 1, reason: { kind: 'interrupted' } }));
  tracker.observe({ id: 's' }, event('turn/start', { turn: 2 }));
  tracker.observe({ id: 's' }, event('turn/end', { turn: 2, reason: { kind: 'error', error: { message: 'rate limited' } } }));
  assert.deepEqual(frames.map(frame => [frame.kind, frame.detail]), [['running', ''], ['idle', ''], ['running', ''], ['idle', ''], ['failed', 'rate limited']]);
});

test('a title lookup that throws loses no event', () => {
  const tracker = new AttentionTracker(() => { throw new TypeError('not a session'); });
  tracker.observe({ id: 's' }, event('approval/asked', { id: 'a', toolName: 'bash' }));
  assert.equal(tracker.snapshot().waiting.length, 1);
});

test('a forgotten session resolves its waits and stops running', () => {
  const tracker = new AttentionTracker();
  const kinds: string[] = [];
  tracker.subscribe(frame => kinds.push(frame.kind));
  tracker.observe({ id: 's' }, event('turn/start', { turn: 1 }));
  tracker.observe({ id: 's' }, event('approval/asked', { id: 'a', toolName: 'bash' }));
  tracker.forget('s');
  assert.deepEqual(kinds, ['running', 'approval', 'resolved', 'idle']);
  assert.deepEqual(tracker.snapshot().waiting, []);
});

async function waitFor(check: () => boolean, ms = 3_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test('the board follows another machine\'s stream, keeps finished turns until seen, and forgets waits when it drops', async () => {
  const peer = new AttentionTracker();
  peer.observe({ id: 'p1' }, event('approval/asked', { id: 'old', toolName: 'bash' }));
  const server = http.createServer((_req, res) => serveEvents(peer, res));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const own = new AttentionTracker();
  const board = new AttentionBoard(own);
  try {
    board.follow({ m1: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
    await waitFor(() => board.state().m1?.connected === true);
    assert.deepEqual(board.state().m1!.waiting.map(frame => frame.key), ['old']);
    peer.observe({ id: 'p1' }, event('approval/decided', { id: 'old' }));
    peer.observe({ id: 'p2' }, event('turn/start', { turn: 1 }));
    await waitFor(() => board.state().m1!.waiting.length === 0 && board.state().m1!.running.length === 1);
    peer.observe({ id: 'p2' }, event('turn/end', { turn: 1, reason: { kind: 'completed' } }));
    await waitFor(() => board.state().m1!.finished.length === 1 && board.state().m1!.running.length === 0);
    board.seen('m1');
    assert.equal(board.state().m1!.finished.length, 0);
    own.observe({ id: 'o' }, event('approval/asked', { id: 'mine', toolName: 'bash' }));
    assert.deepEqual(board.state()[SELF]!.waiting.map(frame => frame.key), ['mine']);
    peer.observe({ id: 'p3' }, event('approval/asked', { id: 'new', toolName: 'bash' }));
    await waitFor(() => board.state().m1!.waiting.length === 1);
    server.close();
    server.closeAllConnections();
    await waitFor(() => board.state().m1!.connected === false);
    assert.equal(board.state().m1!.waiting.length, 0);
    board.follow({});
    assert.equal(board.state().m1, undefined);
  } finally {
    board.close();
    server.closeAllConnections();
    server.close();
  }
});
