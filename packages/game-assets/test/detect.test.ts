import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { CLIENT_HEADER, type ProjectStatus } from '../src/domain.js';
import { detectEngine, engineOfPackage } from '../src/detect.js';
import { createHandler } from '../src/http.js';
import { AssetService } from '../src/service.js';

const made: string[] = [];
/** A folder holding `files`, removed after the tests. */
async function folder(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-game-detect-'));
  made.push(root);
  for (const [path, content] of Object.entries(files)) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), content); }
  return root;
}
after(async () => { for (const root of made) await rm(root, { recursive: true, force: true }); });

test('an npm manifest names its engine in any dependency group', () => {
  assert.equal(engineOfPackage('{"dependencies":{"phaser":"^4.2.1"}}'), 'Phaser');
  assert.equal(engineOfPackage('{"devDependencies":{"@pixi/react":"8"}}'), 'PixiJS');
  assert.equal(engineOfPackage('{"dependencies":{"kaplay":"1"},"devDependencies":{"vite":"8"}}'), 'KAPLAY');
  assert.equal(engineOfPackage('{"name":"game","creator":{"version":"3.8.0"}}'), 'Cocos Creator');
  for (const manifest of ['{"dependencies":{"react":"18","phaser-like":"1"}}', '{"name":"phaser"}', '{"dependencies":null}', 'not json', 'null']) assert.equal(engineOfPackage(manifest), undefined, manifest);
});

test('a folder is a game project by the engine it declares', async () => {
  const cases: [Record<string, string>, string | undefined][] = [
    [{ 'package.json': '{"dependencies":{"phaser":"^4"}}' }, 'Phaser'],
    [{ 'project.godot': '[application]' }, 'Godot'],
    [{ 'ProjectSettings/ProjectVersion.txt': 'm_EditorVersion: 6000.0.1f1', 'Assets/a.png': '' }, 'Unity'],
    [{ 'Shooter.uproject': '{}' }, 'Unreal Engine'],
    [{ 'main.lua': 'function love.draw() end' }, 'LÖVE'],
    [{ 'Cargo.toml': '[dependencies]\nbevy = "0.16"\n' }, 'Bevy'],
    [{ 'go.mod': 'require github.com/hajimehoshi/ebiten/v2 v2.8.0' }, 'Ebitengine'],
    [{ 'requirements.txt': 'numpy\npygame-ce==2.5\n' }, 'pygame'],
    [{ 'Game.csproj': '<PackageReference Include="MonoGame.Framework.DesktopGL" />' }, 'MonoGame'],
    // A repository that keeps its game beside a server.
    [{ 'package.json': '{"private":true}', 'client/package.json': '{"dependencies":{"pixi.js":"8"}}', 'server/package.json': '{"dependencies":{"express":"5"}}' }, 'PixiJS'],
    [{ 'package.json': '{"dependencies":{"react":"18"}}', 'public/logo.png': '' }, undefined],
    [{ 'main.lua': 'print("hello")', 'Cargo.toml': '[dependencies]\nserde = "1"\n' }, undefined],
    [{ 'node_modules/phaser/package.json': '{"dependencies":{"phaser":"4"}}' }, undefined],
    [{}, undefined],
  ];
  for (const [files, engine] of cases) assert.equal(await detectEngine(await folder(files)), engine, Object.keys(files).join(', '));
  assert.equal(await detectEngine(join(tmpdir(), 'dsh-game-detect-missing')), undefined);
});

test('the route says whether a workspace gets the tab, and keeps the user’s choice and the tab mode', async () => {
  const game = await folder({ 'package.json': '{"dependencies":{"phaser":"^4"}}' }), site = await folder({ 'package.json': '{"dependencies":{"react":"18"}}' });
  const state = join(await folder({}), 'workspaces.json');
  const cwds: Record<string, string> = { game, site, remote: '/home/me/.dsh/remote-workspaces/box/app' };
  const handler = () => createHandler(new AssetService(async id => cwds[id], state));
  const ask = async (route: ReturnType<typeof handler>, body: Record<string, unknown>) => {
    const answer = await route(new Request('http://dsh.test/api/game-assets', { method: 'POST', headers: { 'content-type': 'application/json', [CLIENT_HEADER]: '1' }, body: JSON.stringify(body) }));
    return { status: answer.status, body: await answer.json() as ProjectStatus & { mode: string } };
  };
  const route = handler(), name = (root: string) => root.split('/').pop()!;
  assert.deepEqual((await ask(route, { action: 'project', sessionId: 'game' })).body, { root: name(game), engine: 'Phaser', override: null, game: true, mode: 'games' });
  assert.deepEqual((await ask(route, { action: 'project', sessionId: 'site' })).body, { root: name(site), engine: null, override: null, game: false, mode: 'games' });
  // Without a local workspace there is nothing to show, and nothing to refuse either.
  for (const sessionId of ['remote', 'unknown']) assert.deepEqual(await ask(route, { action: 'project', sessionId }), { status: 200, body: { root: null, engine: null, override: null, game: false, mode: 'games' } });

  assert.deepEqual((await ask(route, { action: 'setProject', sessionId: 'site', game: true })).body, { root: name(site), engine: null, override: true, game: true, mode: 'games' });
  assert.deepEqual((await ask(route, { action: 'setProject', sessionId: 'game', game: false })).body, { root: name(game), engine: 'Phaser', override: false, game: false, mode: 'games' });
  assert.deepEqual(await ask(route, { action: 'setMode', mode: 'all' }), { status: 200, body: { mode: 'all' } as never });
  for (const body of [{ action: 'setProject', sessionId: 'site', game: 'yes' }, { action: 'setProject', sessionId: 'site' }, { action: 'setMode', mode: 'none' }]) assert.equal((await ask(route, body)).status, 400);
  assert.equal((await ask(route, { action: 'setProject', sessionId: 'remote', game: true })).status, 409);

  // A host restarted later remembers all of it; `null` goes back to the detection.
  const later = handler();
  assert.deepEqual(await ask(later, { action: 'mode' }), { status: 200, body: { mode: 'all' } as never });
  assert.deepEqual((await ask(later, { action: 'project', sessionId: 'site' })).body, { root: name(site), engine: null, override: true, game: true, mode: 'all' });
  assert.deepEqual((await ask(later, { action: 'setProject', sessionId: 'game', game: null })).body, { root: name(game), engine: 'Phaser', override: null, game: true, mode: 'all' });
});
