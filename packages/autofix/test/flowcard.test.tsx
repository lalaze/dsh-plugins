import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { TaskCard } from '../src/client/board.js';
import { ownsRow, TaskFlowCard } from '../src/client/chat.js';
import { followFlowCard, setFlowCard, type CardExtension, type FlowView, type ModelFlowCard, type ViewExtras } from '../src/client/flowcard.js';
import type { State } from '../src/service.js';

type TaskView = State['tasks'][number];
let root: Root | undefined, container: HTMLElement, drawn: (FlowView & ViewExtras)[], served: Record<string, TaskView | null>, asked: Record<string, unknown>[];
const globals = ['window', 'document', 'navigator', 'MutationObserver', 'Node', 'Element', 'HTMLElement', 'Event', 'fetch'] as const;
/** Model flow's card, as far as a test needs to see what it was given. */
const View: ModelFlowCard['View'] = props => {
  drawn.push(props);
  return <div data-view data-status={props.head?.status ?? ''}><div data-caption>{props.caption}</div><b>{props.head?.title}</b><i>{props.head?.detail}</i>
    {props.active && props.stop && <button type="button" onClick={props.stop}>card stop</button>}<div data-report>{props.report}</div><div data-more>{props.children}</div></div>;
};
beforeEach(() => {
  const { window } = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/', pretendToBeVisual: true });
  drawn = []; served = {}; asked = [];
  const fetch = async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { action: string; key: string };
    asked.push(body);
    if (body.action === 'task') return Response.json({ task: served[body.key] ?? null, routes });
    if (body.action === 'stepBody') return Response.json({ body: 'the whole answer' });
    return Response.json({});
  };
  for (const name of globals) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === 'window' ? window : name === 'fetch' ? fetch : (window as unknown as Record<string, unknown>)[name] });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.append(container);
  setFlowCard({ version: 1, View, extend: () => () => undefined });
});
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined;
  setFlowCard(undefined);
  for (const name of globals) delete (globalThis as Record<string, unknown>)[name];
});

const routes = [{ id: 'web', name: 'Web', accept: 'merge' as const }];
const step = (status: string, more: Record<string, unknown> = {}) => ({ role: 'implement' as const, round: 1, model: 'coder', status, childId: 'child-1', ...more });
const passed = { kind: 'passed' as const, round: 1, sentBack: 0, ms: 65_000 };
const view = (change: Partial<TaskView>): TaskView => ({
  key: 'manual:1', item: { source: 'manual', id: '1', ref: 'F1', title: '给导出加 CSV', body: '', labels: [], kind: 'feature' }, routeId: 'web', baseBranch: 'main', branch: 'feat/1',
  worktree: '/w/feat-1', workspacePath: '/w/feat-1', sessionId: 's1', status: 'working', attempts: 1, startedAt: 1, updatedAt: 1,
  flow: { steps: [step('running')], rounds: 3, planned: false, zh: true, startedAt: Date.now() - 4000, carded: true },
  events: [{ at: 1, said: { key: 'Worktree on {branch}', values: { branch: 'feat/1' } } }], running: true, sourceName: 'Manual', ...change,
});
const buttons = () => [...container.querySelectorAll('[data-more] button')].map(button => button.textContent);
const press = (label: string) => act(async () => { [...container.querySelectorAll('button')].find(button => button.textContent === label)!.click(); });
const settle = () => act(async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); });
async function show(task: TaskView, acted: string[], more: { keep?: boolean; at?: string; flow?: FlowView } = { keep: true }) {
  const { createRoot } = await import('react-dom/client');
  root ??= createRoot(container);
  drawn = [];
  await act(async () => root!.render(<TaskCard task={task} routes={routes} busy={false} {...more} act={async action => { acted.push(action); return true; }} />));
  return drawn.at(-1)!;
}

