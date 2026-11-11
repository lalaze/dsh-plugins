import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { CLIENT_HEADER, type MoveResult, type ScanResult, type TagResult } from '../src/domain.js';
import { createHandler } from '../src/http.js';
import { cleanRetireDir, cleanTag } from '../src/manage.js';
import { AssetService } from '../src/service.js';

const png = (fill: number, length = 64) => {
  const data = Buffer.alloc(length, fill);
  data.writeUInt32BE(0x89504e47, 0); data.writeUInt32BE(0x0d0a1a0a, 4); data.writeUInt32BE(13, 8); data.write('IHDR', 12, 'latin1');
  data.writeUInt32BE(16, 16); data.writeUInt32BE(16, 20);
  return data;
};
const made: string[] = [];
after(async () => { for (const dir of made) await rm(dir, { recursive: true, force: true }); });
const exists = (file: string) => access(file).then(() => true, () => false);

/** A small game: one image the code names, two it does not, a script, and a file outside the workspace behind a link. */
async function game() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-game-manage-')), outside = await mkdtemp(join(tmpdir(), 'dsh-game-manage-out-')), state = await mkdtemp(join(tmpdir(), 'dsh-game-manage-state-'));
  made.push(root, outside, state);
  const put = async (path: string, content: string | Buffer, base = root) => { await mkdir(dirname(join(base, path)), { recursive: true }); await writeFile(join(base, path), content); };
  await put('package.json', '{"dependencies":{"phaser":"4"}}');
  await put('src/game.ts', "load.image('hero', 'art/hero.png');\n");
  await put('public/art/hero.png', png(1));
  await put('public/art/old/npc.png', png(2, 70));
  await put('public/art/old/sign.png', png(3, 80));
  await put('secret.png', png(9), outside);
  await symlink(outside, join(root, 'public/linked'));
  const handler = createHandler(new AssetService(async id => id === 'game' ? root : undefined, join(state, 'workspaces.json')));
  const call = async <T>(body: Record<string, unknown>) => {
    const answer = await handler(new Request('http://dsh.test/api/game-assets', { method: 'POST', headers: { 'content-type': 'application/json', [CLIENT_HEADER]: '1' }, body: JSON.stringify({ sessionId: 'game', ...body }) }));
    return { status: answer.status, body: await answer.json() as T };
  };
  return { root, outside, put, call };
}
const row = (scan: ScanResult, path: string) => scan.assets.find(asset => asset.path === path);

test('tags and retired folders are kept only in a plain form', () => {
  assert.deepEqual(['  npc  ', 'main\tcast', 'a,b', 'x'.repeat(41), '', 5].map(cleanTag), ['npc', 'main cast', 'a b', undefined, undefined, undefined]);
  assert.deepEqual(['_retired', ' assets\\art-retired/ ', 'a//b'].map(cleanRetireDir), ['_retired', 'assets/art-retired', 'a/b']);
  for (const dir of ['', '.', '..', '../out', 'a/../b', '.hidden', 'a/.b', 'node_modules', 'a:b', 7, 'x'.repeat(201)]) assert.equal(cleanRetireDir(dir), undefined, String(dir));
});

