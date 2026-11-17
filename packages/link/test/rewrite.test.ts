import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { BAR_HEIGHT, credentialedManifest, guardDesktopBoot, injectFrameTop, injectOwnsHost, injectRequestBase, injectShellReturn, injectStorageNamespace, mountedId, mountedIndex, RAW_STORAGE, SHELL_GLOBAL, selectSession } from '../src/rewrite.js';

const INDEX = readFileSync(new URL('./fixtures/dsh-0.2.2-rc.3-index.html', import.meta.url), 'utf8');
const scripts = (html: string) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]!);

test('the rc.3 index passes every probe, and the namespace runs before the guard and DSH', () => {
  const page = mountedIndex(INDEX, 'mabc');
  assert.deepEqual(page.misses, []);
  assert.match(page.html, /crossorigin="use-credentials"/);
  const head = page.html.slice(page.html.indexOf('<head>'));
  assert.ok(head.indexOf('dsh-link:mabc:') < head.indexOf('dshDesktopBoot'));
  assert.ok(head.indexOf('dshDesktopBoot') < head.indexOf('./assets/index-'));
  assert.ok(head.indexOf('"/dsh-link/peer/mabc"') < head.indexOf('./assets/index-'));
  // Going back to this computer's page comes before anything else.
  assert.ok(head.indexOf('location.replace("/")') < head.indexOf('dsh-link:mabc:'));
});

test('a changed index is left alone and reported', () => {
  const changed = INDEX.replace('(globalThis.__DSH_BOOT_READY__ ??= Promise.withResolvers()).resolve()', 'globalThis.__DSH_BOOT_READY__.resolve()').replace('<link rel="manifest" href="./manifest.webmanifest" />', '<link rel=manifest href=/m.json>');
  const page = mountedIndex(changed, 'mabc');
  assert.deepEqual(page.misses.map(miss => miss.point).sort(), ['desktop-boot', 'manifest']);
  assert.equal(credentialedManifest(changed).html, changed);
});

test('ids and prefixes cannot close the injected script', () => {
  const html = guardDesktopBoot(INDEX, '/x</script><script>alert(1)//').html;
  assert.equal(html.match(/<\/script>/g)!.length, INDEX.match(/<\/script>/g)!.length + 1);
});

function storage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: key => map.get(key) ?? null, setItem: (key, value) => { map.set(key, String(value)); }, removeItem: key => { map.delete(key); },
    clear: () => map.clear(), key: index => [...map.keys()][index] ?? null, get length() { return map.size; },
  } as Storage;
}

test('the namespace gives a mounted page its own localStorage and keeps the real one for the switcher', () => {
  const real = storage();
  real.setItem('dsh.sessions.current', JSON.stringify({ sessionId: 'own' }));
  const window = { localStorage: real } as unknown as Record<string, unknown>;
  const context = vm.createContext({ window, globalThis: window });
  vm.runInContext(scripts(injectStorageNamespace(INDEX, 'mabc'))[0]!, context);
  const page = window.localStorage as Storage;
  assert.equal(page.getItem('dsh.sessions.current'), null);
  page.setItem('dsh.sessions.current', JSON.stringify({ sessionId: 'peer' }));
  assert.equal(real.getItem('dsh-link:mabc:dsh.sessions.current'), JSON.stringify({ sessionId: 'peer' }));
  assert.equal(page.length, 1);
  assert.equal(page.key(0), 'dsh.sessions.current');
  page.clear();
  assert.equal(real.getItem('dsh.sessions.current'), JSON.stringify({ sessionId: 'own' }));
  assert.equal(window[RAW_STORAGE], real);
  selectSession(real, 'mxyz', 's1');
  selectSession(real, '', 's2');
  assert.equal(real.getItem('dsh-link:mxyz:dsh.sessions.current'), JSON.stringify({ sessionId: 's1' }));
  assert.equal(real.getItem('dsh.sessions.current'), JSON.stringify({ sessionId: 's2' }));
});

