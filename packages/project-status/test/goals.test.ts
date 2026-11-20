import assert from 'node:assert/strict';
import { test } from 'node:test';
import { endOf, parseGoals, serializeGoals, tally } from '../src/goals.js';

test('a task list reads as goals with their steps, and is written back the same', () => {
  const text = '- [ ] Ship the payment page\n  - [x] Design\n  - [ ] Build\n- [x] Tell the users';
  const items = parseGoals(text);
  assert.deepEqual(items, [{ depth: 0, done: false, text: 'Ship the payment page' }, { depth: 1, done: true, text: 'Design' }, { depth: 1, done: false, text: 'Build' }, { depth: 0, done: true, text: 'Tell the users' }]);
  assert.equal(serializeGoals(items), text);
  assert.deepEqual([endOf(items, 0), endOf(items, 1), endOf(items, 3)], [3, 2, 4]);
  assert.deepEqual([tally(items), tally(items, 0), tally(items, 3)], [{ done: 2, total: 4 }, { done: 1, total: 2 }, { done: 0, total: 0 }]);
});

test('what people and agents write by hand is read leniently', () => {
  // Other bullets, numbers, a capital X, tabs and four spaces, blank lines, deeper levels.
  assert.deepEqual(parseGoals('* [X] one\n\n    + [ ] two\n\t\t1. three\n2) four\r\n'),
    [{ depth: 0, done: true, text: 'one' }, { depth: 1, done: false, text: 'two' }, { depth: 2, done: false, text: 'three' }, { depth: 0, done: false, text: 'four' }]);
  // A sentence is a note without a box; indented under an item it stays with that item.
  const items = parseGoals('Ship it this month.\n- [ ] Page\n  with the new copy\nAfter that, rest.');
  assert.deepEqual(items, [{ depth: 0, text: 'Ship it this month.' }, { depth: 0, done: false, text: 'Page' }, { depth: 1, text: 'with the new copy' }, { depth: 0, text: 'After that, rest.' }]);
  assert.equal(serializeGoals(items), 'Ship it this month.\n- [ ] Page\n  with the new copy\nAfter that, rest.');
  assert.deepEqual(parseGoals('  \n'), []);
});