test('retiring moves images under the retired folder with a list of where they came from; restoring puts them back', async () => {
  const { root, call } = await game();
  await call<ScanResult>({ action: 'scan' });
  await call<TagResult>({ action: 'tag', paths: ['public/art/old/npc.png'], add: ['npc'] });
  const retired = (await call<MoveResult>({ action: 'retire', paths: ['public/art/old/npc.png', 'public/art/old/sign.png'] })).body;
  assert.deepEqual([retired.moved, retired.failed], [2, []]);
  assert.deepEqual([await exists(join(root, 'public/art/old/npc.png')), await exists(join(root, '_retired/public/art/old/npc.png'))], [false, true]);
  assert.deepEqual(await readFile(join(root, '_retired/public/art/old/sign.png')), png(3, 80));
  // The folder they emptied goes with them; its neighbours stay.
  assert.deepEqual(await readdir(join(root, 'public/art')), ['hero.png']);
  const list = JSON.parse(await readFile(join(root, '_retired/retired.json'), 'utf8')) as { version: number; entries: { from: string; to: string; at: string }[] };
  assert.deepEqual(list.entries.map(({ from, to }) => [from, to]), [['public/art/old/npc.png', '_retired/public/art/old/npc.png'], ['public/art/old/sign.png', '_retired/public/art/old/sign.png']]);
  assert.match(list.entries[0].at, /^\d{4}-\d\d-\d\dT/);

  // The answer carries the workspace as it is now: retired images are listed apart, with their origin and their tags.
  assert.deepEqual(retired.scan.assets.map(asset => asset.path), ['public/art/hero.png', '_retired/public/art/old/npc.png', '_retired/public/art/old/sign.png']);
  assert.deepEqual(row(retired.scan, '_retired/public/art/old/npc.png'), { path: '_retired/public/art/old/npc.png', size: 70, mtimeMs: row(retired.scan, '_retired/public/art/old/npc.png')!.mtimeMs, width: 16, height: 16,
    usage: 'unused', refCount: 0, retired: true, origin: 'public/art/old/npc.png', tags: ['npc'] });
  // The retired folder is not one of the folders to scan.
  assert.deepEqual(retired.scan.folders.map(folder => folder.name), ['public', 'src']);

  const restored = (await call<MoveResult>({ action: 'restore', paths: ['_retired/public/art/old/npc.png'] })).body;
  assert.deepEqual([restored.moved, restored.failed], [1, []]);
  assert.deepEqual(row(restored.scan, 'public/art/old/npc.png')!.tags, ['npc']);
  assert.equal(row(restored.scan, 'public/art/old/npc.png')!.retired, undefined);
  assert.deepEqual((JSON.parse(await readFile(join(root, '_retired/retired.json'), 'utf8')) as { entries: { to: string }[] }).entries.map(entry => entry.to), ['_retired/public/art/old/sign.png']);
  // The last image back takes the emptied folders with it; the list stays.
  await call<MoveResult>({ action: 'restore', paths: ['_retired/public/art/old/sign.png'] });
  assert.deepEqual(await readdir(join(root, '_retired')), ['retired.json']);
});

test('a retired image is not matched against code, so retiring one the game uses shows', async () => {
  const { call } = await game();
  assert.equal(row((await call<ScanResult>({ action: 'scan' })).body, 'public/art/hero.png')!.usage, 'used');
  const { scan } = (await call<MoveResult>({ action: 'retire', paths: ['public/art/hero.png'] })).body;
  const hero = row(scan, '_retired/public/art/hero.png')!;
  assert.deepEqual([hero.usage, hero.refCount, hero.retired], ['unused', 0, true]);
});

test('only images the scan listed can be moved, nothing is overwritten, and links cannot lead out', async () => {
  const { root, outside, put, call } = await game();
  await call<ScanResult>({ action: 'scan' });
  const refused = (await call<MoveResult>({ action: 'retire', paths: ['src/game.ts', 'public/linked/secret.png', '../x.png', 'public/art/none.png'] })).body;
  assert.deepEqual([refused.moved, refused.failed.map(failure => failure.error)], [0, Array(4).fill('Not an image of this workspace')]);
  assert.deepEqual([await exists(join(root, 'src/game.ts')), await exists(join(outside, 'secret.png')), await exists(join(root, '_retired'))], [true, true, false]);

  // A file already sitting at the retired path is kept; the image stays where it was.
  await put('_retired/public/art/old/npc.png', png(7, 90));
  await call<ScanResult>({ action: 'scan', refresh: true });
  const kept = (await call<MoveResult>({ action: 'retire', paths: ['public/art/old/npc.png', 'public/art/old/sign.png'] })).body;
  assert.deepEqual([kept.moved, kept.failed], [1, [{ path: 'public/art/old/npc.png', error: 'A file of that name is already there' }]]);
  assert.deepEqual(await readFile(join(root, '_retired/public/art/old/npc.png')), png(7, 90));
  assert.equal(await exists(join(root, 'public/art/old/npc.png')), true);
  // That older file has no recorded origin, so it is listed as retired but cannot be restored; a live image cannot be "restored".
  const stuck = (await call<MoveResult>({ action: 'restore', paths: ['_retired/public/art/old/npc.png', 'public/art/hero.png'] })).body;
  assert.deepEqual([stuck.moved, stuck.failed.map(failure => failure.error).sort()], [0, ['This image cannot be moved that way', 'Where this image came from was not recorded']]);
  // Its place taken again, a recorded image stays retired too.
  await put('public/art/old/sign.png', png(8, 60));
  const taken = (await call<MoveResult>({ action: 'restore', paths: ['_retired/public/art/old/sign.png'] })).body;
  assert.deepEqual([taken.moved, taken.failed[0].error], [0, 'A file of that name is already there']);
  for (const paths of [undefined, [], 'public/art/hero.png', [1]]) assert.equal((await call({ action: 'retire', paths })).status, 400);
});

