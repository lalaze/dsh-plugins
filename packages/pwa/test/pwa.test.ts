import assert from 'node:assert/strict';
import { mkdtemp, rm, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import * as plugin from '../src/index.js';
import type { WebResourceRoute } from '../src/dsh.js';
import {
  createManifestResource,
  DEFAULT_DARK_COLOR,
  discoverManifestPath,
  etagMatches,
  ManifestLoader,
  patchManifest,
} from '../src/index.js';

/** DSH 0.2.2-rc.3's shipped manifest, white colors included. */
const RC3_MANIFEST = {
  name: 'DeepSeek Harness',
  short_name: 'DSH',
  start_url: './',
  scope: './',
  display: 'standalone',
  background_color: '#ffffff',
  theme_color: '#ffffff',
  icons: [
    { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
};

function get(resource: (request: Request) => Promise<Response>, headers: Record<string, string> = {}): Promise<Response> {
  return resource(new Request('http://x/manifest.webmanifest', { headers }));
}

async function touch(path: string, content: string, offsetMs: number): Promise<void> {
  await writeFile(path, content);
  const when = new Date(Date.now() + offsetMs);
  await utimes(path, when, when);
}

test('patchManifest replaces DSH\'s white colors and keeps every other field', () => {
  const upstream = { ...RC3_MANIFEST, id: '/', shortcuts: [{ name: 'New chat', url: './?new=1' }] };

  const patched = patchManifest(upstream);
  assert.equal(patched.theme_color, DEFAULT_DARK_COLOR);
  assert.equal(patched.background_color, DEFAULT_DARK_COLOR);
  assert.equal(patched.display, 'standalone');
  assert.equal(patched.id, '/');
  assert.deepEqual(patched.icons, upstream.icons);
  assert.deepEqual(patched.shortcuts, upstream.shortcuts);
  assert.equal(upstream.theme_color, '#ffffff', 'does not mutate the upstream object');
});

test('patchManifest applies a display override and falls back when color options are blank', () => {
  const patched = patchManifest(RC3_MANIFEST, { themeColor: '   ', backgroundColor: '', display: 'fullscreen' });
  assert.equal(patched.theme_color, DEFAULT_DARK_COLOR);
  assert.equal(patched.background_color, DEFAULT_DARK_COLOR);
  assert.equal(patched.display, 'fullscreen');

  const custom = patchManifest(RC3_MANIFEST, { themeColor: ' #000000 ', backgroundColor: ' #0f1115 ', display: '' });
  assert.equal(custom.theme_color, '#000000');
  assert.equal(custom.background_color, '#0f1115');
  assert.equal(custom.display, 'standalone');
});

test('etagMatches handles exact, weak, multi-value, wildcard and non-matching headers', () => {
  assert.equal(etagMatches('"abc123"', '"abc123"'), true);
  assert.equal(etagMatches('W/"abc123"', '"abc123"'), true);
  assert.equal(etagMatches('"other", W/"abc123"', '"abc123"'), true);
  assert.equal(etagMatches('*', '"abc123"'), true);
  assert.equal(etagMatches('"different"', '"abc123"'), false);
  assert.equal(etagMatches(undefined, '"abc123"'), false);
  assert.equal(etagMatches(null, '"abc123"'), false);
});

test('discoverManifestPath prefers explicit path over frontend-static registry config', () => {
  const registry = {
    values: () => [
      { name: 'other', fibers: [{ config: { distIndex: '/ignored/index.html' } }] },
      { name: 'frontend-static', fibers: [{ config: { distIndex: '/opt/dsh/dist/index.html' } }] },
    ],
  };

  assert.equal(discoverManifestPath(registry, '/custom/manifest.webmanifest', undefined), '/custom/manifest.webmanifest');
  assert.equal(discoverManifestPath(registry, '', undefined), '/opt/dsh/dist/manifest.webmanifest');
  assert.equal(discoverManifestPath({ values: () => [] }, '', undefined), undefined);
});

test('ManifestLoader has no manifest of its own before DSH\'s file has been read', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pwa-missing-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const warnings: string[] = [];

  assert.equal(new ManifestLoader(() => undefined, {}, message => warnings.push(message)).load(), undefined);
  assert.equal(new ManifestLoader(() => join(dir, 'manifest.webmanifest'), {}, message => warnings.push(message)).load(), undefined);
  await writeFile(join(dir, 'broken.webmanifest'), '{not-valid-json');
  assert.equal(new ManifestLoader(() => join(dir, 'broken.webmanifest'), {}, message => warnings.push(message)).load(), undefined);
  await writeFile(join(dir, 'array.webmanifest'), '[]');
  assert.equal(new ManifestLoader(() => join(dir, 'array.webmanifest'), {}, message => warnings.push(message)).load(), undefined);

  assert.equal(warnings.length, 4);
  for (const warning of warnings) assert.match(warning, /DSH keeps serving its own manifest$/);
});

test('manifest resource serves the patched file, answers 304, follows upstream edits and keeps the last good copy', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pwa-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const manifestFile = join(dir, 'manifest.webmanifest');
  await writeFile(manifestFile, JSON.stringify(RC3_MANIFEST));

  const warnings: string[] = [];
  const loader = new ManifestLoader(() => manifestFile, { themeColor: '#151517', backgroundColor: '#151517', display: '' }, message => warnings.push(message));
  const resource = createManifestResource(loader);

  const first = await get(resource);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('content-type'), 'application/manifest+json; charset=utf-8');
  assert.equal(first.headers.get('cache-control'), 'no-cache');
  const etag1 = first.headers.get('etag');
  assert.ok(etag1 && /^"[0-9a-f]{16}"$/.test(etag1));
  const json1 = await first.json() as Record<string, unknown>;
  assert.deepEqual(json1, { ...RC3_MANIFEST, theme_color: '#151517', background_color: '#151517' });

  const notModified = await get(resource, { 'if-none-match': `W/${etag1}` });
  assert.equal(notModified.status, 304);
  assert.equal(notModified.headers.get('etag'), etag1);
  assert.equal(await notModified.text(), '');

  // An upstream edit (e.g. a DSH upgrade) changes the served manifest and its ETag.
  await touch(manifestFile, JSON.stringify({ ...RC3_MANIFEST, name: 'DeepSeek Harness Updated' }), 5_000);
  const updated = await get(resource, { 'if-none-match': etag1 });
  assert.equal(updated.status, 200);
  const etag2 = updated.headers.get('etag');
  assert.notEqual(etag2, etag1);
  const json2 = await updated.json() as Record<string, unknown>;
  assert.equal(json2.name, 'DeepSeek Harness Updated');
  assert.equal(json2.theme_color, '#151517');
  assert.equal(warnings.length, 0);

  // A corrupt or vanished file keeps the last good manifest rather than changing the installed app.
  await touch(manifestFile, '{not-valid-json', 10_000);
  const corrupt1 = await get(resource);
  const corrupt2 = await get(resource);
  assert.equal(corrupt1.status, 200);
  assert.equal(corrupt1.headers.get('etag'), etag2);
  assert.equal((await corrupt1.json() as Record<string, unknown>).name, 'DeepSeek Harness Updated');
  assert.equal(corrupt2.headers.get('etag'), etag2);
  await unlink(manifestFile);
  assert.equal((await get(resource)).headers.get('etag'), etag2);
  assert.equal(warnings.length, 2, 'one warning per distinct problem');
  for (const warning of warnings) assert.match(warning, /keeping the last good manifest$/);
});

