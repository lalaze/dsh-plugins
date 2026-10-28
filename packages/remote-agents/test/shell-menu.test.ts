import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { JSDOM } from 'jsdom';
import { installShellMenu } from '../src/client/shell-menu.js';

const globals = ['window', 'document', 'MutationObserver', 'HTMLElement', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'] as const;
let dispose = () => {};

beforeEach(() => {
  const { window } = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/', pretendToBeVisual: true });
  Object.assign(window, { innerWidth: 1000, innerHeight: 800 });
  for (const name of globals) Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? window : typeof window[name] === 'function' ? (window[name] as Function).bind(window) : window[name] });
});
afterEach(() => {
  dispose(); dispose = () => {};
  for (const name of globals) delete (globalThis as Record<string, unknown>)[name];
});

const rect = <T extends Element>(element: T, left: number, top: number, width: number, height: number) =>
  Object.assign(element, { getBoundingClientRect: () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top }) });
/** DSH's menu as copied from the app: a portal surface naming its trigger's anchor, with plain menu items. */
const menu = (labels: string[]) => {
  const element = document.createElement('div');
  element.setAttribute('role', 'menu'); element.dataset.menuMaterial = 'translucent';
  element.setAttribute('style', 'left: 120px; top: 355px; --dsh-menu-anchor: --dsh-menu-ri0;');
  element.innerHTML = `<div role="presentation">${labels.map(label => `<div><button type="button" role="menuitem"><span>${label}</span></button></div>`).join('')}</div>`;
  return rect(element, 120, 355, 160, 110);
};
const trigger = (top: number) => {
  const element = document.createElement('button');
  element.setAttribute('style', 'anchor-name: --dsh-menu-ri0'); element.setAttribute('aria-haspopup', 'menu'); element.setAttribute('aria-expanded', 'true');
  document.body.append(element);
  return rect(element, 410, top, 20, 20);
};
const frame = () => new Promise(resolve => requestAnimationFrame(resolve));

test('the shell menu opens below its chevron, and other menus keep DSH placement', async () => {
  trigger(330);
  const shell = menu(['zsh', 'bash', 'Remote workspace']), other = menu(['Copy', 'Paste']);
  document.body.append(shell, other);
  dispose = installShellMenu();
  await frame();
  assert.ok(shell.hasAttribute('data-ra-shell-menu'));
  assert.equal(shell.style.getPropertyValue('--ra-shell-menu-left'), '410px');
  assert.equal(shell.style.getPropertyValue('--ra-shell-menu-top'), '354px');
  assert.equal(shell.style.left, '120px', 'DSH keeps its own inline placement');
  assert.ok(!other.hasAttribute('data-ra-shell-menu'), 'menus without the Remote workspace item are left alone');
  dispose(); dispose = () => {};
  assert.ok(!shell.hasAttribute('data-ra-shell-menu') && !document.querySelector('style[data-remote-shell-menu]'));
});

test('the shell menu opens above when only that side fits, and stays inside the viewport', async () => {
  dispose = installShellMenu();
  trigger(740);
  const shell = rect(menu(['zsh', 'Remote workspace']), 900, 0, 160, 110);
  document.body.append(shell);
  await frame();
  assert.equal(shell.style.getPropertyValue('--ra-shell-menu-top'), `${740 - 4 - 110}px`);
  Object.assign(window, { innerWidth: 500 });
  window.dispatchEvent(new window.Event('resize')); await frame();
  assert.equal(shell.style.getPropertyValue('--ra-shell-menu-left'), `${500 - 160 - 8}px`);
});