test('the retired folder can be another one; folders that could not be listed are refused', async () => {
  const { root, call } = await game();
  const configured = await call<ScanResult>({ action: 'configure', folders: {}, retireDir: 'public/art/retired' });
  assert.deepEqual([configured.status, configured.body.retireDir], [200, 'public/art/retired']);
  await call<MoveResult>({ action: 'retire', paths: ['public/art/old/sign.png'] });
  assert.equal(await exists(join(root, 'public/art/retired/public/art/old/sign.png')), true);
  for (const retireDir of ['.trash', '../out', '']) assert.equal((await call({ action: 'configure', folders: {}, retireDir })).status, 400);
  assert.equal((await call<ScanResult>({ action: 'scan' })).body.retireDir, 'public/art/retired');
});

test('tags and notes live in one file of the workspace, by image path', async () => {
  const { root, call } = await game();
  await call<ScanResult>({ action: 'scan' });
  const tagged = await call<TagResult>({ action: 'tag', paths: ['public/art/hero.png', 'public/art/old/npc.png'], add: [' cast ', 'main'] });
  assert.deepEqual(tagged.body, { tags: { 'public/art/hero.png': ['cast', 'main'], 'public/art/old/npc.png': ['cast', 'main'] } });
  assert.deepEqual((await call<TagResult>({ action: 'tag', paths: ['public/art/old/npc.png'], add: ['npc'], remove: ['main', 'cast'] })).body, { tags: { 'public/art/old/npc.png': ['npc'] } });
  assert.deepEqual((await call<{ note: string }>({ action: 'note', path: 'public/art/hero.png', note: '  redraw for winter \n' })).body, { note: 'redraw for winter' });
  assert.deepEqual(JSON.parse(await readFile(join(root, '.game-assets.json'), 'utf8')), {
    version: 1, tags: { 'public/art/hero.png': ['cast', 'main'], 'public/art/old/npc.png': ['npc'] }, notes: { 'public/art/hero.png': 'redraw for winter' } });
  // The scan in memory already has them, and so has a new one.
  for (const refresh of [false, true]) {
    const scan = (await call<ScanResult>({ action: 'scan', refresh })).body;
    assert.deepEqual([row(scan, 'public/art/hero.png')!.tags, row(scan, 'public/art/hero.png')!.note, row(scan, 'public/art/old/sign.png')!.tags], [['cast', 'main'], 'redraw for winter', undefined]);
  }
  await call({ action: 'tag', paths: ['public/art/old/npc.png'], remove: ['npc'] });
  await call({ action: 'note', path: 'public/art/hero.png', note: '' });
  assert.deepEqual(JSON.parse(await readFile(join(root, '.game-assets.json'), 'utf8')), { version: 1, tags: { 'public/art/hero.png': ['cast', 'main'] }, notes: {} });
  for (const body of [{ action: 'tag', paths: ['public/art/hero.png'], add: ['x'.repeat(41)] }, { action: 'tag', paths: ['public/art/hero.png'], add: 'npc' }, { action: 'tag', paths: [] }, { action: 'note', path: 'public/art/hero.png', note: 5 }])
    assert.equal((await call(body)).status, 400);
  assert.equal((await call({ action: 'note', path: 'src/game.ts', note: 'x' })).status, 404);
});
