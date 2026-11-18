import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { offerTuiPrompt } from '@dsh-plugins/remote-core/client/tui-prompt.js';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Asset, BatchStatus, MadeInfo, ProjectSource, ScanResult, SourceView } from '../src/domain.js';
import { SOURCE_KINDS } from '../src/domain.js';
import { resetBatches } from '../src/client/batch.js';
import { encodeGif } from '../src/client/gif.js';
import { coloursOf, paletteOf, planSheet, referenceOf, type Pixels } from '../src/client/sprite.js';
import { decodeGif } from './gif-decode.js';
import { i18n, localizePictureError } from '../src/client/i18n.js';
import { BUNDLE_KEY, VIEW_ID, apply, fileAddress } from '../src/client/index.js';
import { resetProjects } from '../src/client/projects.js';
import { resetSources } from '../src/client/sources.js';

test('file addresses encode the session and each part of the path, with an optional line', () => {
  assert.equal(fileAddress('s 1', 'src/a b.ts'), 'dsh-resource://file/session/s%201/src/a%20b.ts');
  assert.equal(fileAddress('s1', 'src/game.ts', 12), 'dsh-resource://file/session/s1/src/game.ts#L12');
});

const asset = (path: string, usage: Asset['usage'], extra: Partial<Asset> = {}): Asset => ({ path, usage, size: 2048, mtimeMs: 1, width: 32, height: 32, refCount: usage === 'unused' ? 0 : 1, ...extra });
const scan = (): ScanResult => ({
  root: 'game', scannedAt: 1, durationMs: 120, codeFiles: 3, truncated: false, retireDir: '_retired',
  assets: [asset('assets/cast-v1/hero.png', 'unused', { family: 'assets/cast', version: 'v1' }), asset('assets/cast-v2/hero.png', 'used', { family: 'assets/cast', version: 'v2', dup: 1 }),
    asset('public/art/hero.gif', 'used', { dup: 1 }), asset('public/art/npc.png', 'maybe')],
  families: [{ id: 'assets/cast', dir: 'assets', name: 'cast', versions: [{ label: 'v1', path: 'assets/cast-v1', total: 1, used: 0, maybe: 0, bytes: 2048 }, { label: 'v2', path: 'assets/cast-v2', total: 1, used: 1, maybe: 0, bytes: 2048 }] }],
  folders: [{ name: 'assets', images: 2, codeFiles: 1, assets: true, code: false }, { name: 'public', images: 2, codeFiles: 0, assets: true, code: true }, { name: 'src', images: 0, codeFiles: 2, assets: true, code: true }],
});

let root: Root | undefined, container: HTMLElement, requests: Record<string, unknown>[], opened: unknown[][];
/** What the simulated host has saved: where the tab appears, and the user's choice per conversation's workspace. */
let saved: { mode: 'games' | 'all'; overrides: Record<string, boolean | null>; down: boolean; retired: string[]; tags: Record<string, string[]>; sources: SourceView[]; defaultId: string | null; written: string[]; failGenerate?: string; project: ProjectSource | null; extra: Asset[]; made: Record<string, MadeInfo>; batchJobs: Record<string, BatchStatus>; failSave: Record<string, string>; h3Polls: Record<string, unknown>[]; files: Record<string, Uint8Array>; h3Picture?: Buffer };
/** A PNG of 1024 × 1024, as an image API answers. */
const GENERATED = (() => { const data = Buffer.alloc(40); data.writeUInt32BE(0x89504e47, 0); data.writeUInt32BE(0x0d0a1a0a, 4); data.writeUInt32BE(13, 8); data.write('IHDR', 12, 'latin1'); data.writeUInt32BE(1024, 16); data.writeUInt32BE(1024, 20); return data; })();
/** The workspace as the simulated host answers it: retired images sit in the retired folder, tags are attached. */
const library = (): ScanResult => {
  const base = scan();
  return { ...base, assets: base.assets.map(a => saved.retired.includes(a.path) ? { path: `_retired/${a.path}`, usage: 'unused' as const, size: a.size, mtimeMs: 1, width: 32, height: 32, refCount: 0, retired: true as const, origin: a.path } : a)
    .map(a => saved.tags[a.path]?.length ? { ...a, tags: saved.tags[a.path] } : a).concat(saved.extra).map(a => saved.made[a.path] ? { ...a, made: saved.made[a.path] } : a) };
};
const globals = ['window', 'document', 'navigator', 'MutationObserver', 'getComputedStyle', 'Node', 'Element', 'HTMLElement', 'Event', 'fetch'] as const;
/** `s1` is a Phaser game, `plain` a website, `broken` has no workspace folder. */
const project = (sessionId: string) => {
  const override = saved.overrides[sessionId] ?? null;
  if (sessionId === 'broken') return { root: null, host: null, engine: null, override: null, game: false, mode: saved.mode };
  if (sessionId === 'remote') return { root: 'app', host: 'Mac mini', engine: 'Godot', override, game: override ?? true, mode: saved.mode };
  return sessionId === 'plain' ? { root: 'site', engine: null, override, game: override ?? false, mode: saved.mode } : { root: 'game', engine: 'Phaser', override, game: override ?? true, mode: saved.mode };
};
beforeEach(() => {
  const { window } = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/', pretendToBeVisual: true });
  requests = []; opened = []; saved = { mode: 'games', overrides: {}, down: false, retired: [], tags: {}, sources: [], defaultId: null, written: [], project: null, extra: [], made: {}, batchJobs: {}, failSave: {}, h3Polls: [], files: {} };
  const fetch = async (url: string, init: { method?: string; body?: string; headers: Record<string, string> }) => {
    assert.equal(init.headers['X-DSH-Game-Assets'], '1');
    if (!init.body) { const path = new URL(url, 'http://localhost/').searchParams.get('path')!; requests.push({ image: path }); return new Response(new Uint8Array(saved.files[path] ?? [1, 2, 3])); }
    const body = JSON.parse(init.body);
    // Thumbnails come in batches; they are kept apart from the requests the tests look at.
    if (body.action === 'images') { requests.push({ image: body.paths }); return Response.json({ images: body.paths.map((path: string) => ({ path, data: 'AQID' })) }); }
    if (saved.down) return Response.json({ error: 'The workspace could not be scanned' }, { status: 500 });
    if (body.action === 'mode') return Response.json({ mode: saved.mode });
    if (body.action === 'project') return Response.json(project(body.sessionId));
    if (body.action === 'h3Status') {
      saved.h3Polls.push(body);
      const current = saved.batchJobs[body.sessionId] ?? null;
      const job = current && (!body.id || current.id === body.id) ? current : null;
      const busy = Object.values(saved.batchJobs).some(other => other.sessionId !== body.sessionId && (other.phase === 'booting' || other.phase === 'drawing' || other.phase === 'stopping'));
      return Response.json({ job, busy });
    }
    requests.push(body);
    if (body.action === 'setMode') { saved.mode = body.mode; return Response.json({ mode: saved.mode }); }
    if (body.action === 'setProject') { saved.overrides[body.sessionId] = body.game; return Response.json(project(body.sessionId)); }
    if (body.action === 'retire') { saved.retired.push(...body.paths.filter((path: string) => path !== 'public/art/npc.png')); return Response.json({ moved: body.paths.length - (body.paths.includes('public/art/npc.png') ? 1 : 0), failed: body.paths.includes('public/art/npc.png') ? [{ path: 'public/art/npc.png', error: 'A file of that name is already there' }] : [], scan: library() }); }
    if (body.action === 'restore') { saved.retired = saved.retired.filter(path => !body.paths.includes(`_retired/${path}`)); return Response.json({ moved: body.paths.length, failed: [], scan: library() }); }
    if (body.action === 'tag') { const tags: Record<string, string[]> = {}; for (const path of body.paths) tags[path] = saved.tags[path] = [...new Set([...(saved.tags[path] ?? []).filter(tag => !body.remove.includes(tag)), ...body.add])]; return Response.json({ tags }); }
    if (body.action === 'note') return Response.json({ note: body.note.trim() });
    const sources = () => ({ sources: saved.sources, defaultId: saved.defaultId });
    if (body.action === 'sources') return Response.json(sources());
    if (body.action === 'saveSource') {
      const { apiKey, ...rest } = body.source, id = rest.id ?? `src-${saved.sources.length + 1}`;
      const index = saved.sources.findIndex(source => source.id === id), next = { ...rest, id, keyHint: apiKey ? `…${apiKey.slice(-4)}` : saved.sources[index]?.keyHint ?? '' };
      saved.sources = index >= 0 ? saved.sources.map(source => source.id === id ? next : source) : [...saved.sources, next];
      saved.defaultId ??= id;
      return Response.json({ ...sources(), id });
    }
    const recorded = () => ({ source: saved.project, files: saved.project ? ['.game-assets/image-source.json', '.game-assets/generate-image.cjs', '.game-assets/README.md', 'AGENTS.md', 'CLAUDE.md'] : [] });
    if (body.action === 'projectSource') return Response.json(recorded());
    if (body.action === 'setProjectSource') {
      const source = saved.sources.find(entry => entry.id === body.sourceId);
      saved.project = source ? { id: source.id, name: source.name, kind: source.kind, model: source.model, baseUrl: source.baseUrl } : null;
      return Response.json(recorded());
    }
    if (body.action === 'defaultSource') { saved.defaultId = body.id; return Response.json(sources()); }
    if (body.action === 'deleteSource') { saved.sources = saved.sources.filter(source => source.id !== body.id); if (saved.defaultId === body.id) saved.defaultId = saved.sources[0]?.id ?? null; return Response.json(sources()); }
    if (body.action === 'generate') {
      if (saved.failGenerate) return Response.json({ error: saved.failGenerate }, { status: 502 });
      const source = saved.sources.find(entry => entry.id === body.sourceId)!;
      return Response.json({ data: GENERATED.toString('base64'), mediaType: 'image/png', width: 1024, height: 1024, model: source.model, source: source.name, ms: 12_400 });
    }
    if (body.action === 'revert') {
      const version = saved.extra.find(a => a.path === body.path)!;
      saved.extra = [...saved.extra.filter(a => a !== version), { ...version, path: `${version.path}.parked.png`, retiredAt: '2026-11-13T11:00:00.000Z' }];
      [saved.made[version.origin!], saved.made[`${version.path}.parked.png`]] = [saved.made[version.path], saved.made[version.origin!]];
      return Response.json({ path: version.origin, retired: `${version.path}.parked.png`, scan: library() });
    }
    if (body.action === 'h3Start') {
      const existing = saved.batchJobs[body.sessionId];
      if (existing && (existing.phase === 'booting' || existing.phase === 'drawing' || existing.phase === 'stopping')) return Response.json(existing);
      const job: BatchStatus = { id: `batch-${Object.keys(saved.batchJobs).length + 1}`, sessionId: body.sessionId, phase: 'booting', startedAt: Date.now(), prompt: body.prompt, items: body.paths.map((path: string) => ({ path, status: 'waiting' as const, ...(body.prepared?.[path] ? { sheet: body.prepared[path].sheet } : {}) })) };
      saved.batchJobs[body.sessionId] = job;
      return Response.json(job);
    }
    if (body.action === 'h3Result') {
      return Response.json({ data: (saved.h3Picture ?? GENERATED).toString('base64'), mediaType: 'image/png', width: 2048, height: 2048, model: 'MiniMax-H3-Image', source: 'h3', ms: 4200 });
    }
    if (body.action === 'h3Stop') {
      const job = saved.batchJobs[body.sessionId]!;
      const stopped: BatchStatus = { ...job, phase: 'stopped', items: job.items.map(item => item.status === 'done' ? item : { ...item, status: 'skipped' as const }) };
      saved.batchJobs[body.sessionId] = stopped;
      return Response.json(stopped);
    }
    if (body.action === 'h3Discard') {
      delete saved.batchJobs[body.sessionId];
      return Response.json({ ok: true });
    }
    if (body.action === 'save') {
      if (saved.failSave[body.path]) return Response.json({ error: saved.failSave[body.path] }, { status: 409 });
      saved.written.push(body.path);
      const updated = asset(body.path, 'unused', { mtimeMs: 2 });
      if (!scan().assets.some(a => a.path === body.path)) saved.extra = [...saved.extra.filter(a => a.path !== body.path), updated];
      const base = library();
      return Response.json({ path: body.path, ...(body.replace ? { retired: `_retired/${body.path}` } : {}), scan: { ...base, assets: [...base.assets.filter(a => a.path !== body.path), updated].sort((a, b) => a.path < b.path ? -1 : 1) } });
    }
    if (body.action === 'detail') return Response.json({ path: body.path, refCount: 1, refs: [{ file: 'src/game.ts', line: 7, kind: 'path', text: "load.image('hero', 'cast-v2/hero.png')" }] });
    if (body.action === 'configure') return Response.json({ ...scan(), scannedAt: 2, assets: scan().assets.map(a => ({ ...a, usage: 'unused', refCount: 0 })), folders: scan().folders.map(f => ({ ...f, ...body.folders[f.name] })) });
    return body.sessionId === 'broken' ? Response.json({ error: 'This conversation has no workspace folder' }, { status: 409 }) : Response.json(library());
  };
  for (const name of globals) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === 'window' ? window : name === 'fetch' ? fetch : (window as unknown as Record<string, unknown>)[name] });
  let urls = 0;
  URL.createObjectURL = () => `blob:test/${++urls}`; URL.revokeObjectURL = () => {};
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.append(container);
});
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined;
  mock.timers.reset(); resetProjects(); resetSources(); resetBatches();
  for (const name of globals) delete (globalThis as Record<string, unknown>)[name];
});
const settle = () => act(async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); });
const click = (element: Element | null | undefined) => act(async () => { assert.ok(element, 'element to click'); (element as HTMLElement).click(); });
const texts = (selector: string) => [...container.querySelectorAll(selector)].map(node => node.textContent);
const sent = () => requests.filter(request => !('image' in request));

