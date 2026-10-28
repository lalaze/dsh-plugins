import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { DebuggerBridge } from '../lib/server/bridge.js';
import { launchWindow } from '../lib/server/launcher.js';
import { DetachedDebugger } from '../src/client/detached.ts';
import { AGENT_KEY } from '../src/client/guest.ts';

const exec = promisify(execFile), session = `dsh-debugger-${process.pid}`;
const output = fileURLToPath(new URL('../../../artifacts/browser-devtools-0.3.0/', import.meta.url));
await mkdir(output, { recursive: true });
const browser = async (...args) => {
  const { stdout } = await exec('agent-browser', ['--session', session, '--json', ...args], { timeout: 35000, maxBuffer: 1024 * 1024 });
  const result = JSON.parse(stdout); if (!result.success) throw new Error(result.error || 'Browser command failed'); return result.data;
};
const evaluate = async code => (await browser('eval', '-b', Buffer.from(code).toString('base64'))).result;
const wait = async code => { for (let i = 0; i < 80; i++) { if (await evaluate(code)) return; await delay(100); } throw new Error(`UI condition timed out: ${code}`); };
const until = async check => { for (let i = 0; i < 200; i++) { if (check()) return; await delay(50); } throw new Error('Timed out waiting for debugger'); };
const host = new JSDOM('<body></body>', { url: 'https://dsh.test/' });
const guest = new JSDOM('<!doctype html><html><head><style>.card{padding:16px;color:teal}</style></head><body><main class="card"><h1>Desktop debugger</h1><button id="action">Inspect me</button></main></body></html>', { url: 'https://fixture.test/', runScripts: 'outside-only', pretendToBeVisual: true });
guest.window.fetch = async () => new Response('{"ok":true}', { headers: { 'Content-Length': '11' } });
const view = host.window.document.createElement('webview');
view.getURL = () => guest.window.location.href;
view.executeJavaScript = async code => structuredClone(await guest.window.eval(code));
let url, locale = 'en', closed = 0;
const bridge = new DebuggerBridge(async value => { url = value; return { async close() { closed++; } }; });
const owner = new DetachedDebugger(host.window.document, view, () => {}, input => {
  if (input.page) input.page.locale = locale;
  return bridge.ownerRequest(input);
});
let nativeBridge, nativeOwner;
try {
  if (!process.argv.includes('--native-only')) {
  await owner.open(); assert.ok(owner.opened);
  await browser(...(process.platform === 'darwin' ? ['--executable-path', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'] : []), 'open', url);
  await browser('set', 'viewport', '1100', '760');
  await wait('document.querySelectorAll(".dsh-bdt-row").length >= 5');
  assert.equal(await evaluate('location.hash'), '');
  assert.equal(await evaluate('Math.abs(document.querySelector(".dsh-bdt-panel").getBoundingClientRect().bottom-innerHeight)<2'), true);
  await browser('click', '.dsh-bdt-row[data-id]:has-text("<main")');
  await wait('document.querySelector(".dsh-bdt-side").textContent.includes(".card {")');
  await browser('screenshot', `${output}/elements-light.png`);
  await browser('click', '.dsh-bdt-tab:text-is("Console")');
  await browser('fill', 'textarea[aria-label="Console prompt"]', '$0.className');
  await browser('press', 'Enter');
  await wait('document.querySelector("[data-kind=result]")?.textContent.includes("card")');
  guest.window.eval("console.warn('Log from the DSH page'); fetch('https://fixture.test/api/check')");
  await wait('document.querySelector(".dsh-bdt-console").textContent.includes("Log from the DSH page")');
  host.window.document.body.setAttribute('data-ds-dark-theme', ''); locale = 'zh';
  await wait('document.body.hasAttribute("data-ds-dark-theme") && document.querySelector("[role=tablist]").textContent.includes("控制台")');
  await browser('screenshot', `${output}/console-dark-zh.png`);
  await browser('click', '.dsh-bdt-tab:text-is("网络")');
  await wait('document.querySelector(".dsh-bdt-table").textContent.includes("200")');
  await browser('screenshot', `${output}/network-dark-zh.png`);
  await browser('click', '.dsh-bdt-table tr[data-seq]:has-text("check")');
  await wait('document.querySelector(".dsh-bdt-detail").textContent.includes("请求网址") && document.querySelectorAll(".dsh-bdt-table th").length === 1');
  await browser('screenshot', `${output}/network-headers-dark-zh.png`);
  await browser('click', '.dsh-bdt-detail .dsh-bdt-tab:text-is("预览")');
  await wait('document.querySelector(".dsh-bdt-detail .dsh-bdt-json-key")?.textContent === "ok: "');
  await browser('press', 'Escape');
  await wait('document.querySelector(".dsh-bdt-detail").hidden && document.querySelectorAll(".dsh-bdt-table th").length === 5');
  await browser('set', 'viewport', '480', '640');
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
  await browser('click', '[aria-label="关闭网页调试器"]');
  await until(() => closed === 1 && !owner.opened);
  assert.equal(guest.window[AGENT_KEY], undefined);
  console.log('Chrome UI passed: DOM/styles, $0, console, network and request details, theme/locale, resize and close.');
  await browser('close');

  }
  if (process.argv.includes('--native') || process.argv.includes('--native-only')) {
    const before = new Set((await readdir(tmpdir())).filter(name => name.startsWith('dsh-debugger-window-')));
    let requests = 0;
    class NativeBridge extends DebuggerBridge {
      async windowRequest(input, auth) { requests++; return super.windowRequest(input, auth); }
    }
    nativeBridge = new NativeBridge(launchWindow);
    nativeOwner = new DetachedDebugger(host.window.document, view, () => {}, input => nativeBridge.ownerRequest(input));
    await nativeOwner.open(); assert.ok(nativeOwner.opened, 'native Chrome app starts');
    await until(() => requests >= 5 && Boolean(guest.window[AGENT_KEY]));
    await nativeOwner.close();
    await nativeBridge.dispose();
    const leaked = (await readdir(tmpdir())).filter(name => name.startsWith('dsh-debugger-window-') && !before.has(name));
    assert.deepEqual(leaked, []);
    console.log('Native Chrome app passed: bundled UI loaded, page agent connected, process/profile cleaned.');
  }
} finally {
  await browser('close').catch(() => {});
  owner.dispose(); nativeOwner?.dispose();
  await bridge.dispose(); await nativeBridge?.dispose(); host.window.close(); guest.window.close();
}
