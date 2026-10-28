import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { JSDOM } from 'jsdom';
import { AGENT_KEY, commandScript, type Poll } from '../src/client/guest.js';
import { category, DebuggerPanel, timingPhases, type PanelView } from '../src/client/panel.js';

const PAGE = `<!doctype html><html><head><style>.card{color:green}</style></head><body><main class="card">Card</main><p>Text</p></body></html>`;

/** The debugger window's panel container, driving a jsdom "guest" page through a webview-like view. */
function setup(t: TestContext) {
  const host = new JSDOM('<!doctype html><html><head></head><body><div id="panel"></div></body></html>', { url: 'https://dsh.test/', pretendToBeVisual: true });
  const guest = new JSDOM(PAGE, { url: 'https://page.test/', runScripts: 'outside-only', pretendToBeVisual: true });
  const doc = host.window.document;
  const view = doc.createElement('webview') as unknown as PanelView & { url: string };
  view.url = 'https://page.test/';
  view.getURL = () => view.url;
  // Electron evaluates in the page and structured-clones the (awaited) result.
  view.executeJavaScript = async (code: string) => {
    const value = await guest.window.eval(code);
    return value === undefined ? value : structuredClone(value);
  };
  let closed = 0;
  const panel = new DebuggerPanel(doc, view, () => { closed++; }, doc.getElementById('panel')!);
  // A failed assertion must not leave the poll interval or jsdom timers keeping the run alive.
  t.after(() => { panel.dispose(); host.window.close(); guest.window.close(); });
  const text = () => panel.root.textContent ?? '';
  const until = async (check: () => boolean, what: string) => {
    for (let i = 0; i < 100; i++) { if (check()) return; await delay(20); }
    assert.fail(`timed out waiting for ${what}`);
  };
  const click = (element: Element | null | undefined) => element!.dispatchEvent(new host.window.MouseEvent('click', { bubbles: true }));
  const tab = (name: string) => Array.from(panel.root.querySelectorAll<HTMLButtonElement>('.dsh-bdt-tab')).find(button => button.textContent === name);
  return { host, guest, doc, view, panel, text, until, click, tab, closed: () => closed };
}

test('opens in its container and shows the DOM tree with html and body expanded', async t => {
  const { doc, panel, text, until } = setup(t);
  await panel.open();
  assert.equal(panel.root.parentElement, doc.getElementById('panel'));
  assert.ok(doc.querySelector('style[data-dsh-browser-devtools=panel]'));
  await until(() => text().includes('<main class="card">Card</main>'), 'the body\'s children');
  assert.ok(text().includes('<!DOCTYPE html>'));
  assert.ok(panel.root.querySelector('.dsh-bdt-row[aria-expanded=true]'));
  panel.close();
});

