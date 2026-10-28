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
const hidden = (element: HTMLElement) => [...element.querySelectorAll('button')].map(row => row.hasAttribute('data-ra-model-hidden'));
/** Scroll events the window sees in capture, as the Codex menu's placement listener does. */
const scrolls = () => { const seen: EventTarget[] = []; window.addEventListener('scroll', event => seen.push(event.target!), true); return seen; };

test('folds the Codex subscription menu, whose rows carry no provider ids', () => {
  document.body.innerHTML = surface(`<div class="codexModelSelectGroups scrollable" role="menu">${
    group('OpenAI Codex', [['GPT-5', true], ['GPT-5 mini', false]])}${group('DeepSeek', [['DeepSeek chat', false]])}</div>`);
  const placements = scrolls();
  dispose = installModelGroups();
  const codex = groupNamed('OpenAI Codex'), deepseek = groupNamed('DeepSeek');
  assert.equal(codex.dataset.raModelProvider, 'name:OpenAI Codex');
  assert.equal(deepseek.dataset.raModelProvider, 'name:DeepSeek');
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
  assert.equal(groupNamed('Codex').dataset.raModelProvider, 'remote-cli-codex');
  assert.deepEqual(hidden(groupNamed('Codex')), [true]);
  assert.deepEqual(placements, [], 'the native menu measures itself');
});

test('leaves other radio menus with group headings alone', () => {
  document.body.innerHTML = surface(`<div class="codexModelSelectMenu" role="menu">${group('Speed', [['Standard', true], ['Fast', false]])}</div>`);
  dispose = installModelGroups();
  const speed = groupNamed('Speed');
  assert.equal(speed.dataset.raModelProvider, undefined);
  assert.equal(speed.querySelector('[data-menu-group-heading]')!.hasAttribute('role'), false);
  assert.deepEqual(hidden(speed), [false, false]);
});
