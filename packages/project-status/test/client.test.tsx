import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { offerTuiPrompt } from '@dsh-plugins/remote-core/client/tui-prompt.js';
import type { Field, Fields, StatusAnswer } from '../src/domain.js';
import { tidy } from '../src/status-file.js';
import { VIEW_ID, apply } from '../src/client/index.js';
import { TYPING_MS } from '../src/client/field.js';
import { resetStatus } from '../src/client/status.js';

const globals = ['window', 'document', 'navigator', 'fetch', 'HTMLElement', 'Node', 'NodeFilter', 'MutationObserver'] as const;
const FILE = '/home/me/.dsh/storages/dsh-project-status/projects/shop-1a2b3c4d.md';
const GOALS = '- [ ] Ship the payment page\n  - [x] Design\n  - [ ] Build';
let root: Root | undefined, container: HTMLElement, requests: Record<string, any>[], copied: string[];
/** The status as the simulated host has it. `remote` is a workspace on another machine. */
let saved: { fields: Fields; revision: number; remote: boolean; down: boolean };
const answer = (): StatusAnswer => ({
  project: { id: 'shop-1a2b3c4d', name: 'shop', root: '/work/shop', git: true, ...(saved.remote ? { machine: 'box' } : {}) },
  fields: saved.fields, more: false, revision: `r${saved.revision}`, updatedAt: Date.now() - 3 * 86_400_000, ...(saved.remote ? {} : { file: FILE }),
  facts: { branch: 'feat/pay', dirty: 3, unpushed: 2, worktrees: 1, stashes: 0, lastCommit: Date.now() - 2 * 3_600_000 }, conversations: { count: 4, lastActive: Date.now() - 600_000 },
});

beforeEach(() => {
  const { window } = new JSDOM('<!doctype html><body><div data-conversation-tabs><button role="tab"><span>Chat</span></button><button role="tab"><span>Status</span></button><button role="tab"><span>状态</span></button></div></body>', { url: 'http://localhost/', pretendToBeVisual: true });
  requests = []; copied = [];
  saved = { fields: { goal: GOALS, progress: '', blockers: '', next: 'Run the regression' }, revision: 1, remote: false, down: false };
  const fetch = async (_url: string, init: { body: string; headers: Record<string, string> }) => {
    assert.equal(init.headers['X-DSH-Project-Status'], '1');
    const body = JSON.parse(init.body);
    requests.push(body);
    if (saved.down) return Response.json({ error: 'The status could not be read' }, { status: 500 });
    if (body.action === 'save') {
      const has = saved.fields[body.field as Field];
      if (has !== tidy(body.was) && has !== tidy(body.value)) return Response.json({ error: 'The status changed while you were editing' }, { status: 409 });
      saved.fields = { ...saved.fields, [body.field]: tidy(body.value) }; saved.revision++;
    }
    return Response.json(answer());
  };
  for (const name of globals) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === 'window' ? window : name === 'fetch' ? fetch : (window as unknown as Record<string, unknown>)[name] });
  Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { copied.push(text); } } });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.append(container);
});
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined;
  resetStatus();
  for (const name of globals) delete (globalThis as Record<string, unknown>)[name];
});

const settle = () => act(async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); });
const button = (text: string) => [...container.querySelectorAll('button')].find(node => node.textContent === text);
const click = (text: string) => act(async () => { const node = button(text); assert.ok(node, `button ${text}`); node.click(); });
const field = <T extends HTMLElement = HTMLTextAreaElement>(label: string) => { const node = container.querySelector<T>(`textarea[aria-label="${label}"],input[aria-label="${label}"]`); assert.ok(node, `field ${label}`); return node; };
/** Types into a text field or a line of the goal list, as a person would: focus first, then the text. */
const type = (label: string, value: string) => act(async () => {
  const node = field<HTMLTextAreaElement | HTMLInputElement>(label);
  node.focus();
  Object.getOwnPropertyDescriptor(node instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype, 'value')!.set!.call(node, value);
  node.dispatchEvent(new window.Event('input', { bubbles: true }));
});
const leave = async (label: string) => { await act(async () => { field(label).blur(); }); await settle(); };
const press = async (label: string, key: string) => { await act(async () => { field(label).dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); }); await settle(); };
const labelled = (label: string) => [...container.querySelectorAll<HTMLElement>(`[aria-label="${label}"]`)];
const press1 = (node: HTMLElement) => act(async () => { node.click(); });
/** A field as the simulated host has it now. */
const now = (name: Field): string => saved.fields[name];
const lastSave = () => requests.filter(request => request.action === 'save').at(-1);
const texts = (selector: string) => [...container.querySelectorAll(selector)].map(node => node.textContent);
const dots = () => [...document.querySelectorAll('[data-conversation-tabs] button')].filter(tab => tab.querySelector('[data-ps-tab-dot]')).map(tab => tab.textContent);
const reads = () => requests.filter(request => request.action === 'get').length;

