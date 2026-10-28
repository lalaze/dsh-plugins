import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { JSDOM } from 'jsdom';
import { installDevTools } from '../src/client/install.js';
import { AGENT_KEY, commandScript, type Poll } from '../src/client/guest.js';
import type { PanelView } from '../src/client/panel.js';

const until = async (check: () => boolean) => { for (let i = 0; i < 100; i++) { if (check()) return; await delay(10); } assert.fail('toolbar state timed out'); };

test('toolbar opens and closes the separate window and removes the session when its tab disappears', async t => {
  const dom = new JSDOM('<body><div><form><input></form><div class="content"><div class="viewport"></div></div></div></body>', { url: 'https://dsh.test/', pretendToBeVisual: true });
  const guest = new JSDOM('<html><body>Hello</body></html>', { url: 'https://page.test', runScripts: 'outside-only' });
  const doc = dom.window.document, view = doc.createElement('webview') as unknown as PanelView;
  view.setAttribute('data-sidebar-browser-frame', 'webview');
  view.getURL = () => 'https://page.test'; view.executeJavaScript = async code => structuredClone(await guest.window.eval(code));
  doc.querySelector('.viewport')!.append(view);
  let creates = 0, closes = 0;
  t.mock.method(globalThis, 'fetch', async (_: unknown, options: RequestInit) => {
    const input = JSON.parse(String(options.body));
    assert.equal(new Headers(options.headers).get('X-DSH-Debugger'), '1');
    if (input.action === 'create') { creates++; return Response.json({ id: 'test', token: 'owner' }); }
    if (input.action === 'close') { closes++; return Response.json({ ok: true }); }
    return Response.json({ commands: [] });
  });
  const stop = installDevTools(doc);
  t.after(() => { stop(); guest.window.close(); dom.window.close(); });
  const separate = doc.querySelector<HTMLButtonElement>('[data-dsh-browser-devtools=detach]')!;
  assert.ok(separate); assert.equal(doc.querySelector('[data-dsh-browser-devtools=toggle]'), null);
  assert.equal(doc.querySelectorAll('form button').length, 1);
  separate.click(); await until(() => separate.getAttribute('aria-pressed') === 'true' && !separate.disabled);
  assert.equal(creates, 1); assert.equal(doc.querySelector('.dsh-bdt-panel'), null);
  separate.click(); await until(() => separate.getAttribute('aria-pressed') === 'false' && !separate.disabled);
  assert.equal(closes, 1);
  separate.click(); await until(() => separate.getAttribute('aria-pressed') === 'true' && !separate.disabled);
  view.remove(); await until(() => closes === 2 && doc.querySelectorAll('form button').length === 0);
});

test('the separate-window button waits for a web page', async t => {
  const dom = new JSDOM('<body><div><form><input></form><div class="content"><div class="viewport"></div></div></div></body>', { url: 'https://dsh.test/', pretendToBeVisual: true });
  const doc = dom.window.document, view = doc.createElement('webview') as unknown as PanelView;
  let url = 'about:blank';
  view.setAttribute('data-sidebar-browser-frame', 'webview');
  view.getURL = () => url; view.executeJavaScript = async () => undefined;
  doc.querySelector('.viewport')!.append(view);
  const stop = installDevTools(doc);
  t.after(() => { stop(); dom.window.close(); });
  const separate = doc.querySelector<HTMLButtonElement>('[data-dsh-browser-devtools=detach]')!;
  assert.equal(separate.disabled, true);
  url = 'https://page.test'; view.dispatchEvent(new dom.window.Event('dom-ready'));
  assert.equal(separate.disabled, false);
});

test('each web page is recorded from load, before any debugger opens, and given back when the plugin stops', async t => {
  const dom = new JSDOM('<body><div><form><input></form><div class="content"><div class="viewport"></div></div></div></body>', { url: 'https://dsh.test/', pretendToBeVisual: true });
  const guest = new JSDOM('<html><body>Hello</body></html>', { url: 'https://page.test', runScripts: 'outside-only' });
  const doc = dom.window.document, view = doc.createElement('webview') as unknown as PanelView;
  let url = 'about:blank';
  view.setAttribute('data-sidebar-browser-frame', 'webview');
  view.getURL = () => url; view.executeJavaScript = async code => structuredClone(await guest.window.eval(code));
  doc.querySelector('.viewport')!.append(view);
  const agent = () => (guest.window as unknown as Record<string, unknown>)[AGENT_KEY];
  const stop = installDevTools(doc);
  t.after(() => { guest.window.close(); dom.window.close(); });
  await delay(20);
  assert.equal(agent(), undefined, 'a blank page is left alone');
  url = 'https://page.test'; view.dispatchEvent(new dom.window.Event('dom-ready'));
  await until(() => Boolean(agent()));
  guest.window.eval("console.log('before the debugger')");
  assert.equal((guest.window.eval(commandScript('poll')) as Poll).logs[0].text, 'before the debugger');
  stop();
  await until(() => agent() === undefined);
});
