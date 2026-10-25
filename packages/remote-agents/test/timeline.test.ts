import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyTimeline, mergeTimeline, timelineRows } from '../src/client/timeline.js';
import type { TimelineEntry, TimelinePage } from '../src/domain.js';
import { newRequestId } from '../src/client/api.js';
const entry = (seq: number, text: string): TimelineEntry => ({ seqStart: seq, seqEnd: seq, turnId: 'turn-one', timestamp: '2026-10-25T00:00:00Z', item: { type: 'assistant_message', text } });
const page = (entries: TimelineEntry[], extra: Partial<TimelinePage> = {}): TimelinePage => ({ epoch: 'epoch-one', entries, reset: false, staleCursor: false, gap: false, hasOlder: true, hasNewer: false, startCursor: entries.length ? { epoch: 'epoch-one', seq: entries[0].seqStart } : null, endCursor: entries.length ? { epoch: 'epoch-one', seq: entries.at(-1)!.seqEnd } : null, ...extra });
test('browser request IDs work without the secure-context-only randomUUID API', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')!;
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) } });
  try {
    assert.match(newRequestId(), /^[0-9a-f]{32}$/);
    assert.equal(new Set(Array.from({ length: 100 }, newRequestId)).size, 100);
  } finally { Object.defineProperty(globalThis, 'crypto', descriptor); }
});
test('replayed pages deduplicate by sequence and incremental messages concatenate once', () => {
  let state = mergeTimeline(emptyTimeline(), page([entry(2, 'Hello ')]));
  state = mergeTimeline(state, page([entry(2, 'Hello '), entry(3, 'world')]));
  state = mergeTimeline(state, page([]));
  assert.equal(timelineRows(state.entries)[0].text, 'Hello world'); assert.equal(state.endCursor?.seq, 3);
  state = mergeTimeline(state, page([entry(1, 'Earlier. ')], { hasOlder: false }), true);
  assert.equal(state.startCursor?.seq, 1); assert.equal(state.endCursor?.seq, 3); assert.equal(state.hasOlder, false);
});
test('replacement epochs discard old history and tool lifecycle updates reuse one row', () => {
  let state = mergeTimeline(emptyTimeline(), page([entry(1, 'old')]));
  state = mergeTimeline(state, page([entry(5, 'replacement')], { epoch: 'new-epoch', reset: true, startCursor: { epoch: 'new-epoch', seq: 5 }, endCursor: { epoch: 'new-epoch', seq: 5 } }));
  assert.equal(state.entries.length, 1); assert.equal(state.entries[0].item.text, 'replacement');
  const tool = (seq: number, status: string) => ({ ...entry(seq, ''), item: { type: 'tool_call', callId: 'call-1', name: 'Bash', status, detail: { command: 'pnpm test' } } });
  const rows = timelineRows([tool(1, 'running'), tool(2, 'completed')]);
  assert.equal(rows.length, 1); assert.equal(rows[0].status, 'completed');
  state = mergeTimeline(state, page([], { epoch: 'empty-epoch', reset: true }));
  assert.equal(state.startCursor, null); assert.equal(state.endCursor, null);
});
