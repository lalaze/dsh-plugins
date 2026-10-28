import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { JSDOM } from 'jsdom';
import { DebuggerBridge } from '../src/bridge.js';
import { DetachedDebugger, type OwnerRequest } from '../src/client/detached.js';
import { startDebuggerWindow } from '../src/client/window.js';
import { AGENT_KEY } from '../src/client/guest.js';
import type { PanelView } from '../src/client/panel.js';

const until = async (check: () => boolean, what: string) => {
  for (let i = 0; i < 200; i++) { if (check()) return; await delay(25); }
  assert.fail(`timed out: ${what}`);
};

test('separate window: Elements, $0, console, network, navigation, theme, locale and cleanup over HTTP', async t => {
  let url = '', closed = 0;
  const bridge = new DebuggerBridge(async value => { url = value; return { async close() { closed++; } }; }, Date.now, async () => '');
  const host = new JSDOM('<body data-ds-dark-theme></body>', { url: 'https://dsh.test/' });
  let guest = new JSDOM('<html><body><main class="card">Card</main></body></html>', { url: 'https://page.test/', runScripts: 'outside-only', pretendToBeVisual: true });
  guest.window.fetch = async () => new Response('ok', { headers: { 'Content-Length': '2' } });
  const view = host.window.document.createElement('webview') as unknown as PanelView;
  view.getURL = () => guest.window.location.href;
  view.executeJavaScript = async code => structuredClone(await guest.window.eval(code));
  let locale = 'en';
  const request: OwnerRequest = async <T>(input: Record<string, unknown>) => {
    if (input.page) input.page = { ...input.page as object, locale };
    return await bridge.ownerRequest(input) as T;
  };
  const owner = new DetachedDebugger(host.window.document, view, () => {}, request);
  await owner.open(); assert.equal(owner.opened, true);
  const remote = new JSDOM('<body><header id="target"></header><div id="panel"></div><div id="message"></div></body>', { url, pretendToBeVisual: true });
  remote.window.fetch = (input, init) => fetch(typeof input === 'string' ? new URL(input, url) : input, init);
  remote.window.HTMLElement.prototype.scrollIntoView = () => {};
  const stop = startDebuggerWindow(remote.window as unknown as Window);
  t.after(async () => { stop(); owner.dispose(); await bridge.dispose(); remote.window.close(); host.window.close(); guest.window.close(); });
  const doc = remote.window.document, text = () => doc.body.textContent ?? '';
  await until(() => text().includes('<main class="card">Card'), 'remote DOM tree');
  assert.equal(remote.window.location.hash, ''); assert.ok(doc.body.hasAttribute('data-ds-dark-theme'));
  assert.equal(doc.querySelector('.dsh-bdt-resize'), null);
  const tab = (label: string) => Array.from(doc.querySelectorAll<HTMLButtonElement>('.dsh-bdt-tab')).find(b => b.textContent === label)!.click();
  Array.from(doc.querySelectorAll<HTMLElement>('.dsh-bdt-row')).find(row => row.textContent?.startsWith('<main'))!.click();
  await until(() => text().includes('== $0'), 'selection');
  tab('Console');
  const input = doc.querySelector('textarea')!; input.value = '$0.className';
  input.dispatchEvent(new remote.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await until(() => text().includes('"card"'), '$0 evaluation');
  guest.window.eval("console.warn('from guest'); fetch('https://page.test/api')");
  await until(() => text().includes('from guest'), 'console streaming');
  tab('Network'); await until(() => text().includes('api') && text().includes('200'), 'network capture');
  // Navigation reuses the OS window while throwing away document-specific selections and logs.
  view.dispatchEvent(new host.window.Event('did-navigate'));
  guest.window.close();
  guest = new JSDOM('<html><body><h1>Next document</h1></body></html>', { url: 'https://next.test/', runScripts: 'outside-only', pretendToBeVisual: true });
  view.dispatchEvent(new host.window.Event('dom-ready'));
  host.window.document.body.removeAttribute('data-ds-dark-theme');
  await until(() => text().includes('Next document') && text().includes('https://next.test/'), 'navigation reattach');
  assert.equal(closed, 0, 'replacing the panel must not close the window');
  assert.equal(doc.body.hasAttribute('data-ds-dark-theme'), false);
  locale = 'zh'; await until(() => text().includes('网页调试器') && text().includes('控制台'), 'locale update');
  locale = 'en'; await until(() => text().includes('Console'), 'locale restored');
  doc.querySelector<HTMLButtonElement>('[aria-label="Close page debugger"]')!.click();
  await until(() => !owner.opened && closed === 1, 'window close reflected in DSH');
  assert.ok((guest.window as unknown as Record<string, unknown>)[AGENT_KEY], 'the page keeps recording for the next window');
});

test('navigation while exchange is in flight discards the old command before executing it', async t => {
  const dom = new JSDOM('<body></body>');
  const view = dom.window.document.createElement('webview') as unknown as PanelView;
  view.getURL = () => 'https://page.test';
  const executed: string[] = []; view.executeJavaScript = async code => { executed.push(code); };
  let release!: (value: unknown) => void;
  const request = (async (input: Record<string, unknown>) => input.action === 'create' ? { id: 'id', token: 'token' }
    : input.action === 'exchange' ? new Promise<unknown>(resolve => { release = resolve; }) : {}) as OwnerRequest;
  const owner = new DetachedDebugger(dom.window.document, view, () => {}, request);
  t.after(() => { owner.dispose(); dom.window.close(); });
  await owner.open();
  view.dispatchEvent(new dom.window.Event('did-navigate')); view.dispatchEvent(new dom.window.Event('dom-ready'));
  release({ commands: [{ id: 'old', code: 'wrongPage()', revision: 0, gesture: false }] });
  await delay(10);
  assert.deepEqual(executed, []);
});

test('disposing while a window is opening closes the late-created session', async () => {
  const dom = new JSDOM('<body></body>');
  const view = dom.window.document.createElement('webview') as unknown as PanelView;
  view.getURL = () => 'https://page.test'; view.executeJavaScript = async () => {};
  let resolve!: (value: unknown) => void; let closes = 0;
  const request = (async (input: Record<string, unknown>) => input.action === 'create' ? new Promise<unknown>(done => { resolve = done; }) : (closes++, {})) as OwnerRequest;
  const owner = new DetachedDebugger(dom.window.document, view, () => {}, request);
  const opening = owner.open(); owner.dispose(); resolve({ id: 'late', token: 'token' }); await opening;
  assert.equal(closes, 1); assert.equal(owner.opened, false); dom.window.close();
});