interface Entry { spec: Record<string, any>; component: React.FC<any> }
/** A host with slots, a right sidebar and, unless `sessions` is false, a session list whose conversations `inView` are on screen. */
async function host(inView: string[], { language = 'en', sessions = true } = {}) {
  const entries: Entry[] = [], listeners = new Set<() => void>();
  let onScreen = inView;
  const cwds: Record<string, string> = { s1: '/work/game', s2: '/work/game', plain: '/work/site', broken: '', remote: '/home/me/.dsh/remote-workspaces/box/app' };
  const list = {
    getSnapshot: () => ({ ids: Object.keys(cwds), byId: Object.fromEntries(Object.entries(cwds).map(([id, cwd]) => [id, { cwd: cwd || undefined, retainedBy: { mainView: onScreen.includes(id) ? 1 : 0 } }])) }),
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  const locale = { register: () => () => {}, subscribe: () => () => {}, getSnapshot: () => ({ active: language, revision: 0 }) };
  const sidebar = { openResource: (...args: unknown[]) => { opened.push(args); } };
  const services: Record<string, unknown> = { locale, sidebarRight: sidebar, ...(sessions ? { sessions: { list } } : {}) };
  const ctx = {
    get: (name: string) => services[name],
    effect: (factory: () => () => void) => { factory(); },
    inject: (names: string[], factory: (scoped: any) => void) => { if (names.every(name => services[name])) factory(ctx); },
    slots: {
      inject: (_name: string, factory: () => unknown) => factory(),
      register: (spec: Record<string, any>, component: React.FC<any>) => { const entry = { spec, component }; entries.push(entry); return () => { entries.splice(entries.indexOf(entry), 1); }; },
    },
  };
  apply(ctx as never);
  await settle();
  return {
    views: () => entries.filter(entry => entry.spec.name === 'conversation.view'),
    settings: () => entries.find(entry => entry.spec.name === 'plugins.bundle.config')!,
    composer: () => entries.find(entry => entry.spec.name === 'conversation.input.left'),
    show: async (ids: string[]) => { onScreen = ids; await act(async () => { for (const listener of [...listeners]) listener(); }); await settle(); },
  };
}
async function render(component: React.FC<any>, props: Record<string, unknown>) {
  const { createRoot } = await import('react-dom/client');
  root = createRoot(container);
  await act(async () => root!.render(React.createElement(component, props)));
  await settle();
}
/** The Assets view of a conversation, mounted as DSH would beside a game project on screen. */
async function mount(sessionId: string | undefined, language = 'en') {
  const dsh = await host(['s1'], { language });
  const view = dsh.views()[0];
  await render(view.component, { sessionId });
  return { ...dsh, spec: view.spec };
}

test('the plugin adds an Assets view beside Chat that lists the workspace’s images with their verdicts', async () => {
  const { spec } = await mount('s1');
  assert.deepEqual([spec.id, spec.label()], [VIEW_ID, 'Assets']);
  assert.deepEqual(sent()[0], { action: 'scan', sessionId: 's1', refresh: false });
  assert.deepEqual(texts('.ga-chip'), ['All4', 'In use2', 'Maybe1', 'Unreferenced1', 'Duplicates2']);
  assert.deepEqual([...container.querySelectorAll('.ga-cell')].map(cell => [cell.getAttribute('title'), cell.getAttribute('data-usage')]),
    [['assets/cast-v1/hero.png', 'unused'], ['assets/cast-v2/hero.png', 'used'], ['public/art/hero.gif', 'used'], ['public/art/npc.png', 'maybe']]);
  assert.equal(container.querySelectorAll('.ga-cell img').length, 4);
  assert.match(container.querySelector('.ga-status')!.textContent!, /4 images · 8\.0 KB.*References read from 3 files in: src/);
});

test('the view is there only while a conversation on screen belongs to a game project', async () => {
  const dsh = await host(['plain']);
  assert.equal(dsh.views().length, 0);
  await dsh.show(['s1']);
  assert.deepEqual(dsh.views().map(entry => entry.spec.id), [VIEW_ID]);
  // Another conversation of the same game keeps it; a conversation without a workspace, or none at all, releases it.
  await dsh.show(['s2']);
  assert.equal(dsh.views().length, 1);
  await dsh.show(['broken']);
  assert.equal(dsh.views().length, 0);
  await dsh.show(['plain', 's1']);
  assert.equal(dsh.views().length, 1);
  await dsh.show([]);
  assert.equal(dsh.views().length, 0);
  assert.deepEqual(sent(), []);
});

test('beside a game project, another workspace is not scanned until the user asks for it', async () => {
  const dsh = await host(['plain', 's1']);
  await render(dsh.views()[0].component, { sessionId: 'plain' });
  assert.match(container.textContent!, /“site” does not look like a game project/);
  assert.deepEqual(sent(), []);
  await click(container.querySelector('.ga-button'));
  await settle();
  assert.deepEqual(sent(), [{ action: 'setProject', sessionId: 'plain', game: true }, { action: 'scan', sessionId: 'plain', refresh: false }]);
  assert.equal(container.querySelectorAll('.ga-cell').length, 4);
  // The choice is the workspace's: it now shows the tab by itself.
  await dsh.show(['plain']);
  assert.equal(dsh.views().length, 1);
});

test('a workspace can hide the tab, and the settings page chooses per workspace or for every conversation', async () => {
  const dsh = await mount('s1');
  await click(container.querySelector('[aria-label="Folders to scan"]'));
  await click([...container.querySelectorAll('.ga-dialog .ga-button')].find(button => button.textContent === 'Hide tab for this workspace'));
  await settle();
  assert.deepEqual(sent().at(-1), { action: 'setProject', sessionId: 's1', game: false });
  assert.equal(dsh.views().length, 0);

  await act(async () => root!.unmount());
  const settings = dsh.settings();
  assert.equal(settings.spec.key, BUNDLE_KEY);
  await render(settings.component, {});
  assert.deepEqual(texts('.ga-modes label'), ['In game projects only', 'In every conversation']);
  // One row per workspace folder: the conversations of the game share one, and a remote workspace names its machine.
  assert.deepEqual(texts('.ga-wname'), ['gamePhaser project', 'siteNo game engine found', 'app · Mac miniGodot project']);
  assert.deepEqual(texts('.ga-wrow .ga-meta'), ['Tab hidden', 'Tab hidden', 'Tab shown']);
  const choose = (select: HTMLSelectElement, value: string) => act(async () => { select.value = value; select.dispatchEvent(new window.Event('change', { bubbles: true })); });
  await choose(container.querySelectorAll<HTMLSelectElement>('.ga-wrow select')[0], 'auto');
  await settle();
  assert.deepEqual(sent().at(-1), { action: 'setProject', sessionId: 's1', game: null });
  assert.deepEqual(texts('.ga-wrow .ga-meta'), ['Tab shown', 'Tab hidden', 'Tab shown']);
  assert.equal(dsh.views().length, 1);

  await dsh.show(['plain']);
  assert.equal(dsh.views().length, 0);
  await click(container.querySelectorAll('.ga-modes input')[1]);
  await settle();
  assert.deepEqual(sent().at(-1), { action: 'setMode', mode: 'all' });
  assert.equal(dsh.views().length, 1);
});

test('the settings section has a one-line summary', async () => {
  const dsh = await host(['s1']);
  await render(dsh.settings().component, { view: 'summary' });
  assert.equal(container.textContent, 'Where the Assets tab appears and which image APIs draw pictures');
});

test('a host without a session list gets the tab everywhere; one that cannot answer says so in the view', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const blind = await host(['s1'], { sessions: false });
  assert.equal(blind.views().length, 0);
  await act(async () => { mock.timers.tick(3000); });
  assert.equal(blind.views().length, 1);
  mock.timers.reset(); resetProjects();

  saved.down = true;
  const dsh = await host(['s2']);
  assert.equal(dsh.views().length, 0);
  // The view itself, shown for another reason, reports the failure instead of waiting forever.
  const { AssetsPanel } = await import('../src/client/panel.js');
  await render(AssetsPanel, { sessionId: 's2' });
  assert.equal(container.querySelector('[role=alert]')!.textContent, 'The workspace could not be scanned');
});

