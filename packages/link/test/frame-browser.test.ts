import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import vm from 'node:vm';
import { buildSync } from 'esbuild';
import { installFrameBrowser, type DesktopBrowserBridge } from '../src/frame/browser.js';
import { injectFrameBrowser, mountedIndex } from '../src/rewrite.js';

const P = 7389;
const GUEST_5173 = 'http://p5173.x-http.localhost.mabc.localhost:7389/';

/** Electron's webview tag as far as the script uses it: methods on the prototype, events dispatched on the element. */
class FakeWebview extends EventTarget {
  url = 'about:blank';
  loads: string[] = [];
  stops = 0;
  loadURL(url: string): Promise<void> { this.loads.push(url); this.url = url; return Promise.resolve(); }
  getURL(): string { return this.url; }
  stop(): void { this.stops++; }
}

function fakeShell(options: { shell?: boolean; bridge?: boolean } = {}) {
  const calls: string[] = [];
  const openers = new Map<string, (url: string) => void>();
  const bridge: DesktopBrowserBridge = {
    acquire: async workspace => { calls.push(`acquire ${workspace}`); return { lease: 'l1', partition: 'p1' }; },
    release: async lease => { calls.push(`release ${lease}`); },
    onOpenRequested: (lease, listener) => { openers.set(lease, listener); return () => openers.delete(lease); },
  };
  const made: FakeWebview[] = [];
  const shell = {
    ...(options.shell === false ? {} : { __dshLinkShell: {} }),
    ...(options.bridge === false ? {} : { dshDesktop: { protocolVersion: 1, browser: bridge } }),
    document: { createElement: (tag: string) => { assert.equal(tag, 'webview'); const element = new FakeWebview(); made.push(element); return element; } },
  };
  return { shell, calls, openers, made };
}

type Lent = { protocolVersion: number; browser: DesktopBrowserBridge; createWebview(): FakeWebview };

test('only a machine\'s page in the desktop window\'s frames gets the loan', () => {
  assert.equal(installFrameBrowser({ parent: fakeShell({ shell: false }).shell }, { machine: 'mabc', port: P }), false, 'not DSH Link\'s window');
  assert.equal(installFrameBrowser({ parent: fakeShell({ bridge: false }).shell }, { machine: 'mabc', port: P }), false, 'a browser, not the desktop app');
  const self: Record<string, unknown> = {}; self.parent = self;
  assert.equal(installFrameBrowser(self, { machine: 'mabc', port: P }), false, 'the window\'s own page');
  assert.equal(installFrameBrowser({ get parent(): unknown { throw new Error('cross-origin'); } }, { machine: 'mabc', port: P }), false);
  assert.equal(installFrameBrowser({ parent: fakeShell().shell }, undefined), false);
});

test('the lent bridge keeps each machine\'s storage apart and shows opened links as the machine\'s addresses', async () => {
  const { shell, calls, openers } = fakeShell();
  const win: Record<string, unknown> = { parent: shell };
  assert.equal(installFrameBrowser(win, { machine: 'mabc', port: P }), true);
  const lent = win.__dshLinkDesktop as Lent;
  assert.equal(lent.protocolVersion, 1);
  await lent.browser.acquire('cwd:/Users/me/app');
  await lent.browser.release('l1');
  assert.deepEqual(calls, ['acquire dsh-link:mabc:cwd:/Users/me/app', 'release l1']);
  const opened: string[] = [];
  lent.browser.onOpenRequested('l1', url => opened.push(url));
  openers.get('l1')!(`${GUEST_5173}docs?x=1`);
  openers.get('l1')!('https://github.com/');
  assert.deepEqual(opened, ['http://localhost:5173/docs?x=1', 'https://github.com/']);
});

test('the webview loads the machine\'s addresses from guest hosts and reports them as the machine\'s', async () => {
  const { shell, made } = fakeShell();
  const win: Record<string, unknown> = { parent: shell };
  installFrameBrowser(win, { machine: 'mabc', port: P });
  const element = (win.__dshLinkDesktop as Lent).createWebview();
  assert.equal(made[0], element);
  await element.loadURL('http://localhost:5173/');
  assert.deepEqual(element.loads, [GUEST_5173]);
  assert.equal(element.getURL(), 'http://localhost:5173/');
  await element.loadURL('https://github.com/');
  assert.equal(element.loads.at(-1), 'https://github.com/');
  assert.equal(element.getURL(), 'https://github.com/');
});

