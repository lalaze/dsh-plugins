import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { offerTuiPrompt, tuiPrompt } from '@dsh-plugins/remote-core/client/tui-prompt.js';
import { promptPaste, TuiPrompts } from '../src/client/tui-prompt.js';

afterEach(() => { mock.timers.reset(); delete (globalThis as { window?: unknown }).window; });

test('text waits for its conversation\'s terminal, which takes it once and in order', async () => {
  const prompts = new TuiPrompts();
  let changes = 0;
  prompts.subscribe(() => { changes += 1; });
  assert.equal(prompts.waiting('s'), prompts.waiting('other'), 'nothing waiting is the same object, as React compares them');
  const first = prompts.add('s', 'Redraw these'), second = prompts.add('s', 'and these'), elsewhere = prompts.add('other', 'Where is it used');
  const before = prompts.waiting('s');
  assert.equal(prompts.waiting('s'), before);
  assert.equal(changes, 3);
  assert.deepEqual(prompts.take('s'), ['Redraw these', 'and these']);
  assert.deepEqual([await first, await second], [true, true]);
  assert.deepEqual(prompts.take('s'), [], 'each is handed over once');
  assert.deepEqual(prompts.take('other'), ['Where is it used'], 'each conversation has its own');
  assert.equal(await elsewhere, true);
});

test('text no terminal took in time is withdrawn, and says so', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const prompts = new TuiPrompts(10_000);
  const late = prompts.add('s', 'never typed');
  mock.timers.tick(9_999);
  assert.equal(prompts.waiting('s').length, 1);
  const kept = prompts.add('s', 'typed');
  mock.timers.tick(1);
  assert.equal(await late, false);
  assert.deepEqual(prompts.take('s'), ['typed'], 'a terminal that opens later does not get what was given up on');
  assert.equal(await kept, true);
  mock.timers.tick(20_000);
  assert.deepEqual(prompts.take('s'), []);
});

test('a paste keeps its lines only where the app knows they are a paste; elsewhere it goes on one line, so nothing is sent', () => {
  const text = 'Redraw these images.\n\n- art/a.png\n- art/b.png\n';
  assert.equal(promptPaste(text, true), 'Redraw these images.\n\n- art/a.png\n- art/b.png');
  assert.equal(promptPaste(text, false), 'Redraw these images. - art/a.png - art/b.png');
  assert.equal(promptPaste('one line\r\n', false), 'one line');
});

test('the prompt is offered to other plugins through the page, until it is taken back', () => {
  assert.equal(tuiPrompt(), undefined, 'outside a page there is none');
  (globalThis as { window?: unknown }).window = {};
  assert.equal(tuiPrompt(), undefined);
  const prompt = { has: (id: string) => id === 'tui', paste: async () => true }, newer = { ...prompt };
  const release = offerTuiPrompt(prompt);
  assert.equal(tuiPrompt(), prompt);
  const releaseNewer = offerTuiPrompt(newer);
  release();
  assert.equal(tuiPrompt(), newer, 'a plugin that reloads does not take away the offer of its new copy');
  releaseNewer();
  assert.equal(tuiPrompt(), undefined);
});