test('filters narrow the grid, and the folder tree follows them', async () => {
  await mount('s1');
  await click([...container.querySelectorAll('.ga-chip')].find(chip => chip.textContent!.startsWith('Unreferenced')));
  assert.deepEqual([...container.querySelectorAll('.ga-cell')].map(cell => cell.getAttribute('title')), ['assets/cast-v1/hero.png']);
  assert.deepEqual(texts('.ga-tree-row'), ['All folders1', 'assets/cast-v11']);
  await click([...container.querySelectorAll('.ga-chip')][0]);
  await click([...container.querySelectorAll('.ga-tree-label')].find(label => label.textContent === 'public/art'));
  assert.deepEqual([...container.querySelectorAll('.ga-cell')].map(cell => cell.getAttribute('title')), ['public/art/hero.gif', 'public/art/npc.png']);
  assert.deepEqual(texts('.ga-chip'), ['All2', 'In use1', 'Maybe1', 'Unreferenced0', 'Duplicates1']);
});

test('an image’s detail lists its references and same-name files; a reference opens beside the conversation', async () => {
  await mount('s1');
  await click(container.querySelector('.ga-cell[title="assets/cast-v2/hero.png"]'));
  await settle();
  assert.deepEqual(sent().at(-1), { action: 'detail', sessionId: 's1', path: 'assets/cast-v2/hero.png' });
  assert.match(container.querySelector('.ga-facts')!.textContent!, /32 × 32 · 2\.0 KB · PNG · cast v2 \(latest\)/);
  assert.match(container.querySelector('.ga-detail')!.textContent!, /In use.*1 other files have exactly the same bytes/);
  assert.deepEqual(texts('.ga-twin-path'), ['assets/cast-v1/hero.png', 'public/art/hero.gif']);
  assert.deepEqual(texts('.ga-twin .ga-tag'), ['identical']);
  await click(container.querySelector('.ga-link'));
  assert.deepEqual(opened, [['dsh-resource://file/session/s1/src/game.ts#L7', { params: { line: 7 } }]]);
  // Another copy picked here becomes the selection.
  await click(container.querySelector('.ga-twin'));
  assert.equal(container.querySelector('.ga-cell[aria-selected=true]')!.getAttribute('title'), 'assets/cast-v1/hero.png');
});

test('versions are compared side by side, and Show opens a version in the grid', async () => {
  await mount('s1');
  await click([...container.querySelectorAll('.ga-seg button')][1]);
  assert.deepEqual(texts('.ga-family h3'), ['assets/cast']);
  assert.deepEqual(texts('.ga-vrow:not(.ga-vhead) .ga-vlabel'), ['v1no references', 'v2latest']);
  await click(container.querySelector('.ga-vrow[data-dead] .ga-button'));
  assert.deepEqual([...container.querySelectorAll('.ga-cell')].map(cell => cell.getAttribute('title')), ['assets/cast-v1/hero.png']);
});

test('folder settings are sent on Apply and the new scan replaces the old', async () => {
  await mount('s1');
  await click(container.querySelector('[aria-label="Folders to scan"]'));
  const rows = [...container.querySelectorAll('.ga-frow:not(.ga-vhead)')];
  assert.deepEqual(rows.map(row => row.textContent), ['assets 2 1', 'public 2 0', 'src 0 2']);
  await click(rows[2].querySelectorAll('input')[1]);
  await click(container.querySelector('.ga-button[data-primary]'));
  await settle();
  assert.deepEqual(sent().at(-1), { action: 'configure', sessionId: 's1', folders: { assets: { assets: true, code: false }, public: { assets: true, code: true }, src: { assets: true, code: false } } });
  assert.equal(container.querySelector('.ga-dialog'), null);
  assert.deepEqual(texts('.ga-chip').slice(0, 2), ['All4', 'In use0']);
});

test('the view follows DSH’s language and reports why a workspace cannot be shown', async () => {
  await mount('broken', 'zh-CN');
  assert.equal(container.querySelector('[role=alert]')!.textContent, '此对话没有工作区文件夹');
  assert.equal(container.querySelectorAll('.ga-seg button')[0].textContent, '浏览');
});

test('the grid’s thumbnails reach the host as one batch', async () => {
  await mount('s8');
  const batches = requests.filter(request => 'image' in request).map(request => request.image);
  assert.deepEqual(batches, [['public/art/npc.png', 'public/art/hero.gif', 'assets/cast-v2/hero.png', 'assets/cast-v1/hero.png']]);
  assert.equal(container.querySelectorAll('.ga-cell img').length, 4);
});

test('inside DSH’s conversation area, the view takes the height left on screen so its grid scrolls by itself', async () => {
  // DSH's markup: a scrolling area holding the conversation's views and, docked below them, the composer.
  const area = document.createElement('div'), slot = document.createElement('div'), views = document.createElement('div'), seat = document.createElement('div');
  area.setAttribute('data-conversation-scroll', ''); slot.setAttribute('data-slot', 'conversation.session'); seat.setAttribute('data-composer-seat', '');
  slot.append(views); area.append(slot, seat); container.append(area);
  area.scrollTop = 500;
  Object.defineProperty(area, 'clientHeight', { configurable: true, value: 900 });
  Object.defineProperty(seat, 'offsetHeight', { configurable: true, value: 80 });
  area.getBoundingClientRect = () => ({ top: 100, bottom: 1000, left: 0, right: 1200, width: 1200, height: 900, x: 0, y: 100, toJSON() {} }) as DOMRect;
  const before = window.HTMLElement.prototype.getBoundingClientRect;
  window.HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    return (this.classList.contains('ga-root') ? { top: 140, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 140, toJSON() {} } : before.call(this)) as DOMRect;
  };
  try {
    const { AssetsPanel } = await import('../src/client/panel.js');
    const { createRoot } = await import('react-dom/client');
    root = createRoot(views);
    await act(async () => root!.render(React.createElement(AssetsPanel, { sessionId: 's1' })));
    await settle();
    // 900 visible, less the 40 above the view and the 80 of the composer.
    assert.equal(area.scrollTop, 0);
    assert.equal(views.querySelector<HTMLElement>('.ga-root')!.style.height, '780px');
  } finally { window.HTMLElement.prototype.getBoundingClientRect = before; }
});

test('without a conversation there is nothing to scan', async () => {
  await mount(undefined);
  assert.deepEqual(sent(), []);
  assert.match(container.textContent!, /Open a conversation/);
});

const check = (path: string) => click(container.querySelector(`.ga-cell[title="${path}"] .ga-check`));
const typeInto = (input: Element | null | undefined, value: string) => act(async () => {
  assert.ok(input, 'input to type into');
  const setter = Object.getOwnPropertyDescriptor(input instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value); input.dispatchEvent(new window.Event('input', { bubbles: true }));
});
const pick = (select: Element | null, value: string) => act(async () => { assert.ok(select); (select as HTMLSelectElement).value = value; select.dispatchEvent(new window.Event('change', { bubbles: true })); });
const field = (label: string) => [...container.querySelectorAll('.ga-sfield')].find(node => node.firstChild?.textContent === label)?.querySelector('input');
const button = (scope: string, label: string) => [...container.querySelectorAll(`${scope} button`)].find(node => node.textContent === label);
const chip = (label: string) => [...container.querySelectorAll('.ga-chip')].find(node => node.textContent!.startsWith(label));

