import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { followNewSessions } from '../src/client/tui-new-sessions.js';

function list(ids: string[] | undefined) {
  const listeners = new Set<() => void>();
  let byId = ids && Object.fromEntries(ids.map(id => [id, {}]));
  return {
    getSnapshot: () => (byId ? { byId } : undefined), subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    set(next: string[]) { byId = Object.fromEntries(next.map(id => [id, {}])); for (const listener of listeners) listener(); },
    listeners,
  };
}

test('a conversation appearing in DSH\'s list makes the page ask which conversations are TUI ones, a few times', t => {
  mock.timers.enable({ apis: ['setTimeout'] }); t.after(() => mock.timers.reset());
  const sessions = list(['old', 'tui']), known = new Set(['tui']);
  let asked = 0;
  const stop = followNewSessions(sessions, id => known.has(id), () => { asked += 1; });
  mock.timers.tick(20_000);
  assert.equal(asked, 0, 'what is listed when the page loads is covered by its first request');
  sessions.set(['old', 'tui']); sessions.set(['tui']);
  mock.timers.tick(20_000);
  assert.equal(asked, 0, 'nor does a conversation going away, or the list being sent again');
  sessions.set(['tui', 'from-another-dsh']);
  mock.timers.tick(999); assert.equal(asked, 0);
  mock.timers.tick(1); assert.equal(asked, 1);
  mock.timers.tick(9000); assert.equal(asked, 3, 'the server records it a moment after DSH lists it');
  sessions.set(['tui', 'from-another-dsh']);
  mock.timers.tick(20_000); assert.equal(asked, 3, 'each conversation once');
  // One the page already knows as a TUI conversation, as the one it has just started itself, needs no asking.
  known.add('started-here'); sessions.set(['tui', 'from-another-dsh', 'started-here']);
  mock.timers.tick(20_000); assert.equal(asked, 3);
  sessions.set(['tui', 'from-another-dsh', 'started-here', 'later']);
  stop();
  mock.timers.tick(20_000);
  assert.equal(asked, 3, 'nothing is asked once the page stops following'); assert.equal(sessions.listeners.size, 0);
});

test('a list that has not loaded yet is waited for', t => {
  mock.timers.enable({ apis: ['setTimeout'] }); t.after(() => mock.timers.reset());
  const sessions = list(undefined);
  let asked = 0;
  const stop = followNewSessions(sessions, () => false, () => { asked += 1; }); t.after(stop);
  sessions.set(['a', 'b']);
  mock.timers.tick(20_000); assert.equal(asked, 0, 'its first content is what the page loaded with');
  sessions.set(['a', 'b', 'c']);
  mock.timers.tick(20_000); assert.equal(asked, 3);
});
