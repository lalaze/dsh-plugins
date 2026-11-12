import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { TaskCard } from '../src/client/board.js';
import type { State } from '../src/service.js';

type TaskView = State['tasks'][number];
let root: Root | undefined, container: HTMLElement;
const globals = ['window', 'document', 'navigator', 'MutationObserver', 'Node', 'Element', 'HTMLElement', 'Event'] as const;
beforeEach(() => {
  const { window } = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/', pretendToBeVisual: true });
  for (const name of globals) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === 'window' ? window : (window as unknown as Record<string, unknown>)[name] });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.append(container);
});
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined;
  for (const name of globals) delete (globalThis as Record<string, unknown>)[name];
});

const routes = [{ id: 'web', name: 'Web', accept: 'merge' as const }];
const view = (change: Partial<TaskView>): TaskView => ({
  key: 'manual:1', item: { source: 'manual', id: '1', ref: 'M1', title: '日期选择器无法滚动', body: '', labels: [] }, routeId: 'web', baseBranch: 'main', branch: 'manual/1',
  worktree: '/w/manual-1', workspacePath: '/w/manual-1', sessionId: 's1', commit: 'c0ffee0123456', status: 'review', attempts: 1, startedAt: 1, updatedAt: 1,
  events: [{ at: 1, said: { key: 'Committed {commit}; waiting for you', values: { commit: 'c0ffee012' } } }], running: false, sourceName: 'Manual', ...change,
});
const buttons = () => [...container.querySelectorAll('button')].map(button => button.textContent);
const press = (label: string) => act(async () => { [...container.querySelectorAll('button')].find(button => button.textContent === label)!.click(); });
async function show(task: TaskView, acted: string[], keep = true) {
  const { createRoot } = await import('react-dom/client');
  root ??= createRoot(container);
  await act(async () => root!.render(<TaskCard task={task} routes={routes} busy={false} keep={keep} act={async action => { acted.push(action); return true; }} />));
}

test('the card a fix was accepted on asks before its workspace is removed, and removes nothing by itself', async () => {
  const acted: string[] = [];
  await show(view({}), acted);
  await press('Accept'); await press('Yes, accept');
  assert.deepEqual(acted, ['accept']);
  // The merge is under way: nothing is asked yet.
  await show(view({ status: 'accepting', running: true }), acted);
  assert.equal(container.textContent!.includes('Remove this fix'), false);
  await show(view({ status: 'done', mergeCommit: 'abc1234567890' }), acted);
  assert.match(container.textContent!, /Merged into main as abc123456/);
  assert.match(container.textContent!, /Remove this fix's workspace\? Its worktree is deleted and its conversation archived\. Branch manual\/1 is deleted too, as it is merged\./);
  assert.deepEqual(buttons(), ['Yes, remove it', 'Keep it']);
  assert.deepEqual(acted, ['accept'], 'asking is not removing');

  await press('Keep it');
  assert.deepEqual(buttons(), ['Remove workspace'], 'it can still be removed later');
  assert.deepEqual(acted, ['accept']);
  await press('Remove workspace'); await press('Yes, remove it');
  assert.deepEqual(acted, ['accept', 'removeWorkspace']);

  // While it is being removed the card says so; afterwards there is nothing left to remove.
  await show(view({ status: 'done', mergeCommit: 'abc1234567890', running: true, events: [{ at: 2, said: { key: 'Removing the workspace' } }] }), acted);
  assert.match(container.textContent!, /Removing the workspace/);
  assert.deepEqual(buttons(), ['Stop']);
  await show(view({ status: 'done', mergeCommit: 'abc1234567890', worktree: undefined, workspacePath: undefined, sessionId: undefined }), acted);
  assert.match(container.textContent!, /workspace removed/);
  assert.deepEqual(buttons(), []);
});

test('a finished fix seen later offers the removal with the same question; a pushed branch is said to stay', async () => {
  const acted: string[] = [];
  await show(view({ status: 'done' }), acted, false);
  assert.equal(container.textContent!.includes('Remove this fix'), false, 'a card that did not accept the fix does not ask by itself');
  assert.deepEqual(buttons(), ['Remove workspace', 'Remove']);
  await press('Remove workspace');
  assert.match(container.textContent!, /Branch manual\/1 stays\./);
  assert.deepEqual(acted, []);
  // A fix that still waits for its person keeps its workspace.
  await show(view({}), acted, false);
  assert.equal(buttons().includes('Remove workspace'), false);
});
