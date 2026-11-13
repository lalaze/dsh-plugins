import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Asset } from '../src/domain.js';
import { UNTAGGED, agentMessage, availableHeight, buildTree, filterAssets, fitScale, formatBytes, sameName, sortAssets, tagCounts, usageCounts, visibleRows, visibleSpan, type Filter } from '../src/client/model.js';

const asset = (path: string, usage: Asset['usage'] = 'unused', extra: Partial<Asset> = {}): Asset => ({ path, usage, size: 10, mtimeMs: 0, refCount: 0, ...extra });
const assets = [
  asset('assets/generated/cast-v9/hero-walk.png', 'used', { dup: 1, size: 300, width: 64, height: 64 }),
  asset('assets/generated/cast-v9/npc-walk.png', 'maybe', { size: 20, width: 640, height: 64 }),
  asset('assets/generated/props/lamp.png'),
  asset('public/art/hero-walk.gif', 'used', { dup: 1 }),
  asset('icon.svg'),
];
const all: Filter = { query: '', usage: 'all', folder: '' };

test('images are filtered by search words, usage and folder', () => {
  const paths = (filter: Partial<Filter>) => filterAssets(assets, { ...all, ...filter }).map(a => a.path);
  assert.equal(paths({}).length, 5);
  assert.deepEqual(paths({ query: 'WALK cast' }), ['assets/generated/cast-v9/hero-walk.png', 'assets/generated/cast-v9/npc-walk.png']);
  assert.deepEqual(paths({ usage: 'used' }), ['assets/generated/cast-v9/hero-walk.png', 'public/art/hero-walk.gif']);
  assert.deepEqual(paths({ usage: 'dup', folder: 'public' }), ['public/art/hero-walk.gif']);
  assert.deepEqual(paths({ folder: 'assets/generated/prop' }), []);
  assert.deepEqual(usageCounts(assets, { ...all, folder: 'assets' }), { all: 3, used: 1, maybe: 1, unused: 1, dup: 1, retired: 0 });
});

test('retired images are listed only under their own filter; tags and notes filter and are searched', () => {
  const shelf = [...assets, asset('_retired/public/art/old.png', 'unused', { retired: true, origin: 'public/art/old.png', tags: ['old'] }),
    asset('public/art/npc.png', 'unused', { tags: ['npc', 'winter'], note: 'Redraw the scarf' })];
  const paths = (filter: Partial<Filter>) => filterAssets(shelf, { ...all, ...filter }).map(a => a.path);
  assert.equal(paths({}).includes('_retired/public/art/old.png'), false);
  assert.deepEqual(paths({ usage: 'unused' }), ['assets/generated/props/lamp.png', 'icon.svg', 'public/art/npc.png']);
  assert.deepEqual(paths({ usage: 'retired' }), ['_retired/public/art/old.png']);
  assert.deepEqual(paths({ tag: 'winter' }), ['public/art/npc.png']);
  assert.equal(paths({ tag: UNTAGGED }).length, 5);
  assert.deepEqual(paths({ query: 'scarf' }), ['public/art/npc.png']);
  assert.deepEqual(paths({ query: 'npc' }), ['assets/generated/cast-v9/npc-walk.png', 'public/art/npc.png']);
  // The folder picked among live images does not hide how many are retired.
  assert.deepEqual(usageCounts(shelf, { ...all, folder: 'public' }), { all: 2, used: 1, maybe: 0, unused: 1, dup: 1, retired: 1 });
  assert.deepEqual(tagCounts(shelf), [['npc', 1], ['old', 1], ['winter', 1]]);
  assert.equal(agentMessage(' Check these. ', ['a.png', 'b.png', 'c.png'], count => `and ${count} more`, 2), 'Check these.\n\n- a.png\n- b.png\nand 1 more');
});

test('the folder tree counts images below each folder and merges folders that only hold one folder', () => {
  const tree = buildTree(assets, all);
  assert.equal(tree.count, 5);
  assert.deepEqual(tree.children.map(node => [node.label, node.path, node.count]), [['assets/generated', 'assets/generated', 3], ['public/art', 'public/art', 1]]);
  assert.deepEqual(tree.children[0].children.map(node => [node.label, node.count]), [['cast-v9', 2], ['props', 1]]);
  assert.deepEqual(buildTree(assets, { ...all, usage: 'maybe' }).children.map(node => [node.label, node.count]), [['assets/generated/cast-v9', 1]]);
});

