import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyTimeline, mergeTimeline, timelineRows } from '../src/client/timeline.js';
import type { TimelineEntry, TimelinePage } from '../src/domain.js';

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
