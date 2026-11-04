import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RemoteError } from '../src/core/domain.js';
import { TuiSessions } from '../src/workspace/tui.js';
import { fixture } from './fakes.js';

const signal = new AbortController().signal;
async function setup(t: Parameters<typeof fixture>[0], blank: boolean | undefined = true) {
  const f = await fixture(t), events: [string, unknown][] = [], titles: string[] = [];
  const tui = new TuiSessions(f.store, {
    verify: async id => { if (id === 'local') throw new RemoteError('Not a remote workspace', 409); },
    session: id => (id === 'closed' ? undefined : { append: (type, data) => { events.push([type, data]); } }),
    list: async () => (blank === undefined ? [] : [{ sessionId: 'remote', blank }]),
    rename: async (_id, title) => { titles.push(title); },
  });
  return { f, tui, events, titles };
}

test('starting a TUI records it and gives DSH the turn it needs to show the conversation', async t => {
  const { tui, events, titles } = await setup(t);
  await tui.start('remote', signal);
  assert.deepEqual(tui.list(), ['remote']);
  assert.deepEqual(events, [['turn/start', { turn: 1 }], ['turn/end', { turn: 1, reason: { kind: 'completed' } }]]);
  assert.match(titles[0]!, /^Claude TUI \d\d:\d\d$/);
  await tui.start('remote', signal);
  assert.equal(events.length, 2, 'starting it again changes nothing');
});

test('a new DSH session not listed yet can start too', async t => {
  const { tui } = await setup(t, undefined);
  await tui.start('remote', signal);
  assert.deepEqual(tui.list(), ['remote']);
});

test('a TUI starts only in a new, open conversation of a verified remote workspace', async t => {
  const { tui, events } = await setup(t, false);
  await assert.rejects(tui.start('local', signal), /Not a remote workspace/);
  await assert.rejects(tui.start('closed', signal), /not open/);
  await assert.rejects(tui.start('remote', signal), /Only a new conversation/);
  assert.deepEqual(tui.list(), []); assert.deepEqual(events, []);
});