test('checked images are retired after a warning about the ones still referenced, and restored from the retired list', async () => {
  await mount('s3');
  assert.equal(container.querySelector('.ga-selbar'), null);
  await check('assets/cast-v1/hero.png'); await check('assets/cast-v2/hero.png'); await check('public/art/npc.png');
  assert.match(container.querySelector('.ga-selbar')!.textContent!, /^3 selected/);
  await click(button('.ga-selbar', 'Retire…'));
  assert.match(container.querySelector('.ga-dialog')!.textContent!, /Retire 3 images\?.*“_retired\/”.*1 in use, 1 maybe in use/);
  assert.equal(sent().some(request => request.action === 'retire'), false);
  await click(button('.ga-dialog', 'Retire 3 images'));
  await settle();
  assert.deepEqual(sent().at(-1), { action: 'retire', sessionId: 's3', paths: ['assets/cast-v1/hero.png', 'assets/cast-v2/hero.png', 'public/art/npc.png'] });
  // Two moved; the one that could not is named, and the grid shows the workspace as it is now.
  assert.match(container.querySelector('[role=alert]')!.textContent!, /1 images were left where they are\. public\/art\/npc\.png: A file of that name is already there/);
  assert.equal(container.querySelector('.ga-dialog'), null);
  assert.equal(container.querySelector('.ga-selbar'), null);
  assert.deepEqual([...container.querySelectorAll('.ga-cell')].map(cell => cell.getAttribute('title')), ['public/art/hero.gif', 'public/art/npc.png']);
  assert.deepEqual([chip('All')!.textContent, chip('Retired')!.textContent], ['All2', 'Retired2']);

  await click(chip('Retired'));
  assert.deepEqual([...container.querySelectorAll('.ga-cell')].map(cell => [cell.getAttribute('title'), cell.getAttribute('data-usage')]), [['_retired/assets/cast-v1/hero.png', 'retired'], ['_retired/assets/cast-v2/hero.png', 'retired']]);
  await click(container.querySelector('.ga-cell'));
  assert.match(container.querySelector('.ga-detail .ga-verdict')!.textContent!, /Retired From assets\/cast-v1\/hero\.png\./);
  await click(button('.ga-detail', 'Restore'));
  await settle();
  assert.deepEqual(sent().at(-1), { action: 'restore', sessionId: 's3', paths: ['_retired/assets/cast-v1/hero.png'] });
  await check('_retired/assets/cast-v2/hero.png');
  await click(button('.ga-selbar', 'Restore'));
  await settle();
  assert.deepEqual(sent().at(-1), { action: 'restore', sessionId: 's3', paths: ['_retired/assets/cast-v2/hero.png'] });
  assert.equal(chip('Retired')!.textContent, 'Retired0');
});

test('a whole version is retired from the Versions view; Shift extends a selection and the toolbar selects everything shown', async () => {
  await mount('s4');
  await click([...container.querySelectorAll('.ga-seg button')][1]);
  await click(button('.ga-vrow[data-dead]', 'Retire…'));
  assert.match(container.querySelector('.ga-dialog')!.textContent!, /Retire 1 images\?.*No code in the folders being read refers to any of them/);
  await click(button('.ga-dialog', 'Cancel'));
  await click([...container.querySelectorAll('.ga-seg button')][0]);

  await check('assets/cast-v1/hero.png');
  const last = container.querySelector<HTMLElement>('.ga-cell[title="public/art/hero.gif"] .ga-check')!;
  await act(async () => { last.dispatchEvent(new window.MouseEvent('click', { bubbles: true, shiftKey: true })); });
  assert.match(container.querySelector('.ga-selbar')!.textContent!, /^3 selected/);
  await click(container.querySelector('[aria-label="Select the 4 images shown"]'));
  assert.match(container.querySelector('.ga-selbar')!.textContent!, /^4 selected/);
  await click(container.querySelector('[aria-label="Clear the selection"]'));
  assert.equal(container.querySelector('.ga-selbar'), null);
});

test('tags and a note are saved from the detail pane and for a selection, and tags filter the grid', async () => {
  await mount('s5');
  const type = (input: Element | null, value: string) => act(async () => {
    const setter = Object.getOwnPropertyDescriptor(input instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value); input!.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  const submit = (form: Element | null) => act(async () => { form!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); });
  await click(container.querySelector('.ga-cell[title="public/art/npc.png"]'));
  await type(container.querySelector('.ga-detail .ga-tag-input'), ' npc ');
  await submit(container.querySelector('.ga-detail form'));
  await settle();
  assert.deepEqual(sent().at(-1), { action: 'tag', sessionId: 's5', paths: ['public/art/npc.png'], add: ['npc'], remove: [] });
  assert.deepEqual(texts('.ga-detail .ga-taglist .ga-tag'), ['npc×']);
  assert.equal(container.querySelector('.ga-cell[title="public/art/npc.png"] .ga-tag[data-tone=tag]')!.textContent, 'npc');

  const note = container.querySelector('.ga-detail textarea')!;
  await type(note, 'redraw for winter');
  await act(async () => { note.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true })); });
  await settle();
  assert.deepEqual(sent().at(-1), { action: 'note', sessionId: 's5', path: 'public/art/npc.png', note: 'redraw for winter' });

  await check('assets/cast-v1/hero.png'); await check('public/art/npc.png');
  await click(button('.ga-selbar', 'Tag…'));
  assert.deepEqual(texts('.ga-dialog .ga-tag[data-tone=tag]'), ['npc 1/2×']);
  // A tag only some of them have is offered for the rest.
  assert.deepEqual(texts('.ga-dialog .ga-tag-add'), ['+ npc']);
  await type(container.querySelector('.ga-dialog .ga-search'), 'cast');
  await submit(container.querySelector('.ga-dialog form'));
  await settle();
  assert.deepEqual(sent().at(-1), { action: 'tag', sessionId: 's5', paths: ['assets/cast-v1/hero.png', 'public/art/npc.png'], add: ['cast'], remove: [] });
  await click(container.querySelector('.ga-dialog [aria-label="Remove tag npc"]'));
  await settle();
  assert.deepEqual(sent().at(-1), { action: 'tag', sessionId: 's5', paths: ['assets/cast-v1/hero.png', 'public/art/npc.png'], add: [], remove: ['npc'] });
  await click(button('.ga-dialog', 'Done'));

  const select = container.querySelector<HTMLSelectElement>('[aria-label="Tag"]')!;
  assert.deepEqual([...select.options].map(option => option.textContent), ['All tags', 'cast (2)', 'Untagged']);
  await act(async () => { select.value = 'cast'; select.dispatchEvent(new window.Event('change', { bubbles: true })); });
  assert.deepEqual([...container.querySelectorAll('.ga-cell')].map(cell => cell.getAttribute('title')), ['assets/cast-v1/hero.png', 'public/art/npc.png']);
  // The search looks in tags and notes too.
  await act(async () => { select.value = ''; select.dispatchEvent(new window.Event('change', { bubbles: true })); });
  await type(container.querySelector('.ga-bar .ga-search'), 'winter');
  assert.deepEqual([...container.querySelectorAll('.ga-cell')].map(cell => cell.getAttribute('title')), ['public/art/npc.png']);
});

test('a selection is handed to the agent through the chat input, after what the user already typed', async () => {
  const dsh = await mount('s6');
  const drafts: string[] = [];
  // DSH mounts the composer's entries with the draft setter; the bridge renders nothing.
  const { createRoot } = await import('react-dom/client');
  const composer = document.createElement('div'); document.body.append(composer);
  const composerRoot = createRoot(composer);
  await act(async () => composerRoot.render(React.createElement(dsh.composer()!.component, { sessionId: 's6', inputActions: { setDraft: (text: string) => { drafts.push(text); } }, useInput: (select: (state: { draft: string }) => unknown) => select({ draft: 'While you are at it:  ' }) })));
  assert.equal(composer.textContent, '');

  await check('assets/cast-v1/hero.png');
  await click(button('.ga-selbar', 'Ask the agent…'));
  assert.match(container.querySelector<HTMLTextAreaElement>('.ga-dialog textarea')!.value, /^Check that the game no longer loads/);
  await click(button('.ga-dialog', 'Where are they used'));
  await click(button('.ga-dialog', 'Put in chat input'));
  await settle();
  assert.deepEqual(drafts, ['While you are at it:\n\nFor each of these images, find where the game loads it and say whether it is still needed.\n\n- assets/cast-v1/hero.png']);
  assert.equal(container.querySelector('.ga-dialog'), null);
  assert.match(container.querySelector('.ga-status')!.textContent!, /^Added to the chat input/);
  // Nothing was sent or changed on the host: the request only sits in the input.
  assert.deepEqual(sent().map(request => request.action), ['scan']);
  await act(async () => composerRoot.unmount());
});

test('in a TUI conversation the request is typed at the CLI’s prompt, as the composer there is hidden under the terminal', async () => {
  const dsh = await mount('s8');
  const drafts: string[] = [], pasted: string[][] = [], copied: string[] = [];
  let takes = true;
  // dsh-remote-terminals offers the prompt of its TUI conversations through the page.
  offerTuiPrompt({ has: sessionId => sessionId === 's8', paste: async (sessionId, text) => { pasted.push([sessionId, text]); return takes; } });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { copied.push(text); } } });
  // DSH keeps the composer mounted, and it would take a draft nobody could see.
  const { createRoot } = await import('react-dom/client');
  const composer = document.createElement('div'); document.body.append(composer);
  const composerRoot = createRoot(composer);
  await act(async () => composerRoot.render(React.createElement(dsh.composer()!.component, { sessionId: 's8', inputActions: { setDraft: (text: string) => { drafts.push(text); } }, useInput: (select: (state: { draft: string }) => unknown) => select({ draft: '' }) })));

  await check('assets/cast-v1/hero.png');
  await click(button('.ga-selbar', 'Ask the agent…'));
  await click(button('.ga-dialog', 'Redraw'));
  await click(button('.ga-dialog', 'Put in chat input'));
  await settle();
  assert.deepEqual(pasted, [['s8', 'Redraw these images in the project’s current art style. Keep each file’s name, pixel size and transparency.\n\n- assets/cast-v1/hero.png']]);
  assert.deepEqual(drafts, []);
  assert.match(container.querySelector('.ga-status')!.textContent!, /^Added to the chat input/);

  // A terminal that could not take it in time leaves the request on the clipboard, as a host without a composer does.
  takes = false;
  await click(button('.ga-selbar', 'Ask the agent…'));
  await click(button('.ga-dialog', 'Put in chat input'));
  await settle();
  assert.equal(pasted.length, 2);
  assert.deepEqual([copied.length, drafts.length], [1, 0]);
  assert.match(container.querySelector('.ga-status')!.textContent!, /^Copied\. Paste it into the chat input\./);
  await act(async () => composerRoot.unmount());
});

test('without a composer to take it, the request is copied instead', async () => {
  await mount('s7');
  const copied: string[] = [];
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { copied.push(text); } } });
  await check('public/art/hero.gif');
  await click(button('.ga-selbar', 'Ask the agent…'));
  mock.timers.enable({ apis: ['setTimeout'] });
  await click(button('.ga-dialog', 'Put in chat input'));
  await act(async () => { mock.timers.tick(2000); });
  await settle();
  assert.equal(copied.length, 1);
  assert.match(copied[0], /^For each of these images.*\n\n- public\/art\/hero\.gif$/s);
  assert.match(container.querySelector('.ga-status')!.textContent!, /^Copied\. Paste it into the chat input\./);
});

