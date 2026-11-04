import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyTimeline, mergeTimeline, timelineRows } from '../src/client/sessions/timeline.js';
import type { TimelineEntry, TimelinePage } from '../src/core/domain.js';

const entry = (seq: number, item: TimelineEntry['item']): TimelineEntry => ({ seqStart: seq, seqEnd: seq, timestamp: '', item });
const page = (entries: TimelineEntry[], more: Partial<TimelinePage> = {}): TimelinePage => ({ epoch: 'one', entries, startCursor: entries.length ? { epoch: 'one', seq: entries[0].seqStart } : null, endCursor: entries.length ? { epoch: 'one', seq: entries.at(-1)!.seqEnd } : null, hasOlder: false, hasNewer: false, reset: false, staleCursor: false, gap: false, ...more });

test('older history and overlapping live pages preserve cursor position without duplicate output', () => {
  let state = mergeTimeline(emptyTimeline(), page([entry(3, { type: 'assistant_message', text: 'Three' })], { hasOlder: true }));
  state = mergeTimeline(state, page([entry(1, { type: 'user_message', text: 'One' }), entry(2, { type: 'assistant_message', text: 'Two' })]), true);
  assert.equal(state.endCursor?.seq, 3); assert.equal(state.hasOlder, false);
  state = mergeTimeline(state, page([entry(3, { type: 'assistant_message', text: 'Three' }), entry(4, { type: 'reasoning', text: 'Four' })]));
  assert.deepEqual(state.entries.map(e => e.seqStart), [1, 2, 3, 4]);
  state = mergeTimeline(state, page([], { epoch: 'two', reset: true }));
  assert.deepEqual(state.entries, []); assert.equal(state.endCursor, null);
});

test('tool updates coalesce only within their turn and text chunks stay in conversational order', () => {
  const rows = timelineRows([
    entry(1, { type: 'assistant_message', text: 'Hello ' }), entry(2, { type: 'delivery' }), entry(3, { type: 'assistant_message', text: 'world' }),
    entry(4, { type: 'tool_call', callId: 'same', name: 'Bash', status: 'running' }), entry(5, { type: 'tool_call', callId: 'same', name: 'Bash', status: 'completed', detail: 'First result' }),
    entry(6, { type: 'turn_end' }), entry(7, { type: 'user_message', text: 'Again' }),
    entry(8, { type: 'tool_call', callId: 'same', name: 'Bash', status: 'running' }), entry(9, { type: 'assistant_message', text: 'Next reply' }),
  ]);
  assert.equal(rows[0].text, 'Hello world');
  const calls = rows.filter(r => r.kind === 'tool_call');
  assert.equal(calls.length, 2); assert.equal(calls[0].detail, 'First result'); assert.equal(calls[1].status, 'running');
  assert.equal(rows.at(-1)?.text, 'Next reply');
});

test('only a native delivery receipt clears an unconfirmed message in history', () => {
  const sent = entry(1, { type: 'user_message', text: 'Run once', clientMessageId: 'message-1', delivery: 'pending' });
  assert.equal(timelineRows([sent])[0].status, 'unconfirmed');
  assert.equal(timelineRows([sent, entry(2, { type: 'delivery', clientMessageId: 'another-message' })])[0].status, 'unconfirmed');
  assert.equal(timelineRows([sent, entry(2, { type: 'delivery', clientMessageId: 'message-1' })])[0].status, undefined);
});

test('a turn the CLI started itself is headed by the notice it got, even an empty one', () => {
  const rows = timelineRows([
    entry(1, { type: 'user_message', text: 'Build it', clientMessageId: 'm-1' }), entry(2, { type: 'assistant_message', text: 'Done' }), entry(3, { type: 'turn_end', clientMessageId: 'm-1' }),
    entry(4, { type: 'user_message', text: 'Background command "Run Codex" completed (exit code 0)', clientMessageId: 'cli-1', unprompted: true }), entry(5, { type: 'assistant_message', text: 'Checking' }),
    entry(6, { type: 'turn_end', clientMessageId: 'cli-1' }), entry(7, { type: 'user_message', text: '', clientMessageId: 'cli-2', unprompted: true }), entry(8, { type: 'assistant_message', text: 'Again' }),
  ]);
  assert.deepEqual(rows.map(r => [r.kind, r.text]), [['user_message', 'Build it'], ['assistant_message', 'Done'], ['unprompted', 'Background command "Run Codex" completed (exit code 0)'], ['assistant_message', 'Checking'], ['unprompted', ''], ['assistant_message', 'Again']]);
});

test('a model switch is its own row between the replies around it', () => {
  const rows = timelineRows([
    entry(1, { type: 'assistant_message', text: 'Looking' }),
    entry(2, { type: 'model_switch', from: 'claude-fable-5-1', to: 'claude-opus-4-8', category: 'cyber' }),
    entry(3, { type: 'assistant_message', text: 'Retried' }),
    entry(4, { type: 'model_switch', from: 'claude-opus-4-8', to: 'claude-sonnet-5-5' }),
  ]);
  assert.deepEqual(rows.map(r => r.kind), ['assistant_message', 'model_switch', 'assistant_message', 'model_switch']);
  assert.deepEqual(rows[1].switched, { from: 'claude-fable-5-1', to: 'claude-opus-4-8', category: 'cyber' });
  assert.deepEqual(rows[3].switched, { from: 'claude-opus-4-8', to: 'claude-sonnet-5-5' });
});
