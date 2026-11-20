import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { offerTuiPrompt } from '@dsh-plugins/remote-core/client/tui-prompt.js';
import type { Fields, StatusAnswer } from '../src/domain.js';
import { VIEW_ID, apply } from '../src/client/index.js';
import { resetStatus } from '../src/client/status.js';

const globals = ['window', 'document', 'navigator', 'fetch', 'HTMLElement', 'Node', 'NodeFilter', 'MutationObserver'] as const;
const FILE = '/home/me/.dsh/storages/dsh-project-status/projects/shop-1a2b3c4d.md';
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
  saved = { fields: { goal: 'Ship the payment page', progress: '', blockers: '', next: 'Run the regression' }, revision: 1, remote: false, down: false };
  const fetch = async (_url: string, init: { body: string; headers: Record<string, string> }) => {
    assert.equal(init.headers['X-DSH-Project-Status'], '1');
    const body = JSON.parse(init.body);
    requests.push(body);
    if (saved.down) return Response.json({ error: 'The status could not be read' }, { status: 500 });
    if (body.action === 'save') {
      if (body.revision !== `r${saved.revision}`) return Response.json({ error: 'The status changed while you were editing' }, { status: 409 });
      saved.fields = body.fields; saved.revision++;
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
const type = (label: string, value: string) => act(async () => {
  const area = container.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${label}"]`)!;
  Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(area, value);
  area.dispatchEvent(new window.Event('input', { bubbles: true }));
});
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
  // A written field shows its text; an empty one says what belongs there.
  assert.deepEqual(texts('.ps-field h3'), ['Goal', 'Progress', 'Blockers', 'Next']);
  assert.deepEqual(texts('.ps-text'), ['Ship the payment page', 'Run the regression']);
  assert.equal(container.querySelectorAll('.ps-empty').length, 2);
  assert.match(container.querySelector('.ps-foot')!.textContent!, /shop-1a2b3c4d\.md/);
});

test('in Chinese the view and its texts for agents are Chinese', async () => {
  const { spec } = await mount('s1', { language: 'zh' });
  assert.equal(spec.label(), '状态');
  assert.deepEqual(texts('.ps-field h3'), ['目标', '进度', '卡点', '下一步']);
  await click('复制给 AGENTS.md 的规则');
  await settle();
  assert.match(copied[0], /^## 项目状态\n\n本项目的状态记录在 `\/home\/me\/.dsh\/storages\/dsh-project-status\/projects\/shop-1a2b3c4d\.md`/);
  assert.equal(container.querySelector('[role=status]')!.textContent, '已复制');
});

test('an edit is saved against the revision it started from, in the page’s language', async () => {
  await mount('s1');
  await click('Edit');
  await type('Blockers', 'Waiting for me to approve the copy');
  await click('Save');
  await settle();
  assert.deepEqual(requests.at(-1), { action: 'save', sessionId: 's1', fields: { goal: 'Ship the payment page', progress: '', blockers: 'Waiting for me to approve the copy', next: 'Run the regression' }, revision: 'r1', language: 'en' });
  assert.equal(container.querySelector('textarea'), null);
  assert.deepEqual(texts('.ps-text'), ['Ship the payment page', 'Waiting for me to approve the copy', 'Run the regression']);
});

test('a change from elsewhere during an edit is announced and the edit kept, until the new status is loaded', async () => {
  await mount('s1');
  await click('Edit');
  await type('Goal', 'Mine');
  saved.fields = { ...saved.fields, goal: 'The agent’s' }; saved.revision++;
  await click('Save');
  await settle();
  assert.equal(container.querySelector('[role=alert] strong')!.textContent, 'The status changed while you were editing');
  assert.equal(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Goal"]')!.value, 'Mine');
  assert.equal(button('Save')!.disabled, true);
  assert.equal(saved.fields.goal, 'The agent’s');
  await click('Load the new status');
  assert.equal(container.querySelector('textarea'), null);
  assert.equal(texts('.ps-text')[0], 'The agent’s');
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
  assert.match(container.querySelector('[role=status]')!.textContent!, /send it when you are ready/);
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
  assert.deepEqual([button('Ask the agent to update')!.disabled, button('Copy the rule for AGENTS.md')!.disabled, button('Edit')!.disabled], [true, true, false]);
  assert.match(container.textContent!, /an agent on box cannot open it/);
});

test('the tab carries a mark while a blocker is written down', async () => {
  await mount('s1');
  assert.deepEqual(dots(), []);
  await click('Edit');
  await type('Blockers', 'Waiting for review');
  await click('Save');
  await settle();
  assert.deepEqual(dots(), ['Status']);
  // DSH drawing the tabs again does not lose it.
  await act(async () => { document.querySelector('[data-ps-tab-dot]')!.remove(); await new Promise(resolve => setTimeout(resolve, 0)); });
  assert.deepEqual(dots(), ['Status']);
  await click('Edit');
  await type('Blockers', '  ');
  await click('Save');
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