test('Redraw asks for an image source first, then generates from the image and saves the picture beside it', async () => {
  await mount('s1');
  await click(container.querySelector('.ga-cell[title="public/art/npc.png"]'));
  await click(button('.ga-detail', 'Redraw…'));
  await settle();
  assert.equal(container.querySelector('.ga-dialog h3')!.textContent, 'Redraw npc.png');
  assert.match(container.querySelector('.ga-dialog')!.textContent!, /No image source yet/);
  // A new source starts as Codex, which has no address or key; switching kind brings the others' addresses and models.
  const kind = (label: string) => click([...container.querySelectorAll('.ga-sform label')].find(node => node.textContent === label)!.querySelector('input'));
  assert.deepEqual([field('Name')!.value, field('Model')!.value, field('Model')!.placeholder, field('Address'), field('API key')], ['Codex', '', 'Codex’s default', undefined, undefined]);
  await kind('OpenAI compatible');
  assert.deepEqual([field('Name')!.value, field('Address')!.value, field('Model')!.value], ['OpenAI compatible', 'https://api.openai.com/v1', 'gpt-image-2']);
  await kind('Gemini');
  assert.deepEqual([field('Name')!.value, field('Model')!.value], ['Gemini', 'gemini-3.1-flash-image']);
  await kind('OpenAI compatible');
  await typeInto(field('Name'), 'Relay');
  await typeInto(field('Address'), 'https://relay.example/v1');
  await typeInto(field('API key'), 'sk-test-5678');
  await act(async () => { container.querySelector('.ga-sform')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); });
  await settle();
  assert.deepEqual(sent().find(request => request.action === 'saveSource'), { action: 'saveSource', source: { name: 'Relay', kind: 'openai', baseUrl: 'https://relay.example/v1', model: 'gpt-image-2', apiKey: 'sk-test-5678' } });

  // The image is the reference; a small square sprite asks for a square picture on a transparent background.
  assert.deepEqual(texts('.ga-dialog .ga-refpic .ga-twin-path'), ['npc.png']);
  assert.equal((container.querySelector('.ga-dialog select') as HTMLSelectElement).value, 'src-1');
  assert.equal(container.querySelector('.ga-seg [aria-checked=true]')!.textContent, 'Square');
  assert.equal((container.querySelector('.ga-check-label input') as HTMLInputElement).checked, true);
  assert.equal(sent().some(request => request.action === 'generate'), false, 'nothing is generated until asked');
  await click(button('.ga-dialog', 'Generate'));
  await settle();
  assert.deepEqual(sent().find(request => request.action === 'generate'), { action: 'generate', sessionId: 's1', sourceId: 'src-1', prompt: 'Redraw this image in the same art style. Keep the subject, the pose and the framing.', references: ['public/art/npc.png'], aspect: 'square', transparent: true });
  assert.deepEqual(texts('.ga-compare figcaption'), ['Now · 32 × 32', 'New · 1024 × 1024 → 32 × 32']);
  assert.match(container.querySelector('.ga-dialog')!.textContent!, /From Relay · gpt-image-2 in 12 s/);
  assert.equal((container.querySelector('select[aria-label=Size]') as HTMLSelectElement).value, 'pixel', 'a small sprite keeps its pixels sharp');
  assert.equal((container.querySelector('input[aria-label="Save as"]') as HTMLInputElement).value, 'public/art/npc-redraw.png');

  // Kept at the API's size, the picture is sent as it came.
  await pick(container.querySelector('select[aria-label=Size]'), 'none');
  await click(button('.ga-dialog', 'Save as new file'));
  await settle();
  const save = sent().find(request => request.action === 'save')!;
  assert.deepEqual([save.path, save.replace, Buffer.from(save.data as string, 'base64').equals(GENERATED)], ['public/art/npc-redraw.png', false, true]);
  assert.equal(container.querySelector('.ga-dialog'), null);
  assert.equal(container.querySelector('.ga-cell[aria-selected=true]')!.getAttribute('title'), 'public/art/npc-redraw.png');
  assert.equal(container.querySelector('.ga-status')!.textContent!.startsWith('Saved public/art/npc-redraw.png'), true);
});

