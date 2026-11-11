import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { JSDOM } from 'jsdom';
import type { ChatProject } from '@dsh-plugins/remote-core/domain.js';
import { installCustomModelLabels } from '../src/client/composer/custom-model-label.js';
import { installShellMenu } from '../src/client/workspace/shell-menu.js';

const globals = ['window', 'document', 'MutationObserver', 'Node', 'NodeFilter', 'HTMLElement', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'] as const;
let dispose = () => {};
beforeEach(() => {
  const { window } = new JSDOM('<!doctype html><body></body>', { url: 'https://dsh.test/', pretendToBeVisual: true });
  for (const name of globals) Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? window : typeof window[name] === 'function' ? (window[name] as Function).bind(window) : window[name] });
});
afterEach(() => {
  dispose(); dispose = () => {};
  window.close();
  for (const name of globals) delete (globalThis as Record<string, unknown>)[name];
});
const settle = () => new Promise(resolve => setImmediate(resolve));
const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
const catalogs: ChatProject[] = [{ id: 'mini', hostId: 'mini', cwd: '/srv', label: 'macmini', providers: [
  { id: 'claude', label: 'Claude', status: 'ready', modes: [], models: [{ id: 'opus', label: 'Opus' }, { id: 'sonnet', label: 'Sonnet' }] },
] }];

for (const menuOpen of [false, true]) test(`terminal output does not scan the document or measure menu layout (menu ${menuOpen ? 'open' : 'closed'})`, async () => {
  document.body.innerHTML = `<aside>${'<div class="session">Saved conversation</div>'.repeat(1000)}</aside>
    <button aria-haspopup="menu" title="Opus · macmini"><span class="codexModelSelectLabel">Opus · macmini</span></button>
    <div class="xterm"><div class="xterm-rows"><div><span>initial</span></div></div></div>`;
  if (menuOpen) document.body.insertAdjacentHTML('beforeend', '<div data-sidebar-right-guide-entry="terminal"><button aria-haspopup="menu" aria-expanded="true">New terminal</button></div><div role="menu" data-menu-material="translucent"><button role="menuitem">Remote workspace</button></div>');
  let measurements = 0;
  for (const node of document.querySelectorAll('button, [role="menu"]')) Object.assign(node, { getBoundingClientRect: () => {
    measurements++;
    return { left: 20, top: 20, bottom: 40, right: 120, width: 100, height: 20, x: 20, y: 20 };
  } });
  const stopLabels = installCustomModelLabels(async () => catalogs), stopMenus = installShellMenu();
  dispose = () => { stopLabels(); stopMenus(); };
  await settle(); await frame(); await settle();
  assert.equal(document.querySelector('.codexModelSelectLabel')!.textContent, 'Opus');
  if (menuOpen) assert.ok(document.querySelector('[data-ra-shell-menu]'));
  const query = document.querySelectorAll.bind(document);
  let scans = 0;
  document.querySelectorAll = ((selector: string) => { scans++; return query(selector); }) as typeof document.querySelectorAll;
  measurements = 0;
  const rows = document.querySelector('.xterm-rows')!;
  const started = performance.now();
  // Separate observer deliveries, not one synchronous batch. Cover xterm row replacement and in-place text updates.
  for (let i = 0; i < 100; i++) {
    rows.innerHTML = `<div><span>streamed chunk ${i}</span></div>`;
    await settle();
    rows.querySelector('span')!.firstChild!.nodeValue = `streamed chunk ${i} updated`;
    await settle();
  }
  if (process.env.TUI_MUTATION_BENCHMARK) console.log(JSON.stringify({ menuOpen, batches: 200, documentScans: scans, layoutMeasurements: measurements, elapsedMs: performance.now() - started }));
  else {
    assert.equal(scans, 0, 'unrelated terminal output must not trigger either document-wide scan');
    assert.equal(measurements, 0, 'a shell menu must not force layout for terminal output');
  }
  document.querySelectorAll = query;
  // Filtering must not break the actual widgets, even after a long output burst.
  const caption = document.querySelector('.codexModelSelectLabel')!, button = caption.parentElement!;
  button.title = 'Sonnet · macmini'; caption.firstChild!.nodeValue = 'Sonnet · macmini';
  await settle();
  assert.equal(caption.textContent, 'Sonnet');
  if (menuOpen) {
    const menu = document.querySelector('[role="menu"]')!;
    const before = measurements;
    menu.innerHTML = '<button role="menuitem">Remote workspace</button><button role="menuitem">bash</button>';
    await settle();
    assert.ok(measurements > before, 'changed menu contents are still placed before paint');
    menu.remove(); await settle();
  }
});

test('nested late widgets and title-only changes are not filtered out', async () => {
  const stopLabels = installCustomModelLabels(async () => catalogs), stopMenus = installShellMenu();
  dispose = () => { stopLabels(); stopMenus(); };
  await settle(); await frame();
  const wrapper = document.createElement('section');
  wrapper.innerHTML = '<div><button aria-haspopup="menu" title="loading"><span class="codexModelSelectLabel">Opus · macmini</span></button></div><div data-sidebar-right-guide-entry="terminal"><button aria-haspopup="menu" aria-expanded="true">New terminal</button></div><div><div role="menu" data-menu-material="translucent"><button role="menuitem">Loading shells…</button></div></div>';
  document.body.append(wrapper);
  await settle();
  assert.ok(wrapper.querySelector('[data-ra-shell-menu]'));
  const button = wrapper.querySelector<HTMLButtonElement>('button')!;
  button.title = 'Opus · macmini';
  await settle();
  assert.equal(button.textContent, 'Opus');
  wrapper.remove(); await settle();
  dispose(); dispose = () => {};
  document.body.insertAdjacentHTML('beforeend', '<button aria-haspopup="menu" title="Opus · macmini"><span class="codexModelSelectLabel">Opus · macmini</span></button>');
  await settle();
  assert.equal(document.querySelector('.codexModelSelectLabel')!.textContent, 'Opus · macmini', 'disposed observers do not process new widgets');
});
