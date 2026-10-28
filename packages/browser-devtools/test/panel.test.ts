import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { JSDOM } from 'jsdom';
import { AGENT_KEY } from '../src/client/guest.js';
import { category, DebuggerPanel, type PanelView } from '../src/client/panel.js';

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

test('close removes the panel, detaches the page agent and reports it', async t => {
  const { guest, panel, until, closed, text } = setup(t);
  await panel.open();
  await until(() => text().includes('<main'), 'the tree');
  assert.ok((guest.window as unknown as Record<string, unknown>)[AGENT_KEY]);
  panel.root.querySelector<HTMLButtonElement>('[aria-label="Close page debugger"]')!.click();
  assert.equal(panel.root.isConnected, false); assert.equal(closed(), 1); assert.equal(panel.opened, false);
  await until(() => (guest.window as unknown as Record<string, unknown>)[AGENT_KEY] === undefined, 'the agent to detach');
});

test('a non-web page shows a message', async t => {
  const { view, panel, text } = setup(t);
  view.url = 'about:blank';
  await panel.open();
  assert.ok(text().includes('Open a web page to debug it.'));
  panel.close();
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