test('a picture can replace the image it was drawn for; failures and GIF references are explained', async () => {
  saved.sources = [{ id: 'a', name: 'Relay', kind: 'openai', baseUrl: 'https://relay.example/v1', model: 'gpt-image-2', keyHint: '…1234' }, { id: 'g', name: 'Google', kind: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-3.1-flash-image', keyHint: '' }];
  saved.defaultId = 'g';
  await mount('s1');
  // A selection of two, one of them a GIF: the PNG goes as a reference and nothing is offered for replacing.
  await check('public/art/hero.gif'); await check('public/art/npc.png');
  await click(button('.ga-selbar', 'Generate…'));
  await settle();
  assert.equal(container.querySelector('.ga-dialog h3')!.textContent, 'Generate a picture');
  assert.deepEqual(texts('.ga-refpic .ga-twin-path'), ['npc.png']);
  // Gemini, the default, cannot make transparent pictures.
  assert.equal((container.querySelector('.ga-dialog select') as HTMLSelectElement).value, 'g');
  assert.equal((container.querySelector('.ga-check-label input') as HTMLInputElement).disabled, true);
  await typeInto(container.querySelector('.ga-dialog textarea'), 'A wizard cat');
  saved.failGenerate = 'Google refused the request (429): Resource has been exhausted';
  await click(button('.ga-dialog', 'Generate'));
  await settle();
  assert.equal(container.querySelector('.ga-dialog [role=alert]')!.textContent, 'Google refused the request (429): Resource has been exhausted');
  saved.failGenerate = undefined;
  await click(button('.ga-dialog', 'Generate'));
  await settle();
  assert.equal(sent().filter(request => request.action === 'generate').at(-1)!.transparent, false);
  assert.equal(button('.ga-dialog', 'Replace the image'), undefined);
  assert.equal((container.querySelector('input[aria-label="Save as"]') as HTMLInputElement).value, 'public/art/generated.png');
  await click(button('.ga-dialog', 'Discard'));
  assert.equal(container.querySelector('.ga-dialog'), null);

  // One image of the detail pane is replaced in place; the notice says where the old one went.
  await click(container.querySelector('.ga-cell[title="assets/cast-v2/hero.png"]'));
  await click(button('.ga-detail', 'Redraw…'));
  await settle();
  await pick(container.querySelector('.ga-dialog select'), 'a');
  await click(button('.ga-dialog', 'Generate'));
  await settle();
  assert.match(container.querySelector('.ga-dialog')!.textContent!, /retires the current image to “_retired\/” first/);
  await pick(container.querySelector('select[aria-label=Size]'), 'none');
  await click(button('.ga-dialog', 'Replace the image'));
  await settle();
  const save = sent().filter(request => request.action === 'save').at(-1)!;
  assert.deepEqual([save.path, save.replace], ['assets/cast-v2/hero.png', true]);
  assert.equal(container.querySelector('.ga-status')!.textContent!.startsWith('Replaced assets/cast-v2/hero.png; the old one is under Earlier versions'), true);
  assert.deepEqual(save.made, { source: 'Relay', model: 'gpt-image-2', prompt: 'Redraw this image in the same art style. Keep the subject, the pose and the framing.' });
});

test('the settings page lists image sources without their keys, and sets the default, edits and removes them', async () => {
  saved.sources = [{ id: 'a', name: 'Relay', kind: 'openai', baseUrl: 'https://relay.example/v1', model: 'gpt-image-2', keyHint: '…1234' }, { id: 'g', name: 'Google', kind: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-3.1-flash-image', keyHint: '' }];
  saved.defaultId = 'a';
  const dsh = await host(['s1'], { language: 'zh' });
  await render(dsh.settings().component, {});
  assert.deepEqual(texts('.ga-srow .ga-wname > span'), ['OpenAI 兼容 · gpt-image-2 · relay.example · 密钥 …1234', 'Gemini · gemini-3.1-flash-image · generativelanguage.googleapis.com · 无密钥']);
  assert.deepEqual(texts('.ga-srow b'), ['Relay默认', 'Google']);
  await click(button('.ga-srow:nth-child(2)', '设为默认'));
  await settle();
  assert.deepEqual(sent().at(-1), { action: 'defaultSource', id: 'g' });
  // Editing keeps the key unless one is typed.
  await click(button('.ga-srow:nth-child(1)', '编辑'));
  assert.equal(field('API 密钥')!.placeholder, '已保存（…1234），留空则不变');
  await typeInto(field('模型'), 'gpt-image-1.5');
  await act(async () => { container.querySelector('.ga-sform')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); });
  await settle();
  assert.deepEqual(sent().at(-1), { action: 'saveSource', source: { id: 'a', name: 'Relay', kind: 'openai', baseUrl: 'https://relay.example/v1', model: 'gpt-image-1.5' } });
  // Removing asks once more.
  await click(button('.ga-srow:nth-child(2)', '删除'));
  assert.equal(sent().at(-1)!.action, 'saveSource');
  await click(button('.ga-srow:nth-child(2)', '确认删除'));
  await settle();
  assert.deepEqual(sent().at(-1), { action: 'deleteSource', id: 'g' });
  assert.deepEqual(texts('.ga-srow b'), ['Relay默认']);
});

test('the generate dialog records a source in the project for its agents, picks the recorded one first, and removes it again', async () => {
  saved.sources = [{ id: 'a', name: 'Relay', kind: 'openai', baseUrl: 'https://relay.example/v1', model: 'gpt-image-2', keyHint: '…1234' }, { id: 'c', name: 'Codex', kind: 'codex', baseUrl: '', model: '', keyHint: '' }];
  saved.defaultId = 'a';
  await mount('s1');
  await click(container.querySelector('[aria-label="Generate a new picture…"]'));
  await settle();
  const row = () => container.querySelector('.ga-project')!.textContent;
  assert.equal(row(), 'Agents in this project cannot generate images yet.Let them use “Relay”');
  assert.match(container.querySelector('.ga-dialog')!.textContent!, /This writes \.game-assets\/ \(the source without its key, and a script agents run\) and a short section in AGENTS\.md and CLAUDE\.md\. The key is saved on the machine the project is on/);
  // Codex is listed by name only, as it has no model of its own here; choosing it changes what the note says.
  assert.deepEqual(texts('.ga-dialog select[aria-label=Source] option'), ['Relay · gpt-image-2', 'Codex']);
  await pick(container.querySelector('.ga-dialog select[aria-label=Source]'), 'c');
  assert.match(container.querySelector('.ga-dialog')!.textContent!, /Agents use the Codex signed in on the machine the project is on\./);
  await click(button('.ga-project', 'Let them use “Codex”'));
  await settle();
  assert.deepEqual(sent().filter(request => request.action === 'setProjectSource'), [{ action: 'setProjectSource', sessionId: 's1', sourceId: 'c' }]);
  assert.equal(row(), 'Agents in this project generate images with “Codex”.Write it againRemove from the project');
  await click(button('.ga-dialog', 'Cancel'));

  // Opened again, the dialog starts on the source the project records, not the default.
  await click(container.querySelector('[aria-label="Generate a new picture…"]'));
  await settle();
  assert.equal((container.querySelector('.ga-dialog select[aria-label=Source]') as HTMLSelectElement).value, 'c');
  await pick(container.querySelector('.ga-dialog select[aria-label=Source]'), 'a');
  assert.equal(row(), 'Agents in this project generate images with “Codex”.Switch them to “Relay”Remove from the project');
  await click(button('.ga-project', 'Remove from the project'));
  await settle();
  assert.deepEqual(sent().filter(request => request.action === 'setProjectSource').at(-1), { action: 'setProjectSource', sessionId: 's1', sourceId: null });
  assert.equal(row(), 'Agents in this project cannot generate images yet.Let them use “Relay”');
});

test('a Codex source is added with a name only', async () => {
  const dsh = await host(['s1']);
  await render(dsh.settings().component, {});
  await click(button('.ga-sources', 'Add image source'));
  await act(async () => { container.querySelector('.ga-sform')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); });
  await settle();
  assert.deepEqual(sent().at(-1), { action: 'saveSource', source: { name: 'Codex', kind: 'codex', model: '', baseUrl: '' } });
  assert.deepEqual(texts('.ga-srow .ga-wname > span'), ['Codex · Codex’s default · signed in on the workspace’s machine']);
});

test('an image lists its earlier versions with where each came from, and goes back to one in a click', async () => {
  const at = (hour: number) => `2026-11-13T${String(hour).padStart(2, '0')}:00:00.000Z`;
  saved.extra = [
    asset('_retired/public/art/npc.png', 'unused', { retired: true, origin: 'public/art/npc.png', retiredAt: at(9) }),
    asset('_retired/public/art/npc.2.png', 'unused', { retired: true, origin: 'public/art/npc.png', retiredAt: at(10) }),
  ];
  saved.made = { 'public/art/npc.png': { at: at(10), source: 'Relay', model: 'gpt-image-2', prompt: 'a green npc' }, '_retired/public/art/npc.png': { at: at(8), source: 'Codex', prompt: 'an older npc', by: 'agent' } };
  await mount('history');
  await click(container.querySelector('.ga-cell[title="public/art/npc.png"]'));
  await settle();
  assert.match(container.querySelector('.ga-made')!.textContent!, /^Made with Relay · gpt-image-2 · .+a green npc$/);
  assert.equal(container.querySelector('.ga-detail h4:has(+ .ga-history)')!.textContent, 'Earlier versions 2');
  // Newest first: the one retired at ten, which was not generated here, then the agent's at nine.
  assert.deepEqual([...container.querySelectorAll('.ga-history li')].map(row => [row.querySelector('.ga-twin')!.getAttribute('title'), row.querySelector('.ga-meta')!.textContent]),
    [['_retired/public/art/npc.2.png', 'Not generated here · 32×32'], ['_retired/public/art/npc.png', 'Made by an agent with Codex · 32×32']]);

  await click(container.querySelectorAll('.ga-history li')[1].querySelector('.ga-button'));
  await settle();
  assert.deepEqual(sent().at(-1), { action: 'revert', sessionId: 'history', path: '_retired/public/art/npc.png' });
  assert.equal(container.querySelector('.ga-status')!.textContent!.startsWith('Back to an earlier version of public/art/npc.png; the one it replaced is under Earlier versions'), true);
  assert.equal(container.querySelector('.ga-cell[aria-selected=true]')!.getAttribute('title'), 'public/art/npc.png');
  assert.match(container.querySelector('.ga-made')!.textContent!, /^Made by an agent with Codex · .+an older npc$/);

  // A retired version opened on its own offers the same, as its place is taken.
  await click(container.querySelector('.ga-history .ga-twin'));
  await settle();
  assert.equal(button('.ga-detail', 'Restore'), undefined);
  const opened = container.querySelector('.ga-cell[aria-selected=true]')!.getAttribute('title')!;
  await click(button('.ga-detail', 'Go back to this version'));
  await settle();
  assert.deepEqual(sent().filter(request => request.action === 'revert').at(-1), { action: 'revert', sessionId: 'history', path: opened });
});

test('batch redraw with h3 warns and requires confirmation under 4 images, and skips the warning when 4 or more are selected', async () => {
  assert.deepEqual(SOURCE_KINDS, ['codex', 'openai', 'gemini']);
  saved.extra = [asset('public/art/slime.png', 'unused'), asset('public/art/coin.png', 'unused')];
  await mount('batch-select');

  // A GIF alone is offered too: the page sends it as a sprite sheet.
  await check('public/art/hero.gif');
  assert.ok(button('.ga-selbar', 'Batch redraw with h3…'));
  await check('assets/cast-v1/hero.png');
  await check('public/art/npc.png');

  await click(button('.ga-selbar', 'Batch redraw with h3…'));
  await settle();
  // The GIF is listed with a note on how it goes; 3 images (< 4) trigger the cost warning and require checking confirmation.
  assert.deepEqual(texts('.ga-dialog .ga-refpic .ga-twin-path'), ['hero.png', 'hero.gif', 'npc.png']);
  assert.doesNotMatch(container.querySelector('.ga-dialog')!.textContent!, /left out/);
  assert.match(container.querySelector('.ga-dialog')!.textContent!, /GIF and see-through images go as sprite sheets/);
  assert.match(container.querySelector('.ga-dialog [data-tone=warn]')!.textContent!, /Fewer than 4 images is not cost-effective/);
  const startSmall = button('.ga-dialog', 'Still boot and redraw 3 images') as HTMLButtonElement;
  assert.equal(startSmall.disabled, true);
  await click(container.querySelector('.ga-dialog .ga-check-label input'));
  assert.equal(startSmall.disabled, false);
  await click(button('.ga-dialog', 'Cancel'));

  // With 4 PNGs and the GIF there is no small-batch warning. A browser that cannot read pixels cannot send the GIF.
  await check('assets/cast-v2/hero.png');
  await check('public/art/slime.png');
  await click(button('.ga-selbar', 'Batch redraw with h3…'));
  await settle();
  assert.equal(container.querySelector('.ga-dialog [data-tone=warn]'), null);
  assert.equal(container.querySelector('.ga-dialog .ga-check-label input'), null);
  await typeInto(container.querySelector('.ga-dialog textarea'), 'repaint with warm lighting');
  await click(button('.ga-dialog', 'Boot and redraw 5 images'));
  await settle();
  assert.match(container.querySelector('.ga-dialog [data-tone=error]')!.textContent!, /This browser cannot prepare GIF images for h3/);
  assert.equal(sent().filter(request => request.action === 'h3Start').length, 0);
  await click(container.querySelector('.ga-dialog .ga-refpic[title="public/art/hero.gif"] button'));
  const startFour = button('.ga-dialog', 'Boot and redraw 4 images') as HTMLButtonElement;
  assert.equal(startFour.disabled, false);
  await click(startFour);
  await settle();
  assert.deepEqual(sent().find(request => request.action === 'h3Start'), {
    action: 'h3Start',
    sessionId: 'batch-select',
    paths: ['assets/cast-v1/hero.png', 'assets/cast-v2/hero.png', 'public/art/npc.png', 'public/art/slime.png'],
    prompt: 'repaint with warm lighting',
  });
});

/** Pixels in a made-up format the fake canvas below writes and reads, so the page's own pixel code runs in jsdom. */
const FAKE = Buffer.from('FAKE');
const fakeFile = (pixels: Pixels) => Buffer.concat([FAKE, Buffer.from([pixels.width & 0xff, pixels.width >> 8, pixels.height & 0xff, pixels.height >> 8]), Buffer.from(pixels.data)]);
function pixelsOfFile(bytes: Uint8Array): Pixels {
  if (Buffer.from(bytes.subarray(0, 4)).equals(FAKE)) return { width: bytes[4] | (bytes[5] << 8), height: bytes[6] | (bytes[7] << 8), data: new Uint8ClampedArray(bytes.subarray(8)) };
  const gif = decodeGif(bytes), data = new Uint8ClampedArray(gif.width * gif.height * 4);
  gif.indices.forEach((index, i) => {
    if (index === gif.transparent) return;
    const colour = gif.palette[index];
    data.set([colour >> 16, (colour >> 8) & 0xff, colour & 0xff, 255], i * 4);
  });
  return { width: gif.width, height: gif.height, data };
}
/** A canvas that only copies pixels, enough for reading a picture whole and writing pixels back. */
function fakeCanvas() {
  type Canvas = HTMLCanvasElement & { pixels?: Pixels };
  const prototype = (container.ownerDocument.defaultView as unknown as { HTMLCanvasElement: { prototype: Canvas } }).HTMLCanvasElement.prototype;
  prototype.getContext = function (this: Canvas) {
    const canvas = this;
    return {
      drawImage(bitmap: { pixels: Pixels }) { canvas.pixels = { ...bitmap.pixels, data: new Uint8ClampedArray(bitmap.pixels.data) }; },
      getImageData: () => ({ data: canvas.pixels!.data }),
      createImageData: (width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) }),
      putImageData(image: { data: Uint8ClampedArray }) { canvas.pixels = { width: canvas.width, height: canvas.height, data: image.data }; },
    } as unknown as CanvasRenderingContext2D;
  } as unknown as Canvas['getContext'];
  prototype.toBlob = function (this: Canvas, done: BlobCallback, type?: string) { done(new Blob([fakeFile(this.pixels!)], { type: type ?? 'image/png' }) as unknown as globalThis.Blob); };
  (globalThis as Record<string, unknown>).createImageBitmap = async (blob: Blob) => {
    const pixels = pixelsOfFile(new Uint8Array(await blob.arrayBuffer()));
    return { width: pixels.width, height: pixels.height, pixels, close() {} };
  };
}
/** The reference at another scale by nearest neighbour, as a perfect h3 would draw it back. */
function enlarged(pixels: Pixels, factor: number): Pixels {
  const width = Math.round(pixels.width * factor), height = Math.round(pixels.height * factor), data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const from = (Math.floor(((y + 0.5) * pixels.height) / height) * pixels.width + Math.floor(((x + 0.5) * pixels.width) / width)) * 4;
    data.set(pixels.data.subarray(from, from + 4), (y * width + x) * 4);
  }
  return { width, height, data };
}