test('in the desktop window the guard rebases the stream under the mount and keeps the boot gate', async () => {
  const seen: unknown[] = [];
  const globalObject: Record<string, unknown> = { URL, dshDesktopBoot: { ready: async () => ({ streamBaseUrl: 'http://127.0.0.1:5173/', rows: [] }) } };
  globalObject.globalThis = globalObject;
  const context = vm.createContext(globalObject);
  const html = injectOwnsHost(guardDesktopBoot(INDEX, '/dsh-link/peer/mabc').html);
  for (const script of scripts(html).slice(0, 2)) vm.runInContext(script, context);
  // DSH's web entry, in the order 0.2.2's desktop path runs it: its own transport is refused, then it waits on the gate.
  assert.throws(() => vm.runInContext('globalThis.__DSH_TRANSPORT__ = { streamBaseUrl: "http://127.0.0.1:5173/" }', context), /keeps its own boot/);
  await (globalObject.__DSH_BOOT_READY__ as { promise: Promise<void> }).promise;
  seen.push(JSON.parse(JSON.stringify(globalObject.__DSH_TRANSPORT__)));
  assert.deepEqual(seen, [{ ownsHost: true, streamBaseUrl: 'http://127.0.0.1:5173/dsh-link/peer/mabc/' }]);
  // The tail script of the index then settles nothing it does not own.
  vm.runInContext(scripts(INDEX).at(-1)!, context);
});

test('outside the desktop window the guard does nothing and ownsHost is set', () => {
  const globalObject: Record<string, unknown> = {};
  globalObject.globalThis = globalObject;
  const context = vm.createContext(globalObject);
  for (const script of scripts(injectOwnsHost(guardDesktopBoot(INDEX, '/p').html)).slice(0, 2)) vm.runInContext(script, context);
  assert.deepEqual(JSON.parse(JSON.stringify(globalObject.__DSH_TRANSPORT__)), { ownsHost: true });
  assert.equal(globalObject.__DSH_BOOT_READY__, undefined);
});

test('a page kept in a frame of the desktop window boots from the stream the window\'s page got', async () => {
  const parent = { dshDesktopBoot: { ready: async () => { throw new Error('the window already booted'); } }, __DSH_TRANSPORT__: { ownsHost: true, streamBaseUrl: 'http://127.0.0.1:5173/' } };
  const globalObject: Record<string, unknown> = { URL, parent };
  globalObject.globalThis = globalObject;
  const context = vm.createContext(globalObject);
  for (const script of scripts(injectOwnsHost(guardDesktopBoot(INDEX, '/dsh-link/peer/mabc').html)).slice(0, 2)) vm.runInContext(script, context);
  await (globalObject.__DSH_BOOT_READY__ as { promise: Promise<void> }).promise;
  assert.deepEqual(JSON.parse(JSON.stringify(globalObject.__DSH_TRANSPORT__)), { ownsHost: true, streamBaseUrl: 'http://127.0.0.1:5173/dsh-link/peer/mabc/' });
  vm.runInContext(scripts(INDEX).at(-1)!, context);
});

test('a page in a frame of a browser window, or of a window the page cannot read, boots as in a browser', () => {
  for (const parent of [{ __DSH_TRANSPORT__: { streamBaseUrl: 'http://x/' } }, new Proxy({}, { get() { throw new Error('cross-origin'); } })]) {
    const globalObject: Record<string, unknown> = { URL, parent };
    globalObject.globalThis = globalObject;
    const context = vm.createContext(globalObject);
    for (const script of scripts(guardDesktopBoot(INDEX, '/p').html).slice(0, 1)) vm.runInContext(script, context);
    assert.equal(globalObject.__DSH_BOOT_READY__, undefined);
    assert.equal(globalObject.__DSH_TRANSPORT__, undefined);
  }
});

