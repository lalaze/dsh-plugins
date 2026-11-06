import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { JSDOM } from 'jsdom';
import type { ChatProject } from '../src/core/domain.js';
import { installCustomModelLabels } from '../src/client/composer/custom-model-label.js';

const globals = ['window', 'document', 'MutationObserver', 'Node', 'NodeFilter'] as const;
const catalogs: ChatProject[] = [{ id: 'mini', hostId: 'mini', cwd: '/srv', label: 'macmini', providers: [
  { id: 'claude', label: 'Claude', status: 'ready', modes: [], models: [{ id: 'opus', label: 'Opus 5.5' }, { id: 'auto', label: 'Auto · Fast' }] },
] }];
let dispose = () => {};

beforeEach(() => {
  const { window } = new JSDOM('<!doctype html><body></body>', { url: 'https://dsh.test/' });
  for (const name of globals) Object.defineProperty(globalThis, name, { configurable: true, value: window[name] });
});
afterEach(() => {
  dispose(); dispose = () => {};
  for (const name of globals) delete (globalThis as Record<string, unknown>)[name];
});

const settle = async () => { for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve)); };
const start = async () => { dispose = installCustomModelLabels(async () => catalogs); await settle(); };
const add = (html: string) => { document.body.insertAdjacentHTML('beforeend', html); return document.body.lastElementChild!; };

/** Codex's picker: its caption is plain text and the title is the bare catalog name. */
const custom = (name: string) => add(`<button class="codexModelSelectTrigger" aria-haspopup="menu" title="${name}"><span class="codexModelSelectLabel">${name}</span><span class="codexModelSelectEffort">xhigh</span></button>`);
/** DSH's picker with another plugin owning the label slot, captured from 0.2.2-rc.1 with dsh-connect-workbuddy. */
const native = (name: string, provider = 'remote-cli-claude') => add(`<button aria-haspopup="menu" title="${name} · xhigh"><span class="_trigger"><span data-provider-id="${provider}" data-model-id="m"><span data-slot="conversation.input.model.label" style="display: contents;"><span>${name}</span></span></span></span><span class="_effort">xhigh</span></button>`);

test('a custom picker\'s caption drops the host and keeps its tooltip', async () => {
  const button = custom('Opus 5.5 · macmini');
  await start();
  assert.equal(button.querySelector('.codexModelSelectLabel')!.textContent, 'Opus 5.5');
  assert.equal(button.getAttribute('title'), 'Opus 5.5 · macmini');
});

test('the native trigger drops the host when another plugin\'s label shadows ours', async () => {
  const button = native('Opus 5.5 · macmini');
  const text = button.querySelector('[data-slot] span')!.firstChild;
  await start();
  assert.equal(button.querySelector('[data-provider-id]')!.textContent, 'Opus 5.5');
  assert.equal(button.querySelector('[data-slot] span')!.firstChild, text, 'React keeps its own text node');
  assert.equal(button.getAttribute('title'), 'Opus 5.5 · macmini · xhigh');
});

test('the host is dropped again when the selected model changes, and only once', async () => {
  const button = native('Opus 5.5 · macmini');
  await start();
  const text = button.querySelector('[data-slot] span')!.firstChild as Text;
  button.setAttribute('title', 'Auto · Fast · macmini · xhigh'); text.data = 'Auto · Fast · macmini';
  await settle();
  assert.equal(text.data, 'Auto · Fast');
  text.data = 'Auto · Fast';
  await settle();
  assert.equal(text.data, 'Auto · Fast');
});

test('a picker opened later is shortened too', async () => {
  await start();
  const button = native('Opus 5.5 · macmini');
  await settle();
  assert.equal(button.querySelector('[data-provider-id]')!.textContent, 'Opus 5.5');
});

test('menu rows keep the host that tells saved hosts apart', async () => {
  const row = add('<div role="menu"><button role="menuitemradio"><span data-provider-id="remote-cli-claude" data-model-id="m"><span data-slot="conversation.input.model.label"><span>Opus 5.5 · macmini</span></span></span></button></div>');
  await start();
  assert.equal(row.textContent, 'Opus 5.5 · macmini');
});

test('other providers and unknown names stay as they are', async () => {
  const local = native('Opus 5.5 · macmini', 'mock');
  const unknown = native('Sonnet 5.5 · macmini');
  const other = custom('Other provider · variant');
  await start();
  assert.equal(local.querySelector('[data-provider-id]')!.textContent, 'Opus 5.5 · macmini');
  assert.equal(unknown.querySelector('[data-provider-id]')!.textContent, 'Sonnet 5.5 · macmini');
  assert.equal(other.querySelector('.codexModelSelectLabel')!.textContent, 'Other provider · variant');
});

test('a caption with more than the name is left alone', async () => {
  const button = native('Opus 5.5 · macmini');
  button.querySelector('[data-slot] span')!.insertAdjacentHTML('beforeend', '<span>new</span>');
  await start();
  assert.equal(button.querySelector('[data-provider-id]')!.textContent, 'Opus 5.5 · macmininew');
});

test('unloading restores the names', async () => {
  const nested = native('Opus 5.5 · macmini'), plain = custom('Opus 5.5 · macmini');
  await start();
  dispose(); dispose = () => {};
  assert.equal(nested.querySelector('[data-provider-id]')!.textContent, 'Opus 5.5 · macmini');
  assert.equal(plain.querySelector('.codexModelSelectLabel')!.textContent, 'Opus 5.5 · macmini');
});