test('a task shows its flow as a /flow does, and what comes after the flow at the end of the same bar', async () => {
  const acted: string[] = [];
  // While the models work: what the flow says about itself, live when this DSH runs it.
  let card = await show(view({ progress: { steps: [step('running', { ms: 9000 })], rounds: 3, planned: false, zh: true, elapsed: 9000, activity: 'reading math.js' } }), acted);
  assert.deepEqual([card.active, card.card.elapsed, card.card.activity, card.card.rounds, card.card.zh, card.card.parentId, card.canOpen, card.head], [true, 9000, 'reading math.js', 3, true, 's1', true, undefined]);
  assert.deepEqual(card.stages, [{ label: 'Checks', status: 'pending' }, { label: 'Acceptance', status: 'pending' }]);
  assert.match(container.querySelector('[data-caption]')!.textContent!, /F1 · 给导出加 CSV.*From \/flow · Web · feat\/1 ← main/);
  assert.deepEqual(buttons(), [], 'the card\'s own Stop is the one way to stop a running flow');
  await press('card stop');
  assert.deepEqual(acted, ['stop']);
  assert.equal(await card.stepBody!(0), 'the whole answer');
  assert.deepEqual(asked.at(-1), { action: 'stepBody', key: 'manual:1', index: 0 });

  // The repository's checks, then the person: each has its place on the bar and the top of the card says where things are.
  const done = { steps: [step('done', { ms: 60_000 })], end: passed, report: '改了 export.js', rounds: 3, planned: false, zh: true, startedAt: 5, carded: true };
  card = await show(view({ status: 'checking', flow: done }), acted);
  assert.deepEqual([card.head, card.stages?.map(stage => stage.status), card.active], [{ status: 'running', title: 'Running checks', detail: 'Review passed in round 1', clock: null }, ['running', 'pending'], false]);
  assert.deepEqual(buttons(), ['Stop']);
  card = await show(view({ status: 'review', running: false, commit: 'c0ffee0123456', flow: done }), acted);
  assert.deepEqual([card.head, card.stages?.map(stage => stage.status), card.report], [{ status: 'passed', title: 'Waiting for you', detail: 'Review passed in round 1 · committed c0ffee012', clock: 65_000 }, ['passed', 'pending'], '改了 export.js']);
  assert.deepEqual(buttons().slice(0, 2), ['Accept', 'Send back']);
  card = await show(view({ status: 'accepting', commit: 'c0ffee0123456', flow: done }), acted);
  assert.deepEqual([card.head?.title, card.stages?.map(stage => stage.status)], ['Merging and pushing', ['passed', 'running']]);
  card = await show(view({ status: 'done', running: false, commit: 'c0ffee0123456', mergeCommit: 'abc1234567890', flow: done }), acted);
  assert.deepEqual([card.head?.status, card.head?.title, card.stages?.map(stage => stage.status), card.report], ['passed', 'Merged into main as abc123456', ['passed', 'passed'], undefined]);
  assert.deepEqual(buttons(), ['Remove workspace']);

  // What went wrong after the flow is said at the top; its output stays below.
  card = await show(view({ status: 'failed', running: false, flow: done, error: { key: 'A check failed', detail: '$ npm test\nexit code 3' }, check: { files: ['a.js'], packages: [], warnings: [], runs: [{ command: 'npm test', code: 3, ms: 900, tail: 'x' }] } }), acted);
  assert.deepEqual([card.head?.status, card.head?.detail, card.stages?.map(stage => stage.status)], ['failed', 'A check failed', ['failed', 'skipped']]);
  assert.match(container.querySelector('[data-more]')!.textContent!, /exit code 3/);
  assert.deepEqual(buttons().slice(0, 2), ['Continue', 'Continue with a note']);
  // A flow that did not pass speaks for itself, and nothing after it happens.
  card = await show(view({ status: 'failed', running: false, flow: { ...done, end: { kind: 'rejected', rounds: 3, ms: 9 } }, error: { key: 'The review gave no verdict twice.' } }), acted);
  assert.deepEqual([card.head, card.stages?.map(stage => stage.status)], [undefined, ['skipped', 'skipped']]);
});