test('a machine\'s page opened as the window\'s page goes to this computer\'s page, which shows it in a frame', () => {
  const run = (window: Record<string, unknown>, protocol = 'h2') => {
    const replaced: string[] = [];
    Object.assign(window, { location: { replace: (url: string) => replaced.push(url) }, performance: { getEntriesByType: () => [{ nextHopProtocol: protocol }] } });
    window.window = window;
    window.top ??= window;
    vm.runInContext(scripts(injectShellReturn(INDEX, 'mabc'))[0]!, vm.createContext(window));
    return replaced;
  };
  const session = storage(), local = storage();
  assert.deepEqual(run({ sessionStorage: session, localStorage: local }), ['/']);
  assert.equal(session.getItem('dsh-link:shown'), 'mabc');
  assert.equal(session.getItem('dsh-link:returned'), 'mabc');
  // Over HTTP/1.1 pages are not kept unless chosen, so the page stays; chosen, it goes.
  assert.deepEqual(run({ sessionStorage: storage(), localStorage: storage() }, 'http/1.1'), []);
  const chosen = storage();
  chosen.setItem('dsh-link:keep-pages', 'on');
  assert.deepEqual(run({ sessionStorage: storage(), localStorage: chosen }, 'http/1.1'), ['/']);
  // Kept pages off, the machine opened directly, or a page in a frame: it stays.
  local.setItem('dsh-link:keep-pages', 'off');
  assert.deepEqual(run({ sessionStorage: storage(), localStorage: local }), []);
  const direct = storage();
  direct.setItem('dsh-link:direct', 'mabc');
  assert.deepEqual(run({ sessionStorage: direct, localStorage: storage() }), []);
  assert.deepEqual(run({ sessionStorage: storage(), localStorage: storage(), top: {} }), []);
});

test('mounted pages are recognised by their path', () => {
  assert.equal(mountedId('/dsh-link/peer/m0123456789/'), 'm0123456789');
  assert.equal(mountedId('/dsh-link/peer/m01/api/x'), 'm01');
  assert.equal(mountedId('/'), undefined);
  assert.equal(mountedId('/dsh-link/peers'), undefined);
});

/** Runs the request base on a page at `href` with stand-ins that record the URL each request API was given. */
function requestPage(href: string) {
  const seen: string[] = [];
  class FakeXhr { open(_method: string, url: string) { seen.push(`xhr ${url}`); } }
  class FakeEventSource { constructor(url: string) { seen.push(`sse ${url}`); } }
  const page: Record<string, unknown> = {
    URL, Request, location: new URL(href), XMLHttpRequest: FakeXhr, EventSource: FakeEventSource,
    fetch: async (input: unknown) => { seen.push(`fetch ${input instanceof Request ? `${input.method} ${input.url} ${await input.text()}` : String(input)}`); return 'ok'; },
    navigator: { sendBeacon: (url: string) => { seen.push(`beacon ${url}`); return true; } },
  };
  page.globalThis = page;
  const context = vm.createContext(page);
  vm.runInContext(scripts(injectRequestBase(INDEX, '/dsh-link/peer/mabc'))[0]!, context);
  return { page, seen, run: (source: string) => vm.runInContext(source, context) as unknown };
}

test('a mounted page sends its absolute-path requests to its machine, and leaves everything else alone', async () => {
  const { page, seen, run } = requestPage('http://100.125.78.115:50115/dsh-link/peer/mabc/');
  await run(`Promise.all([
    fetch('/api/remote-agents'),
    fetch('/api/usage-stats?days=7#top'),
    fetch(new URL('/api/git-view', location.href)),
    fetch('./assets/index.js'),
    fetch('/dsh-link/peers'),
    fetch('/dsh-link'),
    fetch('/dsh-link/peer/mabc/api/remote.mux'),
    fetch('https://example.com/api/x'),
    fetch('//100.125.78.115:50116/api/x'),
    fetch(new Request(location.origin + '/api/remote-agents', { method: 'POST', body: '{"action":"workspaceModels"}' })),
  ])`);
  new (page.XMLHttpRequest as new () => { open(m: string, u: string): void })().open('GET', '/plugins/x/settings');
  const source = new (page.EventSource as new (url: string) => object)('/api/events');
  assert.ok(source instanceof (page.EventSource as new (url: string) => object));
  (page.navigator as { sendBeacon(url: string): boolean }).sendBeacon('/api/beacon');
  assert.deepEqual(seen, [
    'fetch http://100.125.78.115:50115/dsh-link/peer/mabc/api/remote-agents',
    'fetch http://100.125.78.115:50115/dsh-link/peer/mabc/api/usage-stats?days=7#top',
    'fetch http://100.125.78.115:50115/dsh-link/peer/mabc/api/git-view',
    'fetch ./assets/index.js',
    'fetch /dsh-link/peers',
    'fetch /dsh-link',
    'fetch /dsh-link/peer/mabc/api/remote.mux',
    'fetch https://example.com/api/x',
    'fetch //100.125.78.115:50116/api/x',
    'fetch POST http://100.125.78.115:50115/dsh-link/peer/mabc/api/remote-agents {"action":"workspaceModels"}',
    'xhr http://100.125.78.115:50115/dsh-link/peer/mabc/plugins/x/settings',
    'sse http://100.125.78.115:50115/dsh-link/peer/mabc/api/events',
    'beacon http://100.125.78.115:50115/dsh-link/peer/mabc/api/beacon',
  ]);
});

