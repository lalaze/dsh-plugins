import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { CLIENT_HEADER, defaultRule, type AssetDetail, type ScanResult } from '../src/domain.js';
import { createHandler } from '../src/http.js';
import { Scanner } from '../src/scan.js';
import { AssetService } from '../src/service.js';

/** A PNG header of the given size, padded with `fill` so files can differ or be identical on purpose. */
const png = (width: number, height: number, fill = 0, length = 64) => {
  const data = Buffer.alloc(length, fill);
  data.writeUInt32BE(0x89504e47, 0); data.writeUInt32BE(0x0d0a1a0a, 4); data.writeUInt32BE(13, 8); data.write('IHDR', 12, 'latin1');
  data.writeUInt32BE(width, 16); data.writeUInt32BE(height, 20);
  return data;
};
let root: string, outside: string, state: string;
const put = async (path: string, content: string | Buffer, base = root) => { await mkdir(dirname(join(base, path)), { recursive: true }); await writeFile(join(base, path), content); };

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-game-assets-')); outside = await mkdtemp(join(tmpdir(), 'dsh-game-assets-out-')); state = await mkdtemp(join(tmpdir(), 'dsh-game-assets-state-'));
  await put('src/game.ts', "load.image('hero', 'art/hero.png');\nload.image(k, `cast-v2/${id}.png`);\nload.json('data/pack.json');\n");
  await put('public/art/hero.png', png(32, 48, 1));
  await put('public/art/hero-copy.png', png(32, 48, 1));
  await put('public/art/unused.gif', Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.from([16, 0, 8, 0]), Buffer.alloc(20)]));
  await put('public/data/pack.json', '{"image":"cast-v1/b.png"}');
  await put('public/cast-v1/a.png', png(8, 8, 2, 70));
  await put('public/cast-v1/b.png', png(8, 8, 3, 80));
  await put('public/cast-v2/a.png', png(8, 8, 4, 90));
  await put('public/cast-v1/notes.json', '{"frames":["a.png"]}');
  await put('dist/art/hero.png', png(32, 48, 1));
  await put('node_modules/pkg/logo.png', png(1, 1));
  await put('.cache/thumb.png', png(1, 1));
  await put('secret.png', png(5, 5), outside);
  await symlink(join(outside, 'secret.png'), join(root, 'public/art/link.png'));
});
after(async () => { for (const dir of [root, outside, state]) await rm(dir, { recursive: true, force: true }); });

test('a folder of images with a sliver of the project’s code is not read as code; build output is skipped', () => {
  assert.deepEqual(defaultRule('src', 0, 400, 600), { assets: true, code: true });
  assert.deepEqual(defaultRule('assets', 3594, 37, 630), { assets: true, code: false });
  assert.deepEqual(defaultRule('public', 300, 12, 12), { assets: true, code: true });
  assert.deepEqual(defaultRule('art', 40, 0, 100), { assets: true, code: true });
  assert.deepEqual(defaultRule('dist', 10, 10, 100), { assets: false, code: false });
});

test('a scan lists images with sizes, verdicts, identical copies, version families and folders', async () => {
  const result = await new Scanner().scan(root);
  const row = (path: string) => result.assets.find(asset => asset.path === path)!;
  assert.deepEqual(result.assets.map(asset => asset.path), ['public/art/hero-copy.png', 'public/art/hero.png', 'public/art/unused.gif', 'public/cast-v1/a.png', 'public/cast-v1/b.png', 'public/cast-v2/a.png']);
  assert.deepEqual([row('public/art/hero.png').width, row('public/art/hero.png').height, row('public/art/unused.gif').width, row('public/art/unused.gif').height], [32, 48, 16, 8]);
  assert.deepEqual(result.assets.map(asset => asset.usage), ['unused', 'used', 'unused', 'unused', 'used', 'maybe']);
  // The pack file counts because code names it; the notes beside the images do not.
  assert.equal(row('public/cast-v1/b.png').refs[0].file, 'public/data/pack.json');
  assert.equal(row('public/cast-v1/a.png').refCount, 0);
  assert.ok(row('public/art/hero.png').dup !== undefined && row('public/art/hero.png').dup === row('public/art/hero-copy.png').dup);
  assert.equal(row('public/cast-v1/a.png').dup, undefined);
  assert.deepEqual(result.families, [{ id: 'public/cast', dir: 'public', name: 'cast', versions: [
    { label: 'v1', path: 'public/cast-v1', total: 2, used: 1, maybe: 0, bytes: 150 }, { label: 'v2', path: 'public/cast-v2', total: 1, used: 0, maybe: 1, bytes: 90 }] }]);
  assert.deepEqual(result.folders, [
    { name: 'dist', images: 1, codeFiles: 0, assets: false, code: false },
    { name: 'public', images: 6, codeFiles: 0, assets: true, code: true },
    { name: 'src', images: 0, codeFiles: 1, assets: true, code: true },
  ]);
  assert.equal(result.codeFiles, 2);
  assert.equal(result.truncated, false);
});

test('folder rules switch a folder’s images on and its code off', async () => {
  const result = await new Scanner().scan(root, { dist: { assets: true, code: false }, src: { assets: true, code: false } });
  assert.ok(result.assets.some(asset => asset.path === 'dist/art/hero.png'));
  assert.ok(result.assets.every(asset => asset.usage === 'unused'));
  assert.equal(result.codeFiles, 0);
});

