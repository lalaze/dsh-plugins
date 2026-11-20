import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { offerTuiPrompt } from '@dsh-plugins/remote-core/client/tui-prompt.js';
import type { Change, Goal, StatusAnswer } from '../src/domain.js';
import { tidy } from '../src/status-file.js';
import { VIEW_ID, apply } from '../src/client/index.js';
import { TYPING_MS } from '../src/client/field.js';
import { resetStatus } from '../src/client/status.js';

const globals = ['window', 'document', 'navigator', 'localStorage', 'fetch', 'HTMLElement', 'Node', 'NodeFilter', 'MutationObserver'] as const;
const FILE = '/home/me/.dsh/storages/dsh-project-status/projects/shop-1a2b3c4d.md';
const STEPS = '- [x] Design\n- [ ] Build';
const goal = (title: string, rest: Partial<Goal> = {}): Goal => ({ title, done: false, steps: '', progress: '', blockers: '', next: '', ...rest });
let root: Root | undefined, container: HTMLElement, requests: Record<string, any>[], copied: string[];
/** The status as the simulated host has it. `remote` is a workspace on another machine. */
let saved: { aim: string; goals: Goal[]; revision: number; remote: boolean; down: boolean };
const answer = (): StatusAnswer => ({
  project: { id: 'shop-1a2b3c4d', name: 'shop', root: '/work/shop', git: true, ...(saved.remote ? { machine: 'box' } : {}) },
  aim: saved.aim, goals: saved.goals, more: false, revision: `r${saved.revision}`, updatedAt: Date.now() - 3 * 86_400_000, ...(saved.remote ? {} : { file: FILE }),
  facts: { branch: 'feat/pay', dirty: 3, unpushed: 2, worktrees: 1, stashes: 0, lastCommit: Date.now() - 2 * 3_600_000 }, conversations: { count: 4, lastActive: Date.now() - 600_000 },
});

/** The simulated host makes a change the way the real one does; false is a conflict. */
function host(change: Change): boolean {
  const swap = (has: string, value: string, was: string) => has === tidy(was) || has === tidy(value) ? tidy(value) : undefined;
  saved.revision++;
  if (change.op === 'aim') { const next = swap(saved.aim, change.value, change.was); if (next === undefined) return false; saved.aim = next; return true; }
  if (change.op === 'add') { if (!saved.goals.some(item => item.title === change.title)) saved.goals = [...saved.goals, goal(change.title)]; return true; }
  const at = saved.goals.map((item, index) => item.title === change.goal.title ? index : -1).filter(index => index >= 0)[change.goal.nth ?? 0] ?? -1;
  if (change.op === 'remove') { saved.goals = saved.goals.filter((_, index) => index !== at); return true; }
  if (at < 0) return false;
  const patch = (next: Partial<Goal>) => { saved.goals = saved.goals.map((item, index) => index === at ? { ...item, ...next } : item); return true; };
  if (change.op === 'done') return patch({ done: change.value });
  if (change.op === 'title') return patch({ title: change.value });
  const next = swap(saved.goals[at][change.part], change.value, change.was);
  return next === undefined ? false : patch({ [change.part]: next });
}

