import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { JSDOM } from 'jsdom';
import { installPendingStatus, PENDING_STATUS_DELAY_MS } from '../src/client/terminal-pending.js';

let dispose = () => {};
beforeEach(() => {
  const { window } = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: window.document });
});
afterEach(() => { dispose(); dispose = () => {}; delete (globalThis as Record<string, unknown>).document; });

/** DSH's sidebar terminal as its `TerminalBody` renders it: an optional status row, then the screen. */
const terminal = (status?: string) => {
  const root = document.createElement('section');
  root.setAttribute('data-sidebar-terminal', '');
  root.innerHTML = `${status === undefined ? '' : `<div role="status">${status}</div>`}<div class="screen"><div class="xterm"><div class="xterm-rows"><div><span class="xterm-cursor"> </span></div></div></div></div>`;
  document.body.append(root);
  return { row: root.querySelector('[role="status"]'), cursor: root.querySelector('.xterm-cursor')! };
};
const rules = () => [...(document.querySelector<HTMLStyleElement>('style[data-remote-terminal-pending]')!.sheet!.cssRules as unknown as { selectorText?: string; cssText: string }[])];
/** The rule that hides something for good, and the one that only delays it. */
const selectors = () => {
  const styled = rules().filter(rule => rule.selectorText !== undefined);
  return { delayed: styled.find(rule => rule.cssText.includes('animation'))!.selectorText!, hidden: styled.find(rule => !rule.cssText.includes('animation'))!.selectorText! };
};

test('a passing state is delayed, and one the user can act on is not', () => {
  dispose = installPendingStatus();
  const { delayed, hidden } = selectors();
  const connecting = terminal('正在连接…'), running = terminal();
  const disconnected = terminal('连接已断开。<button type="button">重新连接</button>'), exited = terminal('进程已退出（0）<button type="button">新建终端</button>');
  assert.equal(connecting.row!.matches(delayed), true);
  assert.equal(connecting.cursor.matches(hidden), true);
  for (const shown of [disconnected, exited]) {
    assert.equal(shown.row!.matches(delayed), false);
    assert.equal(shown.cursor.matches(hidden), false);
  }
  assert.equal(running.cursor.matches(hidden), false);
  assert.match(rules().find(rule => rule.cssText.includes('animation') && rule.selectorText !== undefined)!.cssText, new RegExp(`${PENDING_STATUS_DELAY_MS}ms`));
});

test('no selector nests :has(), which a browser drops whole', () => {
  dispose = installPendingStatus();
  for (const { selectorText } of rules()) {
    if (selectorText === undefined) continue;
    const inside: number[] = []; let depth = 0;
    for (let at = 0; at < selectorText.length; at++) {
      if (selectorText.startsWith(':has(', at)) { assert.equal(inside.length, 0, selectorText); inside.push(depth); }
      if (selectorText[at] === '(') depth++;
      if (selectorText[at] === ')') { depth--; if (inside.at(-1) === depth) inside.pop(); }
    }
  }
});

test('removing it leaves the page as it was', () => {
  const remove = installPendingStatus();
  assert.equal(document.querySelectorAll('style').length, 1);
  remove();
  assert.equal(document.querySelectorAll('style').length, 0);
});