test('while h3 waits for a free GPU the banner and dialog say so, and name the GPU once it is assigned', async () => {
  saved.batchJobs.gpu = { id: 'job-gpu', sessionId: 'gpu', phase: 'booting', startedAt: Date.now() - 95_000, prompt: 'redraw',
    items: [{ path: 'public/art/npc.png', status: 'waiting' }], boot: { gpus: ['A100', 'G4'], round: 3, waitedMinutes: 1, busy: true } };
  await mount('gpu');
  assert.match(container.querySelector('.ga-batch-bar')!.textContent!, /h3 batch redraw: waiting for a free GPU · 1 images/);
  await click(button('.ga-batch-bar', 'Open'));
  await settle();
  assert.match(container.querySelector('.ga-dialog [role=status]')!.textContent!, /^No A100 → G4 free yet; h3 asks again every 30 s for up to 10 min, nothing is billed meanwhile · round 3, 1m 3\ds$/);
  await act(async () => root?.unmount()); root = undefined;
  saved.batchJobs.gpu = { ...saved.batchJobs.gpu, boot: { gpus: ['A100', 'G4'], round: 3, busy: true, gpu: 'G4', since: Date.now() - 20_000 } };
  await mount('gpu', 'zh-CN');
  assert.match(container.querySelector('.ga-batch-bar')!.textContent!, /h3 批量重绘：正在开机/);
  await click(button('.ga-batch-bar', '打开'));
  await settle();
  assert.match(container.querySelector('.ga-dialog [role=status]')!.textContent!, /^已拿到 G4，正在安装和启动 h3… 2\d 秒（约 11 分钟）$/);
});

test('a GIF sprite goes to h3 as a keyed PNG sheet and is saved back as a see-through GIF at its own size and colours', async () => {
  fakeCanvas();
  try {
    // A 6 × 2 GIF sprite with three colours around see-through pixels; index 3 is see-through.
    const indices = Uint8Array.from([3, 0, 0, 3, 1, 1, 3, 2, 2, 3, 0, 3]), colours = [0xc0392b, 0x5a3a29, 0xf2c49b];
    saved.files['public/art/hero.gif'] = encodeGif(6, 2, indices, [...colours, 0], 3);
    const sprite = pixelsOfFile(saved.files['public/art/hero.gif']);
    const opaque = { width: 2, height: 2, data: Uint8ClampedArray.from({ length: 16 }, (_, i) => i % 4 === 3 ? 255 : 200) };
    const ghost = { width: 2, height: 2, data: Uint8ClampedArray.from([9, 9, 9, 255, 0, 0, 0, 0, 9, 9, 9, 255, 9, 9, 9, 255]) };
    saved.files['assets/cast-v1/hero.png'] = fakeFile(opaque);
    saved.files['assets/cast-v2/hero.png'] = fakeFile(opaque);
    saved.files['public/art/npc.png'] = fakeFile(ghost);
    await mount('sprite');
    for (const path of ['public/art/hero.gif', 'assets/cast-v1/hero.png', 'assets/cast-v2/hero.png', 'public/art/npc.png']) await check(path);
    await click(button('.ga-selbar', 'Batch redraw with h3…'));
    await settle();
    await click(button('.ga-dialog', 'Boot and redraw 4 images'));
    await settle();

    // The GIF and the see-through PNG go as sheets; the opaque PNGs go as they are.
    const start = sent().find(request => request.action === 'h3Start') as { paths: string[]; prepared: Record<string, { data: string; sheet: { key: string; bands: number; gutter: number } }> };
    assert.deepEqual(Object.keys(start.prepared).sort(), ['public/art/hero.gif', 'public/art/npc.png']);
    const sheet = start.prepared['public/art/hero.gif'].sheet;
    assert.deepEqual(sheet, planSheet(sprite));
    assert.deepEqual(sheet, { key: '#00ffff', bands: 1, gutter: 0 });
    const reference = pixelsOfFile(Buffer.from(start.prepared['public/art/hero.gif'].data, 'base64'));
    assert.deepEqual([reference.width, reference.height, [...reference.data]], [referenceOf(sprite, sheet).width, referenceOf(sprite, sheet).height, [...referenceOf(sprite, sheet).data]]);

    // h3 drew the sheet back at a non-whole scale; the batch is done.
    saved.h3Picture = fakeFile(enlarged(reference, 2048 / reference.width * 1.37));
    saved.batchJobs.sprite = { ...saved.batchJobs.sprite, phase: 'done', items: saved.batchJobs.sprite.items.map(item => ({ ...item, status: 'done' as const, width: 2048, height: 683 })) };
    await act(async () => root?.unmount()); root = undefined;
    await mount('sprite');
    await click(button('.ga-batch-bar', 'Open'));
    await settle();
    const row = '.ga-batch-item[data-path="public/art/hero.gif"]';
    assert.match(container.querySelector(`${row} .ga-compare`)!.textContent!, /background removed/);
    assert.ok(container.querySelector('.ga-dialog .ga-check-label input'), 'sprites offer keeping their colours');
    await click(button(row, 'Replace'));
    await settle();

    const save = sent().filter(request => request.action === 'save').at(-1) as { path: string; data: string; replace: boolean };
    assert.deepEqual([save.path, save.replace], ['public/art/hero.gif', true]);
    const written = Buffer.from(save.data, 'base64');
    assert.equal(written.subarray(0, 6).toString('latin1'), 'GIF89a');
    const back = pixelsOfFile(written);
    assert.deepEqual([back.width, back.height, [...back.data]], [6, 2, [...sprite.data]], 'same size, same colours, same see-through pixels');
    assert.deepEqual(new Set(decodeGif(written).palette.slice(0, 3)), new Set(paletteOf(coloursOf(sprite))));
  } finally {
    delete (globalThis as Record<string, unknown>).createImageBitmap;
  }
});

test('batch redraw replaces one image, saves as a free -redraw file, and handles per-row errors during Replace all', async () => {
  // `npc-redraw.png` is already taken, so Save as new file on `npc.png` must pick `npc-redraw-2.png`.
  saved.extra = [asset('public/art/npc-redraw.png', 'unused'), asset('public/art/slime.png', 'unused')];
  saved.batchJobs['batch-save'] = {
    id: 'job-save',
    sessionId: 'batch-save',
    phase: 'done',
    startedAt: 1000,
    prompt: 'crisp pixel redraw',
    items: [
      { path: 'assets/cast-v1/hero.png', status: 'done', width: 2048, height: 2048, ms: 3000 },
      { path: 'public/art/npc.png', status: 'done', width: 2048, height: 2048, ms: 3200 },
      { path: 'assets/cast-v2/hero.png', status: 'done', width: 2048, height: 2048, ms: 3100 },
      { path: 'public/art/slime.png', status: 'done', width: 2048, height: 2048, ms: 2900 },
    ],
  };
  await mount('batch-save');
  assert.match(container.querySelector('.ga-batch-bar')!.textContent!, /h3 batch redraw: 4 pictures ready to review/);
  await click(button('.ga-batch-bar', 'Open'));
  await settle();

  // 1. Single-image Replace sends replace: true and made = { source: 'h3', model: 'MiniMax-H3-Image', prompt }.
  await click(button('.ga-batch-item[data-path="assets/cast-v1/hero.png"]', 'Replace'));
  await settle();
  const firstSave = sent().filter(request => request.action === 'save').at(-1)!;
  assert.deepEqual([firstSave.path, firstSave.replace, firstSave.made], [
    'assets/cast-v1/hero.png',
    true,
    { source: 'h3', model: 'MiniMax-H3-Image', prompt: 'crisp pixel redraw' },
  ]);
  assert.equal(container.querySelector('.ga-batch-item[data-path="assets/cast-v1/hero.png"] .ga-tag')!.textContent, 'Replaced');

  // 2. Save as new file uses the next free `-redraw` path (`public/art/npc-redraw-2.png`).
  await click(button('.ga-batch-item[data-path="public/art/npc.png"]', 'Save as new file'));
  await settle();
  const secondSave = sent().filter(request => request.action === 'save').at(-1)!;
  assert.deepEqual([secondSave.path, secondSave.replace], ['public/art/npc-redraw-2.png', false]);
  assert.equal(container.querySelector('.ga-batch-item[data-path="public/art/npc.png"] .ga-tag')!.textContent, 'Saved as public/art/npc-redraw-2.png');

  // 3. Replace all saves the remaining items one by one; a failure on one row is shown on that row while the others succeed.
  saved.failSave['assets/cast-v2/hero.png'] = 'Permission denied';
  await click(button('.ga-dialog', 'Replace all'));
  await settle();
  assert.equal(container.querySelector('.ga-batch-item[data-path="assets/cast-v2/hero.png"] [role=alert]')!.textContent, 'Permission denied');
  assert.equal(container.querySelector('.ga-batch-item[data-path="public/art/slime.png"] .ga-tag')!.textContent, 'Replaced');
  assert.ok(container.querySelector('.ga-dialog'), 'dialog stays open while a failed row remains');

  // Fixing the failure and clicking Replace all finishes the batch, cleans up on the host, and updates the panel scan.
  delete saved.failSave['assets/cast-v2/hero.png'];
  await click(button('.ga-dialog', 'Replace all'));
  await settle();
  assert.equal(container.querySelector('.ga-dialog'), null);
  assert.equal(sent().some(request => request.action === 'h3Discard' && request.id === 'job-save'), true);
  assert.ok(container.querySelector('.ga-cell[title="public/art/npc-redraw-2.png"]'), 'panel adopted the latest scan');
});