interface Entry { spec: Record<string, any>; component: React.FC<any> }
/** Mounts what the plugin registers the way DSH would: the Status view, and its hidden piece in the composer. */
async function mount(sessionId: string | undefined, { language = 'en', drafts = [] as string[] } = {}) {
  const entries: Entry[] = [], activated: string[] = [], opened: string[] = [];
  const locale = { register: () => () => {}, subscribe: () => () => {}, getSnapshot: () => ({ active: language, revision: 0 }) };
  const services: Record<string, unknown> = { locale, uiConversation: { binding: (id: string) => ({ activate: (view: string) => { activated.push(`${id}:${view}`); } }) } };
  const ctx = {
    get: (name: string) => services[name],
    effect: (factory: () => () => void) => { factory(); },
    inject: (names: string[], factory: (scoped: any) => void) => { if (names.every(name => services[name])) factory(ctx); },
    slots: { inject: (_name: string, factory: () => unknown) => factory(), register: (spec: Record<string, any>, component: React.FC<any>) => { entries.push({ spec, component }); return () => {}; } },
  };
  apply(ctx as never);
  const view = entries.find(entry => entry.spec.name === 'conversation.view')!, composer = entries.find(entry => entry.spec.name === 'conversation.input.left')!;
  const { createRoot } = await import('react-dom/client');
  root = createRoot(container);
  await act(async () => root!.render(<>
    {React.createElement(view.component, { sessionId, openView: (target: string) => { opened.push(target); } })}
    {React.createElement(composer.component, { sessionId, inputActions: { setDraft: (text: string) => { drafts.push(text); } }, useInput: (select: (state: { draft: string }) => unknown) => select({ draft: '' }) })}
  </>));
  await settle();
  return { spec: view.spec, activated, drafts, opened };
}

test('the plugin adds a Status view between Git and Stats that shows the project’s status and what Git says', async () => {
  const { spec } = await mount('s1');
  assert.deepEqual([spec.id, spec.order, spec.label()], [VIEW_ID, 35, 'Status']);
  assert.deepEqual(requests[0], { action: 'get', sessionId: 's1' });
  assert.equal(container.querySelector('.ps-name')!.textContent, 'shop');
  assert.equal(container.querySelector('.ps-updated')!.textContent, 'Updated 3 days ago');
  assert.deepEqual(texts('.ps-fact'), ['Branchfeat/pay', 'Uncommitted3', 'Unpushed2', 'Worktrees1', 'Stashes0', 'Last commit2 hours ago', 'Conversations4 · last active 10 minutes ago']);
  assert.deepEqual([...container.querySelectorAll('.ps-fact[data-tone=warn] dt')].map(node => node.textContent), ['Uncommitted', 'Unpushed']);
  // The goals are a list to tick off, with how many boxes are ticked; the other three are text, each saying what belongs there.
  assert.deepEqual(texts('.ps-field h3'), ['Goal1/3', 'Progress', 'Blockers', 'Next']);
  assert.deepEqual(texts('.ps-goal-text'), ['Ship the payment page', 'Design', 'Build']);
  assert.deepEqual([...container.querySelectorAll<HTMLInputElement>('.ps-goals input[type=checkbox]')].map(box => box.checked), [false, true, false]);
  assert.deepEqual([...container.querySelectorAll<HTMLElement>('.ps-goal')].map(row => row.dataset.depth), ['0', '1', '1', undefined]);
  assert.deepEqual(texts('.ps-goal-count'), ['1/2']);
  assert.deepEqual([...container.querySelectorAll('textarea')].map(area => [area.value, !!area.placeholder]), [['', true], ['', true], ['Run the regression', true]]);
  // Nothing to switch on before editing.
  assert.equal(button('Edit'), undefined);
  assert.match(container.querySelector('.ps-foot')!.textContent!, /shop-1a2b3c4d\.md/);
});

