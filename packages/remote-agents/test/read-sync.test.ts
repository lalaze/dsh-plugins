import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ReadSync, type ReadSyncPage } from '../src/client/sessions/read-sync.js';

function rig() {
  const state = {
    main: undefined as { id: string; running: boolean } | undefined, running: [] as string[], unread: [] as string[],
    attending: true, visible: true, marks: {} as Record<string, string>, told: [] as string[], cleared: [] as string[], asked: 0,
  };
  const page: ReadSyncPage = {
    main: () => state.main, running: () => state.running, unread: () => state.unread, attending: () => state.attending, visible: () => state.visible,
    markRead: async id => { state.told.push(id); },
    marks: async ids => { state.asked++; return Object.fromEntries(ids.flatMap(id => state.marks[id] ? [[id, state.marks[id]]] : [])); },
    clear: ids => { state.cleared.push(...ids); state.unread = state.unread.filter(id => !ids.includes(id)); },
  };
  return { state, sync: new ReadSync(page) };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

test('a conversation counts as read only while it is on screen in a window in use, and once per finished turn', async t => {
  const { state, sync } = rig();
  t.after(() => sync.close());
  sync.check();
  assert.deepEqual(state.told, [], 'nothing on screen');

  state.main = { id: 'a', running: false };
  state.attending = false;
  sync.check();
  assert.deepEqual(state.told, [], 'the window is not in use: a turn ending behind it stays new for the phone');
  state.attending = true;
  sync.check();
  assert.deepEqual(state.told, ['a'], 'coming back to the window reads it');
  sync.check();
  assert.deepEqual(state.told, ['a'], 'once');

  state.main = { id: 'a', running: true };
  sync.check();
  assert.deepEqual(state.told, ['a'], 'not while it runs');
  state.main = { id: 'a', running: false };
  sync.check();
  assert.deepEqual(state.told, ['a', 'a'], 'the end of a turn on screen reads it again');

  state.main = { id: 'b', running: false };
  sync.check();
  assert.deepEqual(state.told, ['a', 'a', 'b'], 'opening another conversation');
});

test('a session read elsewhere stops showing as finished, but not by a read from before its turn', async t => {
  const { state, sync } = rig();
  t.after(() => sync.close());
  // Read earlier on the phone, then a DSH model's turn: the shared history did not change, so the mark still covers it.
  state.marks = { native: 'task:5' };
  state.running = ['native'];
  sync.check();
  await settle();
  state.running = [];
  state.unread = ['native'];
  sync.check();
  await settle();
  assert.deepEqual(state.cleared, [], 'that read says nothing about the turn');
  state.marks = { native: 'task:6' };
  await new Promise(resolve => setTimeout(resolve, 5100));
  assert.deepEqual(state.cleared, ['native'], 'a later read does, and the page keeps asking while it is unread');

  const again = rig();
  t.after(() => again.sync.close());
  // A CLI's turn: the history grew, so at its start the mark does not cover it. It shows here after the phone read it.
  again.state.running = ['cli'];
  again.sync.check();
  await settle();
  again.state.running = [];
  again.state.marks = { cli: 'task:9' };
  again.state.unread = ['cli', 'other'];
  again.sync.check();
  await settle();
  assert.deepEqual(again.state.cleared, ['cli']);
  assert.deepEqual(again.state.unread, ['other'], 'one nobody has read stays');
});

test('nothing is asked while nothing is unread or the window is hidden', async t => {
  const { state, sync } = rig();
  t.after(() => sync.close());
  sync.check();
  await settle();
  assert.equal(state.asked, 0);
  state.visible = false;
  state.unread = ['a'];
  sync.check();
  await settle();
  assert.equal(state.asked, 0, 'hidden');
  state.visible = true;
  state.marks = { a: 'task:1' };
  sync.check();
  await settle();
  assert.deepEqual(state.cleared, ['a'], 'asked as soon as it shows');
});

test('a closed sync stops', async () => {
  const { state, sync } = rig();
  state.unread = ['a'];
  state.marks = { a: 'task:1' };
  sync.check();
  sync.close();
  await settle();
  assert.deepEqual(state.cleared, []);
});