test('closing the batch dialog while running does not stop the job; the panel banner reconnects to the same job, and Stop and shut down sends h3Stop', async () => {
  await mount('batch-bg');
  await check('assets/cast-v1/hero.png');
  await check('assets/cast-v2/hero.png');
  await click(button('.ga-selbar', 'Batch redraw with h3…'));
  await settle();
  await click(container.querySelector('.ga-dialog .ga-check-label input'));
  await click(button('.ga-dialog', 'Still boot and redraw 2 images'));
  await settle();

  const startedId = saved.batchJobs['batch-bg'].id;
  saved.batchJobs['batch-bg'] = {
    ...saved.batchJobs['batch-bg'],
    phase: 'drawing',
    items: [
      { path: 'assets/cast-v1/hero.png', status: 'done', width: 2048, height: 2048, ms: 2000 },
      { path: 'assets/cast-v2/hero.png', status: 'drawing' },
    ],
  };

  // Closing the dialog while running never sends h3Stop or h3Discard.
  await click(button('.ga-dialog', 'Close'));
  await settle();
  assert.equal(container.querySelector('.ga-dialog'), null);
  assert.equal(sent().some(request => request.action === 'h3Stop' || request.action === 'h3Discard'), false);
  assert.ok(container.querySelector('.ga-batch-bar'));

  // Reopening from the banner connects back to the exact same job id, and Stop and shut down sends h3Stop.
  await click(button('.ga-batch-bar', 'Open'));
  await settle();
  assert.equal(saved.h3Polls.at(-1)?.id, startedId);
  assert.equal(sent().filter(request => request.action === 'h3Start').length, 1);
  assert.match(container.querySelector('.ga-dialog')!.textContent!, /Drawing 2\/2/);

  await click(button('.ga-dialog', 'Stop and shut down'));
  await settle();
  assert.deepEqual(sent().find(request => request.action === 'h3Stop'), { action: 'h3Stop', sessionId: 'batch-bg', id: startedId });
});

test('every ui() string in the client has a Chinese translation, and the batch dialog renders in Chinese without untranslated English copy', async () => {
  const clientDir = fileURLToPath(new URL('../src/client/', import.meta.url));
  const files = (await readdir(clientDir)).filter(name => /\.(ts|tsx)$/.test(name) && name !== 'i18n.ts');
  const keys = new Set<string>();
  for (const name of files) {
    const source = await readFile(`${clientDir}/${name}`, 'utf8');
    for (const match of source.matchAll(/\bui\(\s*'((?:\\'|[^'])+)'/g)) {
      keys.add(match[1].replace(/\\'/g, "'"));
    }
  }
  const dispose = i18n.installLocale({
    get: () => ({ register: () => undefined, subscribe: () => () => {}, getSnapshot: () => ({ active: 'zh-CN', revision: 1 }) }),
  });
  try {
    for (const key of keys) {
      // Proper names that stay the same in Chinese (`Codex`, `Gemini`, `h3`) are allowed; every English phrase must translate.
      if (key === 'Codex' || key === 'Gemini') continue;
      assert.notEqual(i18n.ui(key), key, `missing Chinese translation for ui('${key}')`);
    }
    assert.equal(localizePictureError('h3 down failed; run h3 down yourself: colab disconnect timed out'), 'h3 down 失败，请手动运行 h3 down：colab disconnect timed out');
    assert.equal(localizePictureError('h3 made no picture: ComfyUI failed'), 'h3 没有生成图片：ComfyUI failed');
    assert.equal(localizePictureError('h3 made no picture: output file is missing'), 'h3 没有生成图片：找不到输出文件');
    assert.equal(localizePictureError('h3 could not start the VM: no A100'), 'h3 无法启动虚拟机：no A100');
  } finally {
    dispose();
  }

  await mount('batch-zh', 'zh-CN');
  await check('assets/cast-v1/hero.png');
  await check('public/art/npc.png');
  assert.ok(button('.ga-selbar', '用 h3 批量重绘…'));
  await click(button('.ga-selbar', '用 h3 批量重绘…'));
  await settle();

  const beforeText = container.querySelector('.ga-dialog')!.textContent!;
  assert.match(beforeText, /用 h3 批量重绘/);
  assert.match(beforeText, /不到 4 张不划算/);
  assert.match(beforeText, /仍然开机生成 2 张/);
  await click(container.querySelector('.ga-dialog .ga-check-label input'));
  await click(button('.ga-dialog', '仍然开机生成 2 张'));
  await settle();
  assert.match(container.querySelector('.ga-dialog')!.textContent!, /正在开机….*停止并关机/);

  await click(button('.ga-dialog', '关闭'));
  await settle();
  assert.match(container.querySelector('.ga-batch-bar')!.textContent!, /h3 批量重绘：正在开机 · 共 2 张.*打开/);
});

test('when another workspace finishes its h3 batch, the selection bar button and open dialog re-enable automatically without switching tabs', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  saved.batchJobs['other-ws'] = {
    id: 'job-other',
    sessionId: 'other-ws',
    phase: 'drawing',
    startedAt: 1000,
    prompt: 'other',
    items: [{ path: 'a.png', status: 'drawing' }],
  };
  await mount('batch-wait');
  await check('assets/cast-v1/hero.png');
  await check('public/art/npc.png');

  const selButton = () => button('.ga-selbar', 'Batch redraw with h3…') as HTMLButtonElement;
  assert.equal(selButton().disabled, true);
  assert.equal(selButton().title, 'h3 is already redrawing a batch for another workspace');

  // The other workspace finishes; the 5-second background poll clears busyElsewhere without leaving the tab.
  saved.batchJobs['other-ws'] = { ...saved.batchJobs['other-ws'], phase: 'done', items: [{ path: 'a.png', status: 'done' }] };
  await act(async () => { mock.timers.tick(5000); });
  await settle();
  assert.equal(selButton().disabled, false);
  assert.equal(selButton().title, '');

  // If another workspace starts right before the dialog opens, opening the dialog refreshes busyElsewhere and recovers when it ends.
  saved.batchJobs['other-ws'] = { ...saved.batchJobs['other-ws'], phase: 'booting' };
  await click(selButton());
  await settle();
  await click(container.querySelector('.ga-dialog .ga-check-label input'));
  const startBtn = () => button('.ga-dialog', 'Still boot and redraw 2 images') as HTMLButtonElement;
  assert.equal(startBtn().disabled, true);
  assert.match(container.querySelector('.ga-dialog [data-tone=warn][role=alert]')!.textContent!, /another workspace/);

  saved.batchJobs['other-ws'] = { ...saved.batchJobs['other-ws'], phase: 'done' };
  await act(async () => { mock.timers.tick(5000); });
  await settle();
  assert.equal(startBtn().disabled, false);
});

test('background batch shows an error banner when h3 down fails or when every item fails without new pictures', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  saved.batchJobs['batch-err-zh'] = {
    id: 'job-down-err',
    sessionId: 'batch-err-zh',
    phase: 'drawing',
    startedAt: 1000,
    prompt: 'redraw',
    items: [
      { path: 'assets/cast-v1/hero.png', status: 'drawing' },
      { path: 'public/art/npc.png', status: 'waiting' },
    ],
  };
  await mount('batch-err-zh', 'zh-CN');
  assert.match(container.querySelector('.ga-batch-bar')!.textContent!, /h3 批量重绘：第 1\/2 张/);

  // Every item fails (`phase` is still `done`) AND `h3 down` fails while the dialog is closed.
  saved.batchJobs['batch-err-zh'] = {
    ...saved.batchJobs['batch-err-zh'],
    phase: 'done',
    downError: 'h3 down failed; run h3 down yourself: colab disconnect timed out',
    items: [
      { path: 'assets/cast-v1/hero.png', status: 'failed', error: 'h3 made no picture: workflow crashed' },
      { path: 'public/art/npc.png', status: 'failed', error: 'h3 made no picture: workflow crashed' },
    ],
  };
  await act(async () => { mock.timers.tick(5000); });
  await settle();

  const errorBanner = container.querySelector('.ga-batch-bar[data-tone=error][role=alert]')!;
  assert.ok(errorBanner, 'panel displays an error banner when h3 down fails');
  assert.equal(errorBanner.querySelector('span')!.textContent, 'h3 down 失败，请手动运行 h3 down');
  await click(button('.ga-batch-bar', '打开'));
  await settle();
  assert.match(container.querySelector('.ga-dialog')!.textContent!, /h3 down 失败，请手动运行 h3 down：colab disconnect timed out/);
  assert.match(container.querySelector('.ga-dialog')!.textContent!, /h3 没有生成图片：workflow crashed/);
  await click(button('.ga-dialog', '关闭'));
  await settle();
  assert.equal(container.querySelector('.ga-batch-bar'), null);

  // Even when `h3 down` succeeds, if every item fails (`phase: 'done'`, 0 ready pictures), the panel reports failure instead of disappearing silently.
  await act(async () => root?.unmount());
  root = undefined;
  saved.batchJobs['batch-all-fail'] = {
    id: 'job-all-fail',
    sessionId: 'batch-all-fail',
    phase: 'done',
    startedAt: 2000,
    prompt: 'redraw',
    items: [
      { path: 'assets/cast-v1/hero.png', status: 'failed', error: 'h3 made no picture: bad seed' },
      { path: 'public/art/npc.png', status: 'failed', error: 'h3 made no picture: bad seed' },
    ],
  };
  await mount('batch-all-fail', 'zh-CN');
  const failBanner = container.querySelector('.ga-batch-bar[data-tone=error][role=alert]')!;
  assert.ok(failBanner);
  assert.equal(failBanner.querySelector('span')!.textContent, 'h3 批量重绘失败');
  assert.ok(button('.ga-batch-bar', '打开'));
});


