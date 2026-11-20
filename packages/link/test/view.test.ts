import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AttentionFrame } from '../src/attention.js';
import type { MachineAttention } from '../src/attention-board.js';
import { noteOf } from '../src/client/view.js';

const frame = (kind: AttentionFrame['kind'], sessionId: string): AttentionFrame => ({ id: 1, kind, sessionId, title: '', key: 'turn:1', detail: '', time: 1 });
const attention = (change: Partial<MachineAttention>): MachineAttention => ({ connected: true, waiting: [], finished: [], running: [], ...change });

test("a machine's menu note keeps finished turns while others run there, in the badge's tone", () => {
  const online = { state: 'online' as const };
  assert.deepEqual(noteOf(online, attention({ running: ['a', 'b'], finished: [frame('done', 'c')] }), false),
    [{ text: '2 running' }, { text: '1 finished', tone: 'done' }]);
  assert.deepEqual(noteOf(undefined, attention({ waiting: [frame('approval', 'a')], running: ['a'], finished: [frame('done', 'b')] }), true),
    [{ text: 'This computer' }, { text: '1 waiting', tone: 'waiting' }, { text: '1 running' }, { text: '1 finished', tone: 'done' }]);
  assert.deepEqual(noteOf(online, attention({}), false), []);
  assert.deepEqual(noteOf({ state: 'offline' }, attention({ finished: [frame('done', 'a')] }), false), [{ text: 'Offline' }]);
});