test('a task another DSH runs, one from before flows had cards, and a page without Model flow', async () => {
  const acted: string[] = [];
  const far = await show(view({}), acted, { keep: true, at: '/air/web' });
  assert.deepEqual([far.card.parentId, far.canOpen, far.stepBody, far.card.elapsed], ['', false, undefined, undefined], 'its steps cannot be opened from here, and its clock is another computer\'s');
  // On the board a long report stays folded with the rest.
  const board = await show(view({ status: 'review', running: false, flow: { steps: [], end: passed, report: 'r', rounds: 3 } }), acted, {});
  assert.equal(board.report, undefined);
  assert.ok(container.querySelector('[data-more] details.tp-report'));
  await show(view({ flow: { steps: [], end: passed } }), acted);
  assert.ok(container.querySelector('article.tp-card') && !container.querySelector('[data-view]'), 'a flow kept without what its card needs is drawn plainly');
  setFlowCard(undefined);
  await show(view({}), acted);
  assert.ok(container.querySelector('article.tp-card') && !container.querySelector('[data-view]'));
  assert.match(container.textContent!, /Models are working/);
});

test('in the task\'s own conversation the newest flow\'s card is the task\'s card; an earlier one stays a record', async () => {
  const { createRoot } = await import('react-dom/client');
  root = createRoot(container);
  const flow: FlowView = { card: { parentId: 's1', zh: true, rounds: 3, steps: [step('done')], end: passed, tag: 'autofix:1:manual:1' }, active: false, report: '第一轮的报告' };
  served['manual:1'] = view({ status: 'review', running: false, attempts: 2, commit: 'c0ffee0123456', flow: { steps: [step('done')], end: passed, rounds: 3 } });
  await act(async () => root!.render(<TaskFlowCard tag="autofix:1:manual:1" flow={flow} />)); await settle();
  assert.deepEqual([drawn.at(-1)!.caption, drawn.at(-1)!.stages, drawn.at(-1)!.report, buttons()], [undefined, undefined, '第一轮的报告', []], 'the first flow\'s card, as Model flow draws it');

  await act(async () => root!.render(<TaskFlowCard tag="autofix:2:manual:1" flow={{ ...flow, report: '第二轮的报告' }} />)); await settle();
  const card = drawn.at(-1)!;
  assert.deepEqual([card.head?.title, card.report, card.card.parentId, card.stages?.map(stage => stage.status)], ['Waiting for you', '第二轮的报告', 's1', ['passed', 'pending']], 'the flow as its own card has it, with the task around it');
  assert.deepEqual(buttons().slice(0, 2), ['Accept', 'Send back']);
  await press('Accept'); await press('Yes, accept'); await settle();
  assert.ok(asked.some(body => body.action === 'accept' && body.key === 'manual:1'));
  // A task that is gone leaves the flow's card as it is.
  delete served['manual:1'];
  await act(async () => root!.render(<TaskFlowCard tag="autofix:1:manual:404" flow={flow} />)); await settle();
  assert.deepEqual([drawn.at(-1)!.caption, buttons()], [undefined, []]);
});

test('the plugin stays registered with whatever Model flow\'s page offers, and claims the rows of a /flow that became a task', async () => {
  const extension: CardExtension = { claims: ownsRow };
  const made: string[] = [];
  const offer = (name: string): ModelFlowCard => ({ version: 1, View, extend(prefix, given) { assert.equal(given, extension); made.push(`${name}+${prefix}`); return () => { made.push(`${name}-${prefix}`); }; } });
  let offered: unknown;
  setFlowCard(undefined);
  const stop = followFlowCard(() => offered, extension, 5);
  assert.deepEqual(made, []);
  offered = offer('first');
  await new Promise(resolve => setTimeout(resolve, 30));
  offered = offer('second');
  await new Promise(resolve => setTimeout(resolve, 30));
  offered = { version: 1 };
  await new Promise(resolve => setTimeout(resolve, 30));
  stop();
  assert.deepEqual(made, ['first+autofix', 'first-autofix', 'second+autofix', 'second-autofix'], 'a page that offers no card is no card');
  assert.equal(ownsRow('F3 · add csv\n\n<!-- autofix-row {"key":"manual:3"} -->'), true);
  assert.equal(ownsRow('Done: review passed in round 1\n\n<!-- flow-row {"card":{}} -->'), false);
});