beforeEach(() => {
  const { window } = new JSDOM('<!doctype html><body><div data-conversation-tabs><button role="tab"><span>Chat</span></button><button role="tab"><span>Status</span></button><button role="tab"><span>状态</span></button></div></body>', { url: 'http://localhost/', pretendToBeVisual: true });
  requests = []; copied = [];
  saved = { aim: 'Bookkeeping without thinking', goals: [goal('Payment page', { steps: STEPS, next: 'Run the regression' }), goal('Icons', { done: true, progress: 'Shipped in 1.0.15' })], revision: 1, remote: false, down: false };
  const fetch = async (_url: string, init: { body: string; headers: Record<string, string> }) => {
    assert.equal(init.headers['X-DSH-Project-Status'], '1');
    const body = JSON.parse(init.body);
    requests.push(body);
    if (saved.down) return Response.json({ error: 'The status could not be read' }, { status: 500 });
    if (body.action === 'change' && !host(body.change as Change)) return Response.json({ error: 'The status changed while you were editing' }, { status: 409 });
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
type Target = string | HTMLElement;
const nodeOf = (target: Target) => typeof target === 'string' ? field<HTMLElement>(target) : target;
/** Types into a text or a line, as a person would: focus first, then the text. */
const type = (target: Target, value: string) => act(async () => {
  const node = nodeOf(target) as HTMLTextAreaElement | HTMLInputElement;
  node.focus();
  Object.getOwnPropertyDescriptor(node instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype, 'value')!.set!.call(node, value);
  node.dispatchEvent(new window.Event('input', { bubbles: true }));
});
const leave = async (target: Target) => { await act(async () => { nodeOf(target).blur(); }); await settle(); };
const press = async (target: Target, key: string) => { await act(async () => { nodeOf(target).dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); }); await settle(); };
const labelled = (label: string) => [...container.querySelectorAll<HTMLElement>(`[aria-label="${label}"]`)];
const press1 = (node: HTMLElement) => act(async () => { node.click(); });
/** A goal as the simulated host has it now. */
const now = (title: string): Goal => saved.goals.find(item => item.title === title)!;
const changes = () => requests.filter(request => request.action === 'change').map(request => request.change as Change);
const card = (title: string) => [...container.querySelectorAll<HTMLElement>('.ps-card')].find(node => node.querySelector('.ps-card-title')?.textContent === title)!;
const inCard = <T extends HTMLElement = HTMLTextAreaElement>(title: string, label: string) => card(title).querySelector<T>(`[aria-label="${label}"]`)!;
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
  // The project's aim, then one card per goal with how many are reached.
  assert.equal(field('Overall goal').value, 'Bookkeeping without thinking');
  assert.equal(container.querySelector('.ps-section')!.textContent, 'Goals1/2');
  assert.deepEqual(texts('.ps-card-title'), ['Payment page', 'Icons']);
  // A goal under way is open: its to-dos with their count, and its own three texts, each saying what belongs there.
  assert.deepEqual([card('Payment page').dataset.open, card('Payment page').querySelector('.ps-goal-count')!.textContent], ['', '1/2']);
  assert.deepEqual([...card('Payment page').querySelectorAll('.ps-goal-text')].map(node => node.textContent), ['Design', 'Build']);
  assert.deepEqual([...card('Payment page').querySelectorAll('textarea')].map(area => [area.getAttribute('aria-label'), area.value, !!area.placeholder]), [['Progress', '', true], ['Blockers', '', true], ['Next', 'Run the regression', true]]);
  // One that is reached is closed to a line that says where it stands.
  assert.deepEqual([card('Icons').dataset.open, card('Icons').dataset.done, card('Icons').querySelector('.ps-card-line')!.textContent, card('Icons').querySelector('textarea')], [undefined, '', 'ProgressShipped in 1.0.15', null]);
  assert.equal(button('Edit'), undefined);
  assert.match(container.querySelector('.ps-foot')!.textContent!, /shop-1a2b3c4d\.md/);
});

