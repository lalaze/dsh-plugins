import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TuiScrollChoice } from '../src/client/workspace/tui-scroll.js';
import { tuiAction } from '../src/workspace/terminals.js';
import { endHolderScript } from '../src/workspace/holder-protocol.js';
import { TuiSessions } from '../src/workspace/tui.js';
import { fixture } from './fakes.js';

const memory = (value?: string) => {
  const saved = new Map<string, string>(value === undefined ? [] : [['remote-agents.tui.local-scroll', value]]);
  return { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, text: string) => { saved.set(key, text); } };
};
const settled = () => new Promise(resolve => setImmediate(resolve));

test('local scrolling is on until switched off, and the server keeps the choice', async t => {
  const f = await fixture(t);
  const tui = new TuiSessions(f.store, {} as ConstructorParameters<typeof TuiSessions>[1]);
  const signal = new AbortController().signal;
  assert.equal(tui.localScroll(), true);
  assert.deepEqual(await tuiAction(tui, 'tuiSessions', {}, signal), { sessions: [], codex: [], localScroll: true });
  assert.deepEqual(await tuiAction(tui, 'tuiScroll', { local: false }, signal), { localScroll: false });
  assert.equal(f.store.snapshot().tuiLocalScroll, false);
  assert.deepEqual(await tuiAction(tui, 'tuiSessions', {}, signal), { sessions: [], codex: [], localScroll: false });
  await tuiAction(tui, 'tuiScroll', { local: true }, signal);
  assert.equal(tui.localScroll(), true);
  await assert.rejects(tuiAction(tui, 'tuiScroll', { local: 'yes' }, signal), /Invalid scrolling choice/);
});

test('the switch shows the cached choice at once, saves a change, and follows the server', async () => {
  const storage = memory(), saves: boolean[] = [];
  const choice = new TuiScrollChoice(async local => { saves.push(local); }, storage);
  assert.equal(choice.snapshot(), true);
  let changes = 0;
  choice.subscribe(() => { changes += 1; });
  choice.set(false);
  assert.equal(choice.snapshot(), false); assert.deepEqual(saves, [false]); assert.equal(changes, 1);
  choice.set(false);
  assert.deepEqual(saves, [false], 'the same choice again saves nothing');
  assert.equal(new TuiScrollChoice(async () => {}, storage).snapshot(), false, 'remembered for the next page load');
  // Another page switched it back on.
  choice.load(true);
  assert.equal(choice.snapshot(), true); assert.deepEqual(saves, [false], 'what the server said is not sent back to it');
  assert.equal(new TuiScrollChoice(async () => {}, { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } }).snapshot(), true);
});

test('a choice the server did not save goes back', async () => {
  const choice = new TuiScrollChoice(async () => { throw new Error('offline'); }, memory());
  choice.set(false);
  assert.equal(choice.snapshot(), false);
  await settled();
  assert.equal(choice.snapshot(), true);
});

test('a CLI running the other way is the one that has to restart', () => {
  const on = new TuiScrollChoice(async () => {}, memory());
  assert.equal(on.stale('alternate'), true, 'fullscreen Claude Code started before the switch was on');
  assert.equal(on.stale('normal'), false);
  assert.equal(on.stale(undefined), false, 'no terminal yet');
  const off = new TuiScrollChoice(async () => {}, memory('false'));
  assert.equal(off.stale('alternate'), false);
  assert.equal(off.stale('normal'), false, 'a shell, or a CLI still starting, is not worth a notice');
  on.set(false);
  assert.equal(on.stale('normal'), true, 'just switched off under a running classic one');
  assert.equal(on.stale('alternate'), false);
});

test('ending a holder waits for it to be gone, but not for a holder that was not running', () => {
  const script = endHolderScript('tui-abc');
  assert.match(script, /\*\) exit 0 ;;/);
  assert.match(script, /while \[ -d "\$HOME\/[^"]*\/tui-abc" \] && \[ "\$dsh_tries" -lt 50 \]; do sleep 0\.1/);
});
