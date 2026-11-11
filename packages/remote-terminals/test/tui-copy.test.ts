import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clipboardRequest, holdMouseModesDuringDrag, writeClipboard } from '../src/client/tui-copy.js';
import type { Xterm } from '../src/client/tui-render.js';

const encode = (text: string) => Buffer.from(text, 'utf8').toString('base64');

test('a copy request gives its text, in any language', () => {
  assert.equal(clipboardRequest(`c;${encode('read -rs "p?新密码: "; echo\nunset p')}`), 'read -rs "p?新密码: "; echo\nunset p');
  assert.equal(clipboardRequest(`;${encode('no clipboard named')}`), 'no clipboard named');
  assert.equal(clipboardRequest(`pc;${encode('among others')}`), 'among others');
});

test('a request to read the clipboard is not one to write it', () => {
  assert.equal(clipboardRequest('c;?'), undefined);
});

test('other clipboards, empty requests and damaged data change nothing', () => {
  assert.equal(clipboardRequest(`p;${encode('primary selection')}`), undefined);
  assert.equal(clipboardRequest('c;'), undefined);
  assert.equal(clipboardRequest('c'), undefined);
  assert.equal(clipboardRequest('c;not base64!'), undefined);
  // Valid base64 of bytes that are not text.
  assert.equal(clipboardRequest(`c;${Buffer.from([0xff, 0xfe, 0x41]).toString('base64')}`), undefined);
});

test('the clipboard API is used where there is one', async () => {
  const written: string[] = [];
  const result = await writeClipboard('text', { writeText: async text => { written.push(text); } }, () => assert.fail('the old way is not needed'));
  assert.equal(result, true);
  assert.deepEqual(written, ['text']);
});

test('a refusal, or no clipboard API at all, falls back to the old way and reports what it did', async () => {
  const refused = { writeText: () => Promise.reject(new Error('NotAllowedError')) };
  const tried: string[] = [];
  assert.equal(await writeClipboard('a', refused, text => { tried.push(text); return true; }), true);
  assert.equal(await writeClipboard('b', refused, text => { tried.push(text); return false; }), false);
  assert.equal(await writeClipboard('c', undefined, text => { tried.push(text); return true; }), true);
  assert.deepEqual(tried, ['a', 'b', 'c']);
});

/** A terminal with its CSI handler and events within reach. */
function dragRig(mode = 'any') {
  const listeners = new Map<string, () => void>();
  const target = (prefix: string) => ({
    addEventListener: (name: string, listener: () => void) => { listeners.set(prefix + name, listener); },
    removeEventListener: (name: string) => { listeners.delete(prefix + name); },
  });
  let handler: ((params: Array<number | number[]>) => boolean) | undefined;
  const xterm = {
    element: target('terminal:'),
    modes: { mouseTrackingMode: mode },
    parser: { registerCsiHandler: (_id: unknown, given: typeof handler) => { handler = given; return { dispose() { handler = undefined; } }; } },
  } as unknown as Xterm;
  const active = holdMouseModesDuringDrag(xterm, target('page:') as unknown as EventTarget);
  return { xterm, active, listeners, repeat: (...params: Array<number | number[]>) => handler?.(params), press: () => listeners.get('terminal:mousedown')?.(), release: () => listeners.get('page:mouseup')?.() };
}

test('mouse modes repeated during a drag leave the drag alone, and only then', () => {
  const { repeat, press, release } = dragRig();
  assert.equal(repeat(1000), false);
  press();
  assert.equal(repeat(1000), true);
  assert.equal(repeat(1002), true);
  assert.equal(repeat(1003), true);
  release();
  assert.equal(repeat(1003), false);
});

test('other modes pass during a drag, also when sent together with mouse modes', () => {
  const { repeat, press } = dragRig();
  press();
  assert.equal(repeat(25), false);
  assert.equal(repeat(1006), false);
  assert.equal(repeat(1000, 25), false);
  assert.equal(repeat([1000]), false);
});

test('a program turning the mouse on for the first time is never held back', () => {
  const { repeat, press } = dragRig('none');
  press();
  assert.equal(repeat(1003), false);
});

test('ending it takes its listeners along', () => {
  const { active, listeners, repeat } = dragRig();
  assert.equal(listeners.size, 2);
  active.dispose();
  assert.equal(listeners.size, 0);
  assert.equal(repeat(1000), undefined);
});