const service = (file = join(state, 'workspaces.json')) => new AssetService(async id => ({ game: root, remote: '/home/me/.dsh/remote-workspaces/box/app', gone: join(root, 'missing') } as Record<string, string>)[id], file);
const call = (handler: ReturnType<typeof createHandler>, body: unknown, headers: Record<string, string> = { [CLIENT_HEADER]: '1' }) =>
  handler(new Request('http://dsh.test/api/game-assets', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }));
const image = (handler: ReturnType<typeof createHandler>, path: string, sessionId = 'game') =>
  handler(new Request(`http://dsh.test/api/game-assets?sessionId=${sessionId}&path=${encodeURIComponent(path)}`, { headers: { [CLIENT_HEADER]: '1' } }));

test('the route answers scans without references, and references one image at a time', async () => {
  const handler = createHandler(service());
  const scan = await (await call(handler, { action: 'scan', sessionId: 'game' })).json() as ScanResult;
  assert.equal(scan.assets.length, 6);
  assert.ok(scan.assets.every(asset => !('refs' in asset)));
  const detail = await (await call(handler, { action: 'detail', sessionId: 'game', path: 'public/art/hero.png' })).json() as AssetDetail;
  assert.deepEqual(detail, { path: 'public/art/hero.png', refCount: 1, refs: [{ file: 'src/game.ts', line: 1, kind: 'path', text: "load.image('hero', 'art/hero.png');" }] });
  assert.equal((await call(handler, { action: 'detail', sessionId: 'game', path: 'public/art/none.png' })).status, 404);
});

test('the route refuses other pages, unknown actions, remote workspaces and missing folders', async () => {
  const handler = createHandler(service());
  assert.equal((await call(handler, { action: 'scan', sessionId: 'game' }, {})).status, 403);
  assert.equal((await call(handler, { action: 'erase', sessionId: 'game' })).status, 400);
  assert.equal((await call(handler, { action: 'scan' })).status, 400);
  assert.equal((await call(handler, { action: 'scan', sessionId: 'unknown' })).status, 409);
  const remote = await call(handler, { action: 'scan', sessionId: 'remote' });
  assert.deepEqual([remote.status, await remote.json()], [409, { error: 'Assets of a remote workspace need Remote Agents 0.2.130 or newer' }]);
  assert.equal((await call(handler, { action: 'scan', sessionId: 'gone' })).status, 404);
  assert.equal((await handler(new Request('http://dsh.test/api/game-assets', { method: 'PUT', headers: { [CLIENT_HEADER]: '1' } }))).status, 405);
});

test('images are served as inert bytes; other files, paths outside the workspace and links leading out are refused', async () => {
  const handler = createHandler(service());
  const answer = await image(handler, 'public/art/hero.png');
  assert.equal(answer.status, 200);
  assert.equal(answer.headers.get('content-type'), 'application/octet-stream');
  assert.equal(answer.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await answer.arrayBuffer()), png(32, 48, 1));
  assert.equal((await image(handler, 'src/game.ts')).status, 415);
  assert.equal((await image(handler, '../secret.png')).status, 403);
  assert.equal((await image(handler, join(outside, 'secret.png'))).status, 400);
  assert.equal((await image(handler, 'public/art/link.png')).status, 403);
  assert.equal((await image(handler, 'public/art/none.png')).status, 404);
  assert.equal((await image(handler, 'public/art/hero.png', 'remote')).status, 409);
});

test('folder settings are validated, saved for the workspace and used by later scans', async () => {
  const file = join(state, 'saved', 'workspaces.json'), handler = createHandler(service(file));
  for (const folders of [null, [], { 'a/b': { assets: true, code: true } }, { src: { assets: 'yes', code: true } }, { src: {} }])
    assert.equal((await call(handler, { action: 'configure', sessionId: 'game', folders })).status, 400);
  const configured = await (await call(handler, { action: 'configure', sessionId: 'game', folders: { src: { assets: true, code: false } } })).json() as ScanResult;
  assert.ok(configured.assets.every(asset => asset.usage === 'unused'));
  assert.deepEqual(Object.values((JSON.parse(await readFile(file, 'utf8')) as { workspaces: Record<string, unknown> }).workspaces), [{ src: { assets: true, code: false } }]);
  // A host restarted later reads the same settings.
  const later = await (await call(createHandler(service(file)), { action: 'scan', sessionId: 'game' })).json() as ScanResult;
  assert.deepEqual(later.folders.find(folder => folder.name === 'src'), { name: 'src', images: 0, codeFiles: 1, assets: true, code: false });
});

test('a scan is reused until a refresh is asked for', async () => {
  const handler = createHandler(service());
  const first = await (await call(handler, { action: 'scan', sessionId: 'game' })).json() as ScanResult;
  await put('public/art/new.png', png(4, 4, 9, 100));
  try {
    assert.equal(((await (await call(handler, { action: 'scan', sessionId: 'game' })).json()) as ScanResult).scannedAt, first.scannedAt);
    const fresh = await (await call(handler, { action: 'scan', sessionId: 'game', refresh: true })).json() as ScanResult;
    assert.ok(fresh.assets.some(asset => asset.path === 'public/art/new.png'));
  } finally { await rm(join(root, 'public/art/new.png')); }
});