test('sorting, same-name files and how values read', () => {
  assert.deepEqual(sortAssets([...assets], 'size').slice(0, 2).map(a => a.size), [300, 20]);
  assert.equal(sortAssets([...assets], 'pixels')[0].path, 'assets/generated/cast-v9/npc-walk.png');
  assert.deepEqual(sameName(assets)(assets[0]).map(a => a.path), ['public/art/hero-walk.gif']);
  assert.deepEqual(sameName(assets)(assets[4]), []);
  assert.deepEqual([0, 1023, 1024, 1536, 150 * 1024, 5 * 1024 ** 2, 3 * 1024 ** 3].map(formatBytes), ['0 B', '1023 B', '1.0 KB', '1.5 KB', '150 KB', '5.0 MB', '3.0 GB']);
  assert.deepEqual([fitScale(16, 16, 96), fitScale(40, 20, 96), fitScale(64, 64, 96), fitScale(undefined, 16, 96)], [6, 2, undefined, undefined]);
});

test('what is on screen is where the grid, the window and the rows overlap, whichever of them scrolls', () => {
  // The grid scrolls by itself: its box is on screen and its rows have moved up by 3000.
  assert.deepEqual(visibleSpan({ top: 120, bottom: 820 }, { top: -2880 }, 900), { top: 3000, height: 700 });
  // The grid grew with its rows and the page around it scrolled by 5000: only the window's 900 are on screen.
  assert.deepEqual(visibleSpan({ top: -4900, bottom: 110000 }, { top: -4892 }, 900), { top: 4892, height: 900 });
  // Scrolled out of sight.
  assert.deepEqual(visibleSpan({ top: 1200, bottom: 1800 }, { top: 1200 }, 900), { top: 0, height: 0 });
  // A scrolling area 900 high, scrolled by 300, with the view 40 into its content and a composer of 80 below.
  assert.equal(availableHeight({ top: 100, scrollTop: 300, clientHeight: 900 }, -160, 80), 780);
  assert.equal(availableHeight({ top: 0, scrollTop: 0, clientHeight: 200 }, 0, 80), 320);
});

test('only the rows on screen, with a margin, are rendered', () => {
  assert.deepEqual(visibleRows(1000, 10, 100, 0, 600), { rows: 100, first: 0, last: 8 });
  assert.deepEqual(visibleRows(1000, 10, 100, 5000, 600), { rows: 100, first: 48, last: 58 });
  assert.deepEqual(visibleRows(5, 10, 100, 0, 600), { rows: 1, first: 0, last: 0 });
});

test('a generated picture is placed whole for a sprite, or crops to fill for an opaque picture', async () => {
  const { placeRect, aspectOf, defaultFit } = await import('../src/client/picture.js');
  assert.deepEqual(placeRect(1536, 1024, 320, 180), { x: 25, y: 0, width: 270, height: 180 });
  assert.deepEqual(placeRect(1536, 1024, 320, 180, true), { x: 0, y: -17, width: 320, height: 213 });
  assert.deepEqual(placeRect(1024, 1024, 32, 32), { x: 0, y: 0, width: 32, height: 32 });
  assert.deepEqual([aspectOf(32, 32), aspectOf(320, 180), aspectOf(100, 140), aspectOf()], ['square', 'wide', 'tall', 'square']);
  assert.deepEqual([defaultFit(32, 32), defaultFit(128, 96), defaultFit(320, 180), defaultFit()], ['pixel', 'pixel', 'smooth', 'none']);
});

test('a picture is offered a free path beside the image it redraws, or in the folder being looked at', async () => {
  const { freePath, suggestedPath } = await import('../src/client/generate.js');
  const { busiestFolder } = await import('../src/client/model.js');
  const taken = new Set(['art/hero.png', 'art/hero-redraw.png', 'art/hero-redraw-2.png', 'art/generated.png']);
  assert.equal(freePath('art/new.png', taken), 'art/new.png');
  assert.equal(freePath('art/hero-redraw.png', taken), 'art/hero-redraw-3.png');
  assert.equal(suggestedPath(asset('art/hero.png'), '', [], taken), 'art/hero-redraw-3.png');
  assert.equal(suggestedPath(asset('art/spin.gif'), '', [], taken), 'art/spin-redraw.png', 'a GIF is redrawn as a PNG');
  assert.equal(suggestedPath(undefined, 'art', [], taken), 'art/generated-2.png');
  assert.equal(suggestedPath(undefined, '', [asset('ui/button.png')], taken), 'ui/generated.png');
  assert.equal(suggestedPath(undefined, '', [], taken), 'generated.png');
  assert.equal(busiestFolder([asset('a/1.png'), asset('b/1.png'), asset('b/2.png'), asset('_retired/a/3.png', 'unused', { retired: true }), asset('_retired/a/4.png', 'unused', { retired: true })]), 'b');
});
