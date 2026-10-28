import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { JSDOM } from 'jsdom';
import { installDevTools } from '../src/client/install.js';
import type { PanelView } from '../src/client/panel.js';

const until = async (check: () => boolean) => { for (let i = 0; i < 100; i++) { if (check()) return; await delay(10); } assert.fail('toolbar state timed out'); };

test('toolbar switches docked/separate modes and removes the session when its tab disappears', async t => {
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
  const dock = doc.querySelector<HTMLButtonElement>('[data-dsh-browser-devtools=toggle]')!;
  const separate = doc.querySelector<HTMLButtonElement>('[data-dsh-browser-devtools=detach]')!;
  assert.ok(dock); assert.ok(separate); assert.equal(doc.querySelectorAll('form button').length, 2);
  dock.click(); await until(() => dock.getAttribute('aria-pressed') === 'true' && !dock.disabled);
  assert.ok(doc.querySelector('.dsh-bdt-panel'));
  separate.click(); await until(() => separate.getAttribute('aria-pressed') === 'true' && !separate.disabled);
  assert.equal(creates, 1); assert.equal(doc.querySelector('.dsh-bdt-panel'), null);
  dock.click(); await until(() => dock.getAttribute('aria-pressed') === 'true' && !dock.disabled);
  assert.equal(closes, 1); assert.ok(doc.querySelector('.dsh-bdt-panel'));
  separate.click(); await until(() => separate.getAttribute('aria-pressed') === 'true' && !separate.disabled);
  view.remove(); await until(() => closes === 2 && doc.querySelectorAll('form button').length === 0);
});