function fakeWebServer() {
  const routes = new Map<string, WebResourceRoute>();
  return {
    routes,
    register(route: WebResourceRoute) {
      assert.equal(route.kind, 'exact');
      if (routes.has(route.path)) throw new Error(`duplicate exact route "${route.path}"`);
      routes.set(route.path, route);
      return () => { routes.delete(route.path); };
    },
  };
}

async function writeDist(dir: string, manifest: Record<string, unknown>): Promise<string> {
  const distIndex = join(dir, 'index.html');
  await writeFile(distIndex, '<!doctype html><html><head></head><body></body></html>');
  await writeFile(join(dir, 'manifest.webmanifest'), JSON.stringify(manifest));
  return distIndex;
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test('Cordis: takes over the route from the frontend-static dist and gives it back on dispose', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pwa-cordis-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const distIndex = await writeDist(dir, { ...RC3_MANIFEST, name: 'DSH From Dist' });
  const webServer = fakeWebServer();

  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());

  // Plugin loads cleanly even before webServer exists (e.g. headless profiles).
  const pwaFiber = ctx.plugin(plugin, { themeColor: '#151517', backgroundColor: '#151517', display: '', manifestPath: '' });
  await pwaFiber;
  assert.equal(webServer.routes.size, 0);

  await ctx.plugin({ name: 'frontend-static', apply(_c: Context, _cfg: { distIndex: string }) {} }, { distIndex });
  ctx.provide('webServer', webServer);
  await tick();

  const route = webServer.routes.get('/manifest.webmanifest');
  assert.ok(route, 'exact /manifest.webmanifest route is registered once webServer appears');
  const res = await get(route.resource);
  assert.equal(res.status, 200);
  const manifest = await res.json() as Record<string, unknown>;
  assert.equal(manifest.name, 'DSH From Dist');
  assert.equal(manifest.theme_color, '#151517');
  assert.equal(manifest.background_color, '#151517');
  assert.equal(manifest.display, 'standalone');

  await pwaFiber.dispose();
  assert.equal(webServer.routes.has('/manifest.webmanifest'), false);
});

test('Cordis: leaves the route to DSH until its manifest can be found, then takes it over', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pwa-late-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const distIndex = await writeDist(dir, RC3_MANIFEST);
  const webServer = fakeWebServer();

  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  ctx.provide('webServer', webServer);
  const pwaFiber = ctx.plugin(plugin, { themeColor: '', backgroundColor: '', display: '', manifestPath: '' });
  await pwaFiber;
  await tick();
  assert.equal(webServer.routes.size, 0, 'no route while DSH\'s manifest is unknown');

  // frontend-static starts after this plugin's scope.
  await ctx.plugin({ name: 'frontend-static', apply(_c: Context, _cfg: { distIndex: string }) {} }, { distIndex });
  await tick();
  const route = webServer.routes.get('/manifest.webmanifest');
  assert.ok(route, 'route registered once frontend-static appears');
  assert.equal((await (await get(route.resource)).json() as Record<string, unknown>).theme_color, DEFAULT_DARK_COLOR);

  // Further fiber changes neither re-register nor fail on the duplicate route.
  await ctx.plugin({ name: 'unrelated', apply() {} });
  await tick();
  assert.equal(webServer.routes.size, 1);

  await pwaFiber.dispose();
  assert.equal(webServer.routes.size, 0);
});