test('a link to an unmapped address of the machine is sent to its guest host; others are left alone', () => {
  const { shell } = fakeShell();
  const win: Record<string, unknown> = { parent: shell };
  installFrameBrowser(win, { machine: 'mabc', port: P });
  const element = (win.__dshLinkDesktop as Lent).createWebview();
  const navigate = (type: string, props: Record<string, unknown>) => element.dispatchEvent(Object.assign(new Event(type), props));
  navigate('did-start-navigation', { url: 'http://localhost:3000/x', isMainFrame: true, isInPlace: false });
  assert.deepEqual(element.loads, ['http://p3000.x-http.localhost.mabc.localhost:7389/x']);
  assert.equal(element.stops, 1);
  navigate('did-redirect-navigation', { url: 'http://192.168.1.5/', isMainFrame: true, isInPlace: false });
  assert.equal(element.loads.at(-1), 'http://p80.x-http.192.168.1.5.mabc.localhost:7389/');
  const before = element.loads.length;
  navigate('did-start-navigation', { url: GUEST_5173, isMainFrame: true, isInPlace: false });
  navigate('did-start-navigation', { url: 'https://github.com/', isMainFrame: true, isInPlace: false });
  navigate('did-start-navigation', { url: 'http://localhost:3000/', isMainFrame: false, isInPlace: false });
  navigate('did-start-navigation', { url: 'http://localhost:3000/#a', isMainFrame: true, isInPlace: true });
  assert.equal(element.loads.length, before);
});

test('without a forwarding port the loan still works and pages load from this computer', async () => {
  const { shell } = fakeShell();
  const win: Record<string, unknown> = { parent: shell };
  installFrameBrowser(win, { machine: 'mabc', port: 0 });
  const element = (win.__dshLinkDesktop as Lent).createWebview();
  await element.loadURL('http://localhost:5173/');
  assert.deepEqual(element.loads, ['http://localhost:5173/']);
  element.dispatchEvent(Object.assign(new Event('did-start-navigation'), { url: 'http://localhost:3000/', isMainFrame: true }));
  assert.equal(element.loads.length, 1);
});

const BUILT = buildSync({
  entryPoints: [fileURLToPath(new URL('../src/frame/entry.ts', import.meta.url))], bundle: true, format: 'iife', platform: 'browser', target: 'es2022', minify: true, write: false,
}).outputFiles[0]!.text;
const INDEX = readFileSync(new URL('./fixtures/dsh-0.2.2-rc.3-index.html', import.meta.url), 'utf8');
const inlineScripts = (html: string) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]!);

test('the built script, inlined in a mounted page, lends the browser in a frame and does nothing elsewhere', () => {
  const page = mountedIndex(INDEX, 'mabc', { script: BUILT, port: P }).html;
  const [config, script] = inlineScripts(injectFrameBrowser('<head></head>', 'mabc', { script: BUILT, port: P }));
  assert.equal(config, 'globalThis.__dshLinkFrame={"machine":"mabc","port":7389}');
  assert.ok(page.includes(script!), 'the mounted page carries it');
  // Before DSH's own scripts.
  assert.ok(page.indexOf('__dshLinkFrame') < page.indexOf('./assets/index-'));
  const run = (parent: unknown) => {
    const context: Record<string, unknown> = { parent };
    if (parent === 'self') context.parent = context;
    vm.createContext(context);
    vm.runInContext(config!, context);
    vm.runInContext(script!, context);
    return context.__dshLinkDesktop as Lent | undefined;
  };
  const lent = run(fakeShell().shell);
  assert.equal(lent?.protocolVersion, 1);
  assert.equal(typeof lent?.createWebview, 'function');
  assert.equal(run('self'), undefined);
  assert.equal(run(fakeShell({ bridge: false }).shell), undefined);
  assert.equal(mountedIndex(INDEX, 'mabc').html.includes('__dshLinkFrame'), false, 'no script without the setting');
});

test('the script cannot close its element, and framed pages hide the debugger window button', () => {
  const html = injectFrameBrowser('<head></head>', 'm1', { script: 'const a="</script><b>";', port: P });
  assert.equal(html.match(/<\/script>/g)!.length, 2);
  assert.match(mountedIndex(INDEX, 'mabc').html, /html\[data-dl-framed\] \[data-dsh-browser-devtools="detach"\]\{display:none!important\}/);
});
