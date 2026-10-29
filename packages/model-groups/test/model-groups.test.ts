import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { JSDOM } from 'jsdom';
import { installModelGroups } from '../src/client/model-groups.js';

const globals = ['window', 'document', 'localStorage', 'MutationObserver', 'Event', 'StorageEvent', 'Element', 'HTMLElement', 'HTMLButtonElement', 'HTMLInputElement'] as const;
let dispose = () => {};

beforeEach(() => {
  const { window } = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
  for (const name of globals) Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? window : window[name] });
});
afterEach(() => {
  dispose();
  for (const name of globals) delete (globalThis as Record<string, unknown>)[name];
});

/** A DSH MenuGroup: heading, then rows whose labels are either id-tagged spans or bare text. */
const group = (name: string, rows: readonly [label: string, checked: boolean, ids?: [provider: string, model: string]][]) => `
  <section role="group" data-menu-group=""><span data-menu-group-start=""></span><div data-menu-group-heading="">${name}</div>${rows.map(([label, checked, ids]) =>
    `<button type="button" role="menuitemradio" aria-checked="${checked}">${ids ? `<span data-provider-id="${ids[0]}" data-model-id="${ids[1]}">${label}</span>` : label}</button>`).join('')}
  </section>`;
const surface = (list: string) => `<div data-menu-material="translucent">${list}</div>`;
const groupNamed = (name: string) => [...document.querySelectorAll<HTMLElement>('[data-menu-group]')].find(element => element.textContent?.includes(name))!;
const hidden = (element: HTMLElement) => [...element.querySelectorAll('button')].map(row => row.hasAttribute('data-model-group-hidden'));
/** Scroll events the window sees in capture, as the Codex menu's placement listener does. */
const scrolls = () => { const seen: EventTarget[] = []; window.addEventListener('scroll', event => seen.push(event.target!), true); return seen; };

test('folds the Codex subscription menu, whose rows carry no provider ids', () => {
  document.body.innerHTML = surface(`<div class="codexModelSelectGroups scrollable" role="menu">${
    group('OpenAI Codex', [['GPT-5', true], ['GPT-5 mini', false]])}${group('DeepSeek', [['DeepSeek chat', false]])}</div>`);
  const placements = scrolls();
  dispose = installModelGroups();
  const codex = groupNamed('OpenAI Codex'), deepseek = groupNamed('DeepSeek');
  assert.equal(codex.dataset.modelGroup, 'name:OpenAI Codex');
  assert.equal(deepseek.dataset.modelGroup, 'name:DeepSeek');
  assert.deepEqual(hidden(codex), [false, false], 'the group holding the selection opens');
  assert.deepEqual(hidden(deepseek), [true], 'other groups start folded');
  assert.deepEqual(placements, [document.querySelector('.codexModelSelectGroups')], 'folding asks the menu to place itself again');
  const heading = deepseek.querySelector<HTMLElement>('[data-menu-group-heading]')!;
  assert.equal(heading.getAttribute('role'), 'button');
  heading.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.deepEqual(hidden(deepseek), [false]);
  assert.equal(placements.length, 2);
});

test('keeps keying native rows by provider id', () => {
  document.body.innerHTML = surface(`<div id="r1-models" role="menu">${group('Codex', [['Codex model', false, ['remote-cli-codex', 'm']]])}</div>`);
  const placements = scrolls();
  dispose = installModelGroups();
  assert.equal(groupNamed('Codex').dataset.modelGroup, 'remote-cli-codex');
  assert.deepEqual(hidden(groupNamed('Codex')), [true]);
  assert.deepEqual(placements, [], 'the native menu measures itself');
});

test('leaves other radio menus with group headings alone', () => {
  document.body.innerHTML = surface(`<div class="codexModelSelectMenu" role="menu">${group('Speed', [['Standard', true], ['Fast', false]])}</div>`);
  dispose = installModelGroups();
  const speed = groupNamed('Speed');
  assert.equal(speed.dataset.modelGroup, undefined);
  assert.equal(speed.querySelector('[data-menu-group-heading]')!.hasAttribute('role'), false);
  assert.deepEqual(hidden(speed), [false, false]);
});

test('folding keeps the native menu where DSH placed it, by its right and bottom edges', () => {
  document.body.innerHTML = surface(`<div id="r1-models" role="menu">${group('Magpie', [['A very long model name', false, ['magpie', 'a']], ['B', false, ['magpie', 'b']]])}${group('Qwen', [['Qwen', true, ['qwen', 'q']]])}</div>`);
  Object.assign(window, { innerWidth: 1000, innerHeight: 800 });
  const menu = document.querySelector<HTMLElement>('[data-menu-material]')!;
  // DSH placed it at its open size: wide and tall with every row shown. Folding Magpie narrows and shortens it.
  const shown = () => menu.querySelectorAll('button:not([data-model-group-hidden])').length;
  Object.defineProperty(menu, 'offsetWidth', { get: () => shown() === 3 ? 320 : 240 });
  Object.defineProperty(menu, 'offsetHeight', { get: () => 40 * shown() + 60 });
  menu.style.left = '280px'; menu.style.top = '400px';
  dispose = installModelGroups();
  assert.deepEqual(hidden(groupNamed('Magpie')), [true, true]);
  assert.equal(menu.style.left, `${280 + 320 - 240}px`);
  assert.equal(menu.style.top, `${400 + 180 - 100}px`);

  const measuring = document.createElement('div');
  measuring.innerHTML = surface(`<div id="r2-models" role="menu">${group('Magpie', [['A', false, ['magpie', 'a']]])}</div>`);
  const hiddenMenu = measuring.firstElementChild as HTMLElement;
  hiddenMenu.setAttribute('style', 'visibility: hidden; left: 0px; top: 0px');
  document.body.append(hiddenMenu);
  dispose(); dispose = installModelGroups();
  assert.equal(hiddenMenu.style.left, '0px', 'a menu DSH is still measuring is left to DSH');
});

test('stands down while an older dsh-remote-agents folds the groups itself, and takes over once it unloads', () => {
  document.body.innerHTML = surface(`<div id="r1-models" role="menu">${group('Codex', [['Codex model', false, ['remote-cli-codex', 'm']]])}</div>`);
  const legacy = document.createElement('style'); legacy.dataset.remoteModelGroups = ''; document.head.append(legacy);
  dispose = installModelGroups();
  assert.equal(groupNamed('Codex').dataset.modelGroup, undefined);
  assert.equal(document.querySelector('style[data-model-groups]'), null);
  legacy.remove();
  return Promise.resolve().then(() => {
    assert.equal(groupNamed('Codex').dataset.modelGroup, 'remote-cli-codex');
    document.head.append(legacy);
  }).then(() => {
    assert.equal(groupNamed('Codex').dataset.modelGroup, undefined, 'a legacy plugin loading later takes over again');
    assert.equal(document.querySelector('style[data-model-groups]'), null);
  });
});
