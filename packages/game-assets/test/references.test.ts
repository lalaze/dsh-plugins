import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SuffixIndex, extract, findReferences, normalizeToken, snippet } from '../src/references.js';

test('paths in code are normalized: separators, leading dots and aliases, and interpolations as wildcards', () => {
  assert.deepEqual(normalizeToken('./art/cats/a'), { token: 'art/cats/a', pattern: false });
  assert.deepEqual(normalizeToken('..\\\\art\\\\a'), { token: 'art/a', pattern: false });
  assert.deepEqual(normalizeToken('@/assets//a'), { token: 'assets/a', pattern: false });
  assert.deepEqual(normalizeToken('cats/${breed}-${pose}'), { token: 'cats/*-*', pattern: true });
  assert.deepEqual(normalizeToken('cats/{breed}_%d'), { token: 'cats/*_*', pattern: true });
  assert.equal(normalizeToken('a/../b'), undefined);
  assert.equal(normalizeToken('100%25'), undefined);
  assert.equal(normalizeToken('./'), undefined);
});

test('extraction finds image and data paths, template paths and quoted folders with their lines', () => {
  const { mentions, folders } = extract([
    "this.load.image('cat', 'art/cats/idle.png');",
    'const walk = `${BASE}/cats/${breed}-walk.gif`;',
    "import list from './manifest.json';",
    "const DIR = 'art/props/';",
    'background: url(../img/bg.webp) no-repeat; // not.pngx and plain .png',
  ].join('\n'));
  assert.deepEqual(mentions.map(m => [m.token, m.extension, m.pattern, m.line]), [
    ['art/cats/idle', 'png', false, 1], ['*/cats/*-walk', 'gif', true, 2], ['manifest', 'json', false, 3], ['img/bg', 'webp', false, 5],
  ]);
  assert.deepEqual(folders.map(f => [f.dir, f.line]), [['art/props', 4]]);
});

test('a long line without any path is read in linear time', () => {
  const started = Date.now();
  assert.equal(extract(`const blob = "${'A/b'.repeat(400_000)}";`).mentions.length, 0);
  assert.ok(Date.now() - started < 2000);
});

test('a snippet of a minified line keeps the part that holds the reference', () => {
  const line = `${'x'.repeat(500)}"art/cats/idle.png"${'y'.repeat(500)}`;
  const cut = snippet(line, 501);
  assert.ok(cut.length <= 162 && cut.includes('art/cats/idle.png') && cut.startsWith('…') && cut.endsWith('…'));
  assert.equal(snippet('  short  ', 2), 'short');
});

test('literal paths find images by their ending, whatever the image extension', () => {
  const index = new SuffixIndex(['public/art/cats/idle.gif', 'masters/art/cats/idle.png', 'public/art/dogs/idle.png', 'public/icon.svg'], true);
  assert.deepEqual(index.literal('art/cats/idle', 'png'), [{ index: 0, kind: 'path' }, { index: 1, kind: 'path' }]);
  assert.deepEqual(index.literal('icon', 'svg'), [{ index: 3, kind: 'path' }]);
  // A bare name three images share: certain only for the one with that extension.
  assert.deepEqual(index.literal('idle', 'gif'), [{ index: 0, kind: 'path' }, { index: 1, kind: 'name' }, { index: 2, kind: 'name' }]);
  assert.deepEqual(index.literal('idle', 'png').map(m => m.kind), ['name', 'name', 'name']);
  assert.deepEqual(index.literal('art/birds/idle', 'png'), []);
});

test('patterns match whole path parts and need some literal text', () => {
  const index = new SuffixIndex(['art/cats/tabby-walk.png', 'art/cats/deep/tabby-walk.png', 'art/dogs/pug-walk.png', 'art/cats/tabby-sit.png'], true);
  assert.deepEqual(index.pattern('cats/*-walk'), [0]);
  assert.deepEqual(index.pattern('*/cats/*'), [0, 3]);
  assert.deepEqual(index.pattern('*/*-walk'), [0, 1, 2]);
  assert.deepEqual(index.pattern('*/*'), []);
  assert.deepEqual(index.pattern('*.x*'), []);
});

const project = (files: Record<string, string>, assets: string[], sources: string[], data: string[] = []) =>
  findReferences({ assets, sources, data, read: async path => files[path] });

test('images are used, maybe used or unused by the strongest reference to them', async () => {
  const assets = ['public/art/cats/idle.png', 'public/art/cats/tabby-walk.png', 'public/art/props/lamp.png', 'public/art/hero_idle.png', 'public/art/old/unused.png', 'public/art/sheet.png'];
  const result = await project({
    'src/game.ts': [
      "load.image('idle', 'art/cats/idle.png');",
      'load.image(key, `art/cats/${breed}-walk.png`);',
      "const PROPS = 'art/props/';",
      "sprite.setTexture('hero_idle'); const sheet = 1;",
    ].join('\n'),
  }, assets, ['src/game.ts']);
  assert.deepEqual(result.usage, ['used', 'maybe', 'maybe', 'maybe', 'unused', 'unused']);
  assert.deepEqual(result.refs.map(refs => refs.map(ref => `${ref.kind}@${ref.line}`)), [['path@1'], ['pattern@2'], ['folder@3'], ['name@4'], [], []]);
  assert.equal(result.refs[0][0].text, "load.image('idle', 'art/cats/idle.png');");
  assert.equal(result.filesRead, 1);
});

test('a data file counts only once code names it, and what it names counts in turn', async () => {
  const assets = ['public/a.png', 'public/b.png', 'packs/v1/c.png'];
  const files = {
    'src/boot.ts': "load.pack('main', 'data/pack.json');",
    'public/data/pack.json': '{"files":["a.png"],"atlas":"atlas/main.atlas"}',
    'public/atlas/main.atlas': 'b.png\nsize: 64,64',
    // Generator output beside its images: nothing names it.
    'packs/v1/meta.json': '{"frames":["c.png"]}',
  };
  const result = await project(files, assets, ['src/boot.ts'], ['public/data/pack.json', 'public/atlas/main.atlas', 'packs/v1/meta.json']);
  assert.deepEqual(result.usage, ['used', 'used', 'unused']);
  assert.equal(result.refs[1][0].file, 'public/atlas/main.atlas');
  assert.equal(result.filesRead, 3);
});

test('a bare data name that many files share reaches none of them; unreadable files are skipped', async () => {
  const data = ['a/manifest.json', 'b/manifest.json', 'c/manifest.json', 'd/manifest.json'];
  const files: Record<string, string> = Object.fromEntries(data.map(path => [path, '"x.png"']));
  files['src/a.ts'] = "read('manifest.json')";
  const result = await project(files, ['art/x.png'], ['src/a.ts', 'src/missing.ts'], data);
  assert.deepEqual(result.usage, ['unused']);
  assert.equal(result.filesRead, 1);
});

test('references list the strongest first and count those beyond the limit', async () => {
  const lines = Array.from({ length: 12 }, (_, i) => `use${i}('art/hero.png')`);
  const result = await project({ 'src/a.ts': ['`art/${n}.png`', ...lines].join('\n') }, ['art/hero.png'], ['src/a.ts']);
  assert.equal(result.counts[0], 13);
  assert.equal(result.refs[0].length, 8);
  assert.ok(result.refs[0].every(ref => ref.kind === 'path'));
});
