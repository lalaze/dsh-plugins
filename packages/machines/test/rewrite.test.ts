import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { credentialedManifest, guardDesktopBoot, injectOwnsHost, injectStorageNamespace, mountedId, mountedIndex, RAW_STORAGE, selectSession } from '../src/rewrite.js';

const INDEX = readFileSync(new URL('./fixtures/dsh-0.2.2-rc.3-index.html', import.meta.url), 'utf8');
const scripts = (html: string) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]!);

test('the rc.3 index passes every probe, and the namespace runs before the guard and DSH', () => {
  const page = mountedIndex(INDEX, 'mabc');
  assert.deepEqual(page.misses, []);
  assert.match(page.html, /crossorigin="use-credentials"/);
  const head = page.html.slice(page.html.indexOf('<head>'));
  assert.ok(head.indexOf('dsh-machines:mabc:') < head.indexOf('dshDesktopBoot'));
  assert.ok(head.indexOf('dshDesktopBoot') < head.indexOf('./assets/index-'));
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
  assert.equal(real.getItem('dsh-machines:mabc:dsh.sessions.current'), JSON.stringify({ sessionId: 'peer' }));
  assert.equal(page.length, 1);
  assert.equal(page.key(0), 'dsh.sessions.current');
  page.clear();
  assert.equal(real.getItem('dsh.sessions.current'), JSON.stringify({ sessionId: 'own' }));
  assert.equal(window[RAW_STORAGE], real);
  selectSession(real, 'mxyz', 's1');
  selectSession(real, '', 's2');
  assert.equal(real.getItem('dsh-machines:mxyz:dsh.sessions.current'), JSON.stringify({ sessionId: 's1' }));
  assert.equal(real.getItem('dsh.sessions.current'), JSON.stringify({ sessionId: 's2' }));
});

test('in the desktop window the guard rebases the stream under the mount and keeps the boot gate', async () => {
  const seen: unknown[] = [];
  const globalObject: Record<string, unknown> = { URL, dshDesktopBoot: { ready: async () => ({ streamBaseUrl: 'http://127.0.0.1:5173/', rows: [] }) } };
  globalObject.globalThis = globalObject;
  const context = vm.createContext(globalObject);
  const html = injectOwnsHost(guardDesktopBoot(INDEX, '/dsh-machines/peer/mabc').html);
  for (const script of scripts(html).slice(0, 2)) vm.runInContext(script, context);
  // DSH's web entry, in the order 0.2.2's desktop path runs it: its own transport is refused, then it waits on the gate.
  assert.throws(() => vm.runInContext('globalThis.__DSH_TRANSPORT__ = { streamBaseUrl: "http://127.0.0.1:5173/" }', context), /keeps its own boot/);
  await (globalObject.__DSH_BOOT_READY__ as { promise: Promise<void> }).promise;
  seen.push(JSON.parse(JSON.stringify(globalObject.__DSH_TRANSPORT__)));
  assert.deepEqual(seen, [{ ownsHost: true, streamBaseUrl: 'http://127.0.0.1:5173/dsh-machines/peer/mabc/' }]);
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

test('mounted pages are recognised by their path', () => {
  assert.equal(mountedId('/dsh-machines/peer/m0123456789/'), 'm0123456789');
  assert.equal(mountedId('/dsh-machines/peer/m01/api/x'), 'm01');
  assert.equal(mountedId('/'), undefined);
  assert.equal(mountedId('/dsh-machines/peers'), undefined);
});