test('in Chinese the view and its texts for agents are Chinese', async () => {
  const { spec } = await mount('s1', { language: 'zh' });
  assert.equal(spec.label(), '状态');
  assert.deepEqual(texts('.ps-field h3'), ['目标1/3', '进度', '卡点', '下一步']);
  await click('复制给 AGENTS.md 的规则');
  await settle();
  assert.match(copied[0], /^## 项目状态\n\n本项目的状态记录在 `\/home\/me\/.dsh\/storages\/dsh-project-status\/projects\/shop-1a2b3c4d\.md`/);
  assert.match(copied[0], /任务列表：`- \[ \] 大目标`/);
  assert.equal(container.querySelector('.ps-said')!.textContent, '已复制');
});

test('a text is edited where it stands and saved by itself: on leaving the field, or a moment after the typing stops', async () => {
  await mount('s1');
  await type('Blockers', 'Waiting for me to approve the copy');
  assert.equal(lastSave(), undefined);
  await leave('Blockers');
  assert.deepEqual(lastSave(), { action: 'save', sessionId: 's1', field: 'blockers', value: 'Waiting for me to approve the copy', was: '', language: 'en' });
  assert.equal(field('Blockers').value, 'Waiting for me to approve the copy');
  assert.equal(container.querySelector('[data-field=blockers] .ps-state')!.textContent, 'Saved');
  // Still in the field: the text goes out after a pause, and stays as typed.
  await type('Progress', 'Checkout works on feat/pay\n');
  await act(async () => { await new Promise(resolve => setTimeout(resolve, TYPING_MS + 150)); });
  await settle();
  assert.deepEqual([lastSave()!.field, lastSave()!.was, saved.fields.progress], ['progress', '', 'Checkout works on feat/pay']);
  assert.equal(field('Progress').value, 'Checkout works on feat/pay\n');
  // Leaving it again has nothing more to save.
  const saves = requests.filter(request => request.action === 'save').length;
  await leave('Progress');
  assert.equal(requests.filter(request => request.action === 'save').length, saves);
  assert.equal(field('Progress').value, 'Checkout works on feat/pay');
});

test('goals are ticked, added, broken into steps, renamed and removed in the list', async () => {
  await mount('s1');
  await press1(labelled('Build')[0]);
  await settle();
  assert.deepEqual(lastSave(), { action: 'save', sessionId: 's1', field: 'goal', value: '- [ ] Ship the payment page\n  - [x] Design\n  - [x] Build', was: GOALS, language: 'en' });
  assert.deepEqual(texts('.ps-goal-count'), ['2/2']);
  await type('Add a goal', 'Tell the users');
  await press('Add a goal', 'Enter');
  assert.equal(now('goal'), '- [ ] Ship the payment page\n  - [x] Design\n  - [x] Build\n- [ ] Tell the users');
  assert.equal(field<HTMLInputElement>('Add a goal').value, '');
  // A step goes under its goal, after the steps already there; Enter goes on to the next one.
  await press1(labelled('Add a step')[0]);
  await type('Add a step', 'Test');
  await press('Add a step', 'Enter');
  assert.equal(now('goal'), '- [ ] Ship the payment page\n  - [x] Design\n  - [x] Build\n  - [ ] Test\n- [ ] Tell the users');
  assert.equal(field<HTMLInputElement>('Add a step').value, '');
  await press('Add a step', 'Escape');
  assert.equal(container.querySelector('input[aria-label="Add a step"]'), null);
  await click('Design');
  await type('Edit', 'Design it');
  await press('Edit', 'Enter');
  assert.match(now('goal'), /\n {2}- \[x\] Design it\n/);
  // A goal with steps under it goes only at the second click.
  await press1(labelled('Delete')[0]);
  assert.equal(now('goal').split('\n').length, 5);
  await click('Delete it with its 3 steps?');
  await settle();
  assert.equal(now('goal'), '- [ ] Tell the users');
  assert.deepEqual(texts('.ps-count'), ['0/1']);
});

test('a sentence someone wrote as the goal is kept as it is, and becomes a to-do at a click', async () => {
  saved.fields.goal = 'Ship the payment page\n- plain bullet';
  await mount('s1');
  assert.deepEqual(texts('.ps-goal-text'), ['Ship the payment page', 'plain bullet']);
  assert.equal(container.querySelectorAll('.ps-goals input[type=checkbox]').length, 1);
  await press1(labelled('Make it a to-do')[0]);
  await settle();
  assert.equal(saved.fields.goal, '- [ ] Ship the payment page\n- [ ] plain bullet');
});

test('a change from elsewhere to the field being edited is shown beside the user’s text, and they choose', async () => {
  await mount('s1');
  await type('Next', 'Mine');
  saved.fields = { ...saved.fields, next: 'The agent’s' }; saved.revision++;
  await leave('Next');
  assert.equal(container.querySelector('[data-field=next] [role=alert] strong')!.textContent, 'This was changed elsewhere while you were editing');
  assert.equal(container.querySelector('.ps-theirs')!.textContent, 'The agent’s');
  assert.deepEqual([field('Next').value, saved.fields.next], ['Mine', 'The agent’s']);
  await click('Keep mine');
  await settle();
  assert.deepEqual([saved.fields.next, lastSave()!.was, container.querySelector('[role=alert]')], ['Mine', 'The agent’s', null]);
  // The other way: theirs replaces what was typed.
  await type('Next', 'Mine again');
  saved.fields = { ...saved.fields, next: 'Theirs again' }; saved.revision++;
  await leave('Next');
  await click('Use the new text');
  assert.deepEqual([field('Next').value, saved.fields.next, container.querySelector('[role=alert]')], ['Theirs again', 'Theirs again', null]);
  // A change to another field is no conflict.
  await type('Next', 'Run it twice');
  saved.fields = { ...saved.fields, progress: 'The agent is at it' }; saved.revision++;
  await leave('Next');
  assert.deepEqual([saved.fields.next, saved.fields.progress, container.querySelector('[role=alert]')], ['Run it twice', 'The agent is at it', null]);
  assert.equal(field('Progress').value, 'The agent is at it');
});

test('asking the agent puts the request into the composer, or at the prompt of a TUI conversation, without sending it', async () => {
  const { drafts, activated, opened } = await mount('s1');
  await click('Ask the agent to update');
  await settle();
  assert.equal(drafts.length, 1);
  // Chat comes forward once the composer has the text.
  assert.deepEqual(opened, ['chat']);
  assert.match(drafts[0], /^Update this project's status file: \/home\/me\/.dsh\/storages\/dsh-project-status\/projects\/shop-1a2b3c4d\.md\n[\s\S]*## Blockers: /);
  assert.deepEqual(activated, ['s1:chat']);
  assert.match(container.querySelector('.ps-said')!.textContent!, /send it when you are ready/);
  const pasted: string[] = [], withdraw = offerTuiPrompt({ has: id => id === 's1', paste: async (_id, text) => { pasted.push(text); return true; } });
  try {
    await click('Ask the agent to update');
    await settle();
    assert.deepEqual([pasted.length, drafts.length, opened], [1, 1, ['chat', 'chat']]);
  } finally { withdraw(); }
});

test('a project on another machine can be edited here, but an agent there is not sent to a file it cannot open', async () => {
  saved.remote = true;
  await mount('s1');
  assert.equal(container.querySelector('.ps-path')!.textContent, '/work/shop · on box');
  assert.deepEqual([button('Ask the agent to update')!.disabled, button('Copy the rule for AGENTS.md')!.disabled, field('Next').disabled], [true, true, false]);
  assert.match(container.textContent!, /an agent on box cannot open it/);
});

test('the tab carries a mark while a blocker is written down', async () => {
  await mount('s1');
  assert.deepEqual(dots(), []);
  await type('Blockers', 'Waiting for review');
  await leave('Blockers');
  assert.deepEqual(dots(), ['Status']);
  // DSH drawing the tabs again does not lose it.
  await act(async () => { document.querySelector('[data-ps-tab-dot]')!.remove(); await new Promise(resolve => setTimeout(resolve, 0)); });
  assert.deepEqual(dots(), ['Status']);
  await type('Blockers', '  ');
  await leave('Blockers');
  assert.deepEqual(dots(), []);
});

test('the view and the mark share one request, and a failure offers another try', async () => {
  saved.down = true;
  await mount('s1');
  assert.equal(reads(), 1);
  assert.equal(container.querySelector('[role=alert]')!.textContent, 'The status could not be read');
  saved.down = false;
  await click('Retry');
  await settle();
  assert.equal(container.querySelector('.ps-name')!.textContent, 'shop');
});

test('without a conversation there is nothing to ask for', async () => {
  await mount(undefined);
  assert.equal(requests.length, 0);
  assert.match(container.textContent!, /Open a conversation/);
});