test('in Chinese the view and its texts for agents are Chinese', async () => {
  const { spec } = await mount('s1', { language: 'zh' });
  assert.equal(spec.label(), '状态');
  assert.deepEqual([texts('.ps-field h3'), texts('.ps-section'), texts('.ps-part-name')], [['大目标'], ['小目标1/2'], ['待办', '进度', '卡点', '下一步']]);
  await click('复制给 AGENTS.md 的规则');
  await settle();
  assert.match(copied[0], /^## 项目状态\n\n本项目的状态记录在 `\/home\/me\/.dsh\/storages\/dsh-project-status\/projects\/shop-1a2b3c4d\.md`/);
  assert.match(copied[0], /只更新你在做的那个小目标/);
  assert.equal(container.querySelector('.ps-said')!.textContent, '已复制');
});

test('a text is edited where it stands and saved by itself: on leaving it, or a moment after the typing stops', async () => {
  await mount('s1');
  const blockers = inCard('Payment page', 'Blockers');
  await type(blockers, 'Waiting for me to approve the copy');
  assert.deepEqual(changes(), []);
  await leave(blockers);
  assert.deepEqual(requests.at(-1), { action: 'change', sessionId: 's1', change: { op: 'part', goal: { title: 'Payment page', nth: 0 }, part: 'blockers', value: 'Waiting for me to approve the copy', was: '' }, language: 'en' });
  assert.equal(inCard('Payment page', 'Blockers').value, 'Waiting for me to approve the copy');
  assert.equal(card('Payment page').querySelector('[data-part=blockers] .ps-state')!.textContent, 'Saved');
  assert.equal(card('Payment page').dataset.blocked, '');
  // Still in the text: it goes out after a pause, and stays as typed.
  const progress = inCard('Payment page', 'Progress');
  await type(progress, 'Checkout works on feat/pay\n');
  await act(async () => { await new Promise(resolve => setTimeout(resolve, TYPING_MS + 150)); });
  await settle();
  assert.deepEqual([changes().at(-1), now('Payment page').progress], [{ op: 'part', goal: { title: 'Payment page', nth: 0 }, part: 'progress', value: 'Checkout works on feat/pay\n', was: '' }, 'Checkout works on feat/pay']);
  assert.equal(progress.value, 'Checkout works on feat/pay\n');
  // Leaving it again has nothing more to save.
  const count = changes().length;
  await leave(progress);
  assert.deepEqual([changes().length, progress.value], [count, 'Checkout works on feat/pay']);
  // The project's aim is a text like the others.
  await type('Overall goal', 'Bookkeeping in ten seconds');
  await leave('Overall goal');
  assert.deepEqual([changes().at(-1), saved.aim], [{ op: 'aim', value: 'Bookkeeping in ten seconds', was: 'Bookkeeping without thinking' }, 'Bookkeeping in ten seconds']);
});

test('a goal’s to-dos are ticked, added, renamed and removed in its own list', async () => {
  await mount('s1');
  await press1(inCard('Payment page', 'Build'));
  await settle();
  assert.deepEqual(changes().at(-1), { op: 'part', goal: { title: 'Payment page', nth: 0 }, part: 'steps', value: '- [x] Design\n- [x] Build', was: STEPS });
  assert.equal(card('Payment page').querySelector('.ps-goal-count')!.textContent, '2/2');
  const add = inCard<HTMLInputElement>('Payment page', 'Add a to-do');
  await type(add, 'Test');
  await press(add, 'Enter');
  assert.deepEqual([now('Payment page').steps, add.value], ['- [x] Design\n- [x] Build\n- [ ] Test', '']);
  await click('Design');
  await type('Edit', 'Design it');
  await press('Edit', 'Enter');
  assert.equal(now('Payment page').steps, '- [x] Design it\n- [x] Build\n- [ ] Test');
  await press1(card('Payment page').querySelectorAll<HTMLElement>('.ps-goals [aria-label="Delete"]')[1]);
  await settle();
  assert.equal(now('Payment page').steps, '- [x] Design it\n- [ ] Test');
  // The other goal was never touched.
  assert.deepEqual(saved.goals[1], goal('Icons', { done: true, progress: 'Shipped in 1.0.15' }));
});

test('goals are added, ticked off, opened, renamed and removed, each by itself', async () => {
  await mount('s1');
  await type('Add a goal', 'Tell the users');
  await press('Add a goal', 'Enter');
  assert.deepEqual([changes().at(-1), texts('.ps-card-title'), texts('.ps-section')], [{ op: 'add', title: 'Tell the users' }, ['Payment page', 'Icons', 'Tell the users'], ['Goals1/3']]);
  // A new one is open, with nothing written yet.
  assert.deepEqual([...card('Tell the users').querySelectorAll('textarea')].map(area => area.value), ['', '', '']);
  await type(inCard('Tell the users', 'Next'), 'Draft the post');
  await leave(inCard('Tell the users', 'Next'));
  assert.deepEqual([now('Tell the users').next, now('Payment page').next], ['Draft the post', 'Run the regression']);
  // Reached: it closes to its line, and the count goes up.
  await press1(inCard('Tell the users', 'Tell the users is reached'));
  await settle();
  assert.deepEqual([now('Tell the users').done, card('Tell the users').dataset.open, card('Tell the users').querySelector('.ps-card-line')!.textContent, texts('.ps-section')], [true, undefined, 'NextDraft the post', ['Goals2/3']]);
  // A closed one opens at a click on its name, and stays the way the user left it.
  await click('Icons');
  assert.deepEqual([card('Icons').dataset.open, inCard('Icons', 'Progress').value], ['', 'Shipped in 1.0.15']);
  assert.match(window.localStorage.getItem('dsh-project-status.open.shop-1a2b3c4d')!, /Icons/);
  // Open, the name is typed over.
  await click('Icons');
  await type('Rename', 'App icons');
  await press('Rename', 'Enter');
  assert.deepEqual([changes().at(-1), texts('.ps-card-title')], [{ op: 'title', goal: { title: 'Icons', nth: 0 }, value: 'App icons' }, ['Payment page', 'App icons', 'Tell the users']]);
  // One with something written under it goes only at the second click.
  await press1(card('Payment page').querySelector<HTMLElement>('.ps-card-head [aria-label="Delete"]')!);
  assert.equal(saved.goals.length, 3);
  await click('Delete it with what is written under it?');
  await settle();
  assert.deepEqual([changes().at(-1), saved.goals.map(item => item.title)], [{ op: 'remove', goal: { title: 'Payment page', nth: 0 } }, ['App icons', 'Tell the users']]);
});

test('a change from elsewhere to the text being edited is shown beside the user’s, and they choose', async () => {
  await mount('s1');
  const next = () => inCard('Payment page', 'Next'), agent = (patch: Partial<Goal>, title = 'Payment page') => { saved.goals = saved.goals.map(item => item.title === title ? { ...item, ...patch } : item); saved.revision++; };
  await type(next(), 'Mine');
  agent({ next: 'The agent’s' });
  await leave(next());
  assert.equal(card('Payment page').querySelector('[data-part=next] [role=alert] strong')!.textContent, 'This was changed elsewhere while you were editing');
  assert.equal(container.querySelector('.ps-theirs')!.textContent, 'The agent’s');
  assert.deepEqual([next().value, now('Payment page').next], ['Mine', 'The agent’s']);
  await click('Keep mine');
  await settle();
  assert.deepEqual([now('Payment page').next, (changes().at(-1) as { was: string }).was, container.querySelector('[role=alert]')], ['Mine', 'The agent’s', null]);
  // The other way: theirs replaces what was typed.
  await type(next(), 'Mine again');
  agent({ next: 'Theirs again' });
  await leave(next());
  await click('Use the new text');
  assert.deepEqual([next().value, now('Payment page').next, container.querySelector('[role=alert]')], ['Theirs again', 'Theirs again', null]);
  // An agent writing another goal, or another text of this one, is no conflict.
  await type(next(), 'Run it twice');
  agent({ progress: 'The agent is at it' });
  agent({ blockers: 'Waiting for the store' }, 'Icons');
  await leave(next());
  assert.deepEqual([now('Payment page').next, now('Payment page').progress, now('Icons').blockers, container.querySelector('[role=alert]')], ['Run it twice', 'The agent is at it', 'Waiting for the store', null]);
  assert.equal(inCard('Payment page', 'Progress').value, 'The agent is at it');
});

test('asking the agent puts the request into the composer, or at the prompt of a TUI conversation, without sending it', async () => {
  const { drafts, activated, opened } = await mount('s1');
  await click('Ask the agent to update');
  await settle();
  assert.equal(drafts.length, 1);
  // Chat comes forward once the composer has the text.
  assert.deepEqual(opened, ['chat']);
  assert.match(drafts[0], /^Update this project's status file: \/home\/me\/.dsh\/storages\/dsh-project-status\/projects\/shop-1a2b3c4d\.md\n[\s\S]*#### Blockers: [\s\S]*Update only the goal this conversation worked on/);
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
  assert.deepEqual([button('Ask the agent to update')!.disabled, button('Copy the rule for AGENTS.md')!.disabled, inCard('Payment page', 'Next').disabled], [true, true, false]);
  assert.match(container.textContent!, /an agent on box cannot open it/);
});

test('the tab carries a mark while a goal that is not reached has a blocker written down', async () => {
  await mount('s1');
  assert.deepEqual(dots(), []);
  await type(inCard('Payment page', 'Blockers'), 'Waiting for review');
  await leave(inCard('Payment page', 'Blockers'));
  assert.deepEqual(dots(), ['Status']);
  // DSH drawing the tabs again does not lose it.
  await act(async () => { document.querySelector('[data-ps-tab-dot]')!.remove(); await new Promise(resolve => setTimeout(resolve, 0)); });
  assert.deepEqual(dots(), ['Status']);
  // Reached, its blocker no longer counts.
  await press1(inCard('Payment page', 'Payment page is reached'));
  await settle();
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