test('selecting a node shows its matched rules, and $0 refers to it in the console', async t => {
  const { panel, text, until, click, tab } = setup(t);
  await panel.open();
  await until(() => text().includes('<main'), 'the tree');
  const row = Array.from(panel.root.querySelectorAll<HTMLElement>('.dsh-bdt-row')).find(item => item.textContent?.startsWith('<main'));
  click(row);
  await until(() => text().includes('.card {'), 'the matched rule');
  assert.ok(text().includes('== $0'));
  assert.equal(row?.isConnected ? row.getAttribute('aria-selected') : panel.root.querySelector('[aria-selected=true]')?.getAttribute('aria-selected'), 'true');
  click(tab('Computed'));
  await until(() => text().includes('margin') && text().includes('display'), 'the box model and computed list');
  click(tab('Console'));
  const prompt = panel.root.querySelector('textarea')!;
  prompt.value = '$0.className';
  prompt.dispatchEvent(new prompt.ownerDocument.defaultView!.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await until(() => text().includes('"card"'), 'the evaluated result');
  prompt.value = 'let n = 2; n * 21';
  prompt.dispatchEvent(new prompt.ownerDocument.defaultView!.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await until(() => text().includes('42'), 'a statement run as a script');
  panel.close();
});

test('page console output appears in the Console tab and repeats collapse into a count', async t => {
  const { guest, panel, text, until, click, tab } = setup(t);
  await panel.open();
  click(tab('Console'));
  guest.window.eval(`console.log('hello'); console.log('hello'); console.error('broken')`);
  await until(() => text().includes('broken'), 'the polled logs');
  assert.equal(panel.root.querySelector('.dsh-bdt-count')?.textContent, '2');
  assert.ok(panel.root.querySelector('.dsh-bdt-log[data-level=error] svg'));
  const filter = panel.root.querySelector<HTMLInputElement>('.dsh-bdt-filter')!;
  filter.value = 'brok'; filter.dispatchEvent(new guest.window.Event('input'));
  assert.equal(panel.root.querySelectorAll('.dsh-bdt-log').length, 1);
  panel.close();
});

test('close removes the panel and stops picking, but the page agent keeps recording', async t => {
  const { guest, panel, until, closed, text } = setup(t);
  await panel.open();
  await until(() => text().includes('<main'), 'the tree');
  const poll = () => guest.window.eval(commandScript('poll')) as Poll;
  panel.root.querySelector<HTMLButtonElement>('[aria-label="Select an element in the page to inspect it"]')!.click();
  await until(() => poll().picking, 'picking to start');
  panel.root.querySelector<HTMLButtonElement>('[aria-label="Close page debugger"]')!.click();
  assert.equal(panel.root.isConnected, false); assert.equal(closed(), 1); assert.equal(panel.opened, false);
  await until(() => !poll().picking, 'picking to stop');
  assert.ok((guest.window as unknown as Record<string, unknown>)[AGENT_KEY], 'the agent stays for the next window');
  assert.equal(guest.window.document.querySelector('dsh-browser-devtools-overlay'), null);
});

test('a non-web page shows a message', async t => {
  const { view, panel, text } = setup(t);
  view.url = 'about:blank';
  await panel.open();
  assert.ok(text().includes('Open a web page to debug it.'));
  panel.close();
});

test('selecting a request opens Chrome-style details beside the Name column', async t => {
  const { guest, panel, text, until, click, tab } = setup(t);
  Object.assign(guest.window, {
    TextDecoder,
    fetch: async () => new Response('{"user":{"name":"Ada"},"tags":["a"]}', { headers: { 'Content-Type': 'application/json' } }),
  });
  await panel.open();
  click(tab('Network'));
  await guest.window.eval(`fetch('https://page.test/api/user?id=7', { method: 'POST', headers: { 'X-Token': 't' }, body: '{"id":7}' })`);
  const row = () => Array.from(panel.root.querySelectorAll<HTMLElement>('tr[data-seq]')).find(item => item.textContent?.startsWith('user?id=7'));
  await until(() => Boolean(row()), 'the request row');
  assert.equal(panel.root.querySelectorAll('th').length, 5);
  click(row()!.firstElementChild);
  await until(() => text().includes('Request URL'), 'the Headers tab');
  assert.equal(panel.root.querySelectorAll('th').length, 1, 'only the Name column stays');
  for (const expected of ['https://page.test/api/user?id=7', 'POST', '200 OK', 'Response Headers', 'content-type', 'application/json', 'Request Headers', 'x-token']) assert.ok(text().includes(expected), expected);
  click(tab('Payload'));
  await until(() => text().includes('Query String Parameters'), 'the Payload tab');
  assert.ok(text().includes('Request Payload') && text().includes('id: 7'));
  click(tab('Preview'));
  await until(() => Boolean(panel.root.querySelector('.dsh-bdt-detail .dsh-bdt-json[open]')), 'the JSON tree');
  assert.ok(text().includes('user: {name: "Ada"}') && text().includes('tags: (1) ["a"]'));
  click(tab('Response'));
  await until(() => panel.root.querySelector('.dsh-bdt-detail pre')?.textContent === '{"user":{"name":"Ada"},"tags":["a"]}', 'the raw response');
  panel.root.querySelector('.dsh-bdt-table')!.dispatchEvent(new guest.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(panel.root.querySelector<HTMLElement>('.dsh-bdt-detail')!.hidden, true);
  assert.equal(panel.root.querySelectorAll('th').length, 5, 'closing restores every column');
});

test('a resource known only from timing says what was not recorded', async t => {
  const { panel, text, until, click, tab } = setup(t);
  await panel.open();
  click(tab('Network'));
  (panel as unknown as { network: unknown[] }).network = [{ seq: 99, url: 'https://cdn.test/app.js', method: 'GET', type: 'script', status: 0, failed: false, size: -1, cached: false, start: 1, duration: 2 }];
  (panel as unknown as { renderNetwork(): void }).renderNetwork();
  click(panel.root.querySelector('tr[data-seq="99"] td'));
  await until(() => text().includes('Headers are only recorded for Fetch and XHR requests made after the page finished loading.'), 'the missing-details note');
  click(tab('Response'));
  assert.ok(text().includes('Response bodies are only recorded'));
});

test('timing phases follow Chrome and are hidden for cross-origin requests without Timing-Allow-Origin', () => {
  const zero = { startTime: 0, redirectStart: 0, redirectEnd: 0, fetchStart: 0, domainLookupStart: 0, domainLookupEnd: 0, connectStart: 0, connectEnd: 0, secureConnectionStart: 0, requestStart: 0, responseStart: 0, responseEnd: 0, duration: 0 };
  const full = timingPhases({ ...zero, startTime: 10, fetchStart: 10, domainLookupStart: 12, domainLookupEnd: 15, connectStart: 15, connectEnd: 30, secureConnectionStart: 20, requestStart: 30, responseStart: 80, responseEnd: 95, duration: 85 });
  assert.equal(full.detailed, true);
  assert.deepEqual(full.phases.map(phase => [phase.id, phase.end - phase.start]), [['stalled', 2], ['dns', 3], ['connect', 15], ['ssl', 10], ['waiting', 50], ['download', 15]]);
  const hidden = timingPhases({ ...zero, startTime: 10, fetchStart: 10, responseEnd: 95, duration: 85 });
  assert.equal(hidden.detailed, false); assert.deepEqual(hidden.phases, []);
});

test('requests are sorted into Chrome\'s Network type filters', () => {
  assert.equal(category({ type: 'fetch', url: 'https://a.test/api' }), 'fetch');
  assert.equal(category({ type: 'xmlhttprequest', url: 'https://a.test/api' }), 'fetch');
  assert.equal(category({ type: 'script', url: 'https://a.test/app' }), 'js');
  assert.equal(category({ type: 'link', url: 'https://a.test/site.css?v=2' }), 'css');
  assert.equal(category({ type: 'css', url: 'https://a.test/f.woff2' }), 'font');
  assert.equal(category({ type: 'img', url: 'https://a.test/logo' }), 'img');
  assert.equal(category({ type: 'other', url: 'https://a.test/clip.mp4' }), 'media');
  assert.equal(category({ type: 'beacon', url: 'https://a.test/b' }), 'fetch');
  assert.equal(category({ type: 'other', url: 'https://a.test/x' }), 'other');
});