test('in the desktop window the requests stay on the app origin, under the mount', async () => {
  const { seen, run } = requestPage('dsh-app://app/dsh-link/peer/mabc/');
  await run(`Promise.all([fetch('/api/remote-agents'), fetch('/dsh-link/attention'), fetch('http://127.0.0.1:5173/api/remote-agents')])`);
  assert.deepEqual(seen, [
    'fetch dsh-app://app/dsh-link/peer/mabc/api/remote-agents',
    'fetch /dsh-link/attention',
    'fetch http://127.0.0.1:5173/api/remote-agents',
  ]);
});

test('the request base cannot be closed by its prefix', () => {
  const html = injectRequestBase(INDEX, '/x</script><script>alert(1)//');
  assert.equal(html.match(/<\/script>/g)!.length, INDEX.match(/<\/script>/g)!.length + 1);
});

/** A framed page under a parent window whose strip height is `bar` ('' when the parent declares none). */
function framedPage(options: { shell?: boolean; framed?: boolean; bar: string }) {
  let bar = options.bar;
  const attributes = new Map<string, string>();
  const style = new Map<string, string>();
  const observers: Array<() => void> = [];
  const parentRoot = {};
  const parent: Record<string, unknown> = {
    document: { documentElement: parentRoot },
    getComputedStyle: (element: unknown) => ({ getPropertyValue: (name: string) => element === parentRoot && name === BAR_HEIGHT ? bar : '' }),
  };
  if (options.shell !== false) parent[SHELL_GLOBAL] = { version: 1 };
  const window: Record<string, unknown> = {};
  window.parent = options.framed === false ? window : parent;
  const document = { documentElement: {
    setAttribute: (name: string, value: string) => { attributes.set(name, value); },
    style: { setProperty: (name: string, value: string) => { style.set(name, value); }, removeProperty: (name: string) => { style.delete(name); } },
  } };
  class MutationObserver {
    constructor(private readonly callback: () => void) {}
    observe(target: unknown, init: { attributes?: boolean }) { if (target === parentRoot && init.attributes) observers.push(this.callback); }
  }
  vm.runInContext(scripts(injectFrameTop(INDEX))[0]!, vm.createContext({ window, document, MutationObserver, parseFloat }));
  return { attributes, style, change(next: string) { bar = next; for (const callback of observers) callback(); } };
}

test('a machine\'s page in a desktop window\'s frame starts below the title strip and follows it', () => {
  const page = framedPage({ bar: ' 28px' });
  assert.equal(page.attributes.get('data-dl-framed'), '');
  assert.equal(page.style.get('--dl-top'), '28px');
  // Full screen: no strip.
  page.change('');
  assert.equal(page.style.has('--dl-top'), false);
  page.change('0px');
  assert.equal(page.style.has('--dl-top'), false);
  page.change('32px');
  assert.equal(page.style.get('--dl-top'), '32px');
  // The page and its overlays are moved by the injected style, keyed on the mark.
  const html = injectFrameTop(INDEX);
  assert.match(html, /html\[data-dl-framed\] body\{box-sizing:border-box;padding-top:var\(--dl-top,0px\)\}/);
  assert.match(html, /--dsh-frame-overlay-top:calc\(var\(--dl-top,0px\) \+ 12px\)/);
});

test('a page that is not in a frame of this plugin\'s shell is left as it is', () => {
  for (const options of [{ framed: false, bar: '28px' }, { shell: false, bar: '28px' }]) {
    const page = framedPage(options);
    assert.equal(page.attributes.size, 0);
    assert.equal(page.style.size, 0);
  }
});

test('the frame offset comes before DSH\'s own scripts in the mounted index', () => {
  const head = mountedIndex(INDEX, 'mabc').html;
  assert.ok(head.indexOf('data-dl-framed') > 0);
  assert.ok(head.indexOf('data-dl-framed') < head.indexOf('./assets/index-'));
  assert.ok(head.indexOf('location.replace("/")') < head.indexOf('data-dl-framed'));
});
