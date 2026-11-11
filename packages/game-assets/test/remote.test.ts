import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';
import { CLIENT_HEADER, type MoveResult, type ProjectStatus, type ScanResult, type TagResult } from '../src/domain.js';
import { createHandler } from '../src/http.js';
import { REMOTE_BEGIN, REMOTE_END, remoteAnswer, remoteCommand, type RemoteMachines, type RemoteTarget } from '../src/remote.js';
import { AssetError, AssetService } from '../src/service.js';

const png = (fill: number, length = 64) => {
  const data = Buffer.alloc(length, fill);
  data.writeUInt32BE(0x89504e47, 0); data.writeUInt32BE(0x0d0a1a0a, 4); data.writeUInt32BE(13, 8); data.write('IHDR', 12, 'latin1');
  data.writeUInt32BE(16, 16); data.writeUInt32BE(16, 20);
  return data;
};
const made: string[] = [];
let script = '';
before(async () => {
  // The script as the build ships it: one file for a remote machine's Node.js.
  const result = await build({ absWorkingDir: fileURLToPath(new URL('../', import.meta.url)), entryPoints: ['src/remote-agent.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node18', minify: true, write: false });
  script = result.outputFiles[0].text;
});
after(async () => { for (const dir of made) await rm(dir, { recursive: true, force: true }); });
const exists = (file: string) => access(file).then(() => true, () => false);

/**
 * A game on a "remote machine": this computer, reached only by running the shell commands the plugin sends, with a home
 * folder of its own. The conversation's local folder is Remote Agents' anchor, which holds none of the game's files.
 */
async function remoteGame(options: { stream?: (command: string) => { output: string; code: number } | undefined } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-game-remote-')), home = await mkdtemp(join(tmpdir(), 'dsh-game-remote-home-')), state = await mkdtemp(join(tmpdir(), 'dsh-game-remote-state-'));
  const outside = await mkdtemp(join(tmpdir(), 'dsh-game-remote-out-'));
  made.push(root, home, state, outside);
  const put = async (path: string, content: string | Buffer, base = root) => { await mkdir(dirname(join(base, path)), { recursive: true }); await writeFile(join(base, path), content); };
  await put('package.json', '{"dependencies":{"phaser":"4"}}');
  await put('src/game.ts', "load.image('hero', 'art/hero.png');\nload.image(k, `art/cast-v2/${id}.png`);\n");
  await put('public/art/hero.png', png(1));
  await put('public/art/cast-v1/a.png', png(2, 70));
  await put('public/art/cast-v2/a.png', png(3, 80));
  await put('secret.png', png(9), outside);
  await symlink(outside, join(root, 'public/linked'));
  const runs: string[] = [], verified: (RemoteTarget | undefined)[] = [];
  let moved = false;
  const machines: RemoteMachines = {
    async target(sessionId, _signal, expected) {
      if (sessionId !== 'remote') throw new Error('This conversation is not on a remote machine');
      if (expected) { verified.push(expected); if (moved) throw new Error('The conversation moved to another machine'); }
      return { hostId: 'mini', label: 'Mac mini', cwd: root };
    },
    async withWorkspace(hostId, verify, action) {
      assert.equal(hostId, 'mini');
      await verify();
      return action({ stream: (cwd, command, env, output) => new Promise(resolve => {
        runs.push(command);
        const fake = options.stream?.(command);
        if (fake) { output(Buffer.from(fake.output)); resolve(fake.code); return; }
        const child = spawn('/bin/sh', ['-c', command], { cwd, env: { ...process.env, ...env, HOME: home } });
        child.stdout.on('data', output); child.stderr.on('data', output);
        child.on('close', code => resolve(code));
      }) });
    },
  };
  const cwds: Record<string, string> = { remote: '/home/me/.dsh/remote-workspaces/mini/game', local: root };
  const service = (withMachines = true) => new AssetService(async id => cwds[id], join(state, 'workspaces.json'), { machines: () => withMachines ? machines : undefined, remoteScript: async () => script });
  const handler = createHandler(service());
  const call = async <T>(body: Record<string, unknown>, route = handler) => {
    const answer = await route(new Request('http://dsh.test/api/game-assets', { method: 'POST', headers: { 'content-type': 'application/json', [CLIENT_HEADER]: '1' }, body: JSON.stringify({ sessionId: 'remote', ...body }) }));
    return { status: answer.status, body: await answer.json() as T };
  };
  const image = (path: string) => handler(new Request(`http://dsh.test/api/game-assets?sessionId=remote&path=${encodeURIComponent(path)}`, { headers: { [CLIENT_HEADER]: '1' } }));
  return { root, home, outside, put, call, image, runs, verified, service, move: () => { moved = true; } };
}

test('the command carries the script and its request to node; the answer is found among other output', () => {
  const command = remoteCommand('console.log(1)', { op: 'detect' });
  assert.match(command, /^node --no-warnings - <<'DSH_GAME_ASSETS_SCRIPT_END'\nglobalThis\.__DSH_GAME_ASSETS_REQUEST__="[A-Za-z0-9+/=]+";\nconsole\.log\(1\)\nDSH_GAME_ASSETS_SCRIPT_END$/);
  assert.throws(() => remoteCommand('x\nDSH_GAME_ASSETS_SCRIPT_END\ny', { op: 'detect' }));
  const wrap = (answer: unknown) => `${REMOTE_BEGIN}${gzipSync(JSON.stringify(answer)).toString('base64')}${REMOTE_END}`;
  assert.deepEqual(remoteAnswer(`(node:1) Warning: something\n\n${wrap({ ok: true, result: { engine: 'Godot' } })}\n`, 0), { engine: 'Godot' });
  assert.throws(() => remoteAnswer(wrap({ ok: false, error: 'File not found', status: 404 }), 0), (error: unknown) => error instanceof AssetError && error.status === 404 && error.message === 'File not found');
  assert.throws(() => remoteAnswer('sh: node: command not found\n', 127), (error: unknown) => error instanceof AssetError && error.status === 502 && error.message === 'Node.js was not found on the remote machine');
  assert.throws(() => remoteAnswer('Killed\n', 137), /The remote machine could not answer \(exit 137\): Killed/);
  assert.throws(() => remoteAnswer(`${REMOTE_BEGIN}not-gzip${REMOTE_END}`, 0), /answer could not be read/);
});

test('a remote workspace is detected and scanned on its machine, with the answer a local scan of the same folder gives', async () => {
  const game = await remoteGame();
  assert.deepEqual((await game.call<ProjectStatus>({ action: 'project' })).body, { root: game.root.split('/').pop(), host: 'Mac mini', engine: 'Phaser', override: null, game: true, mode: 'games' });
  const remote = (await game.call<ScanResult>({ action: 'scan' })).body, local = (await game.call<ScanResult>({ action: 'scan', sessionId: 'local' })).body;
  assert.deepEqual(remote.assets.map(asset => [asset.path, asset.usage, asset.width]), [['public/art/cast-v1/a.png', 'unused', 16], ['public/art/cast-v2/a.png', 'maybe', 16], ['public/art/hero.png', 'used', 16]]);
  assert.deepEqual([remote.assets, remote.families, remote.folders, remote.root], [local.assets, local.families, local.folders, local.root]);
  // Each run was of the verified workspace, and what the scan measured is kept on the machine for the next one.
  assert.ok(game.verified.length >= 2 && game.verified.every(target => target?.cwd === game.root));
  assert.equal((await readdir(join(game.home, '.dsh-remote-agents/game-assets'))).length, 1);
  const before = game.runs.length;
  await game.call<ScanResult>({ action: 'scan' });
  assert.equal(game.runs.length, before, 'a scan is reused until a refresh is asked for');
  assert.equal((await game.call<ScanResult>({ action: 'scan', refresh: true })).body.assets.length, 3);
  assert.equal(game.runs.length, before + 1);
});

test('thumbnails asked for together reach the machine in one run; paths outside the workspace are refused there', async () => {
  const game = await remoteGame();
  const [hero, a, missing, outside, linked] = await Promise.all(['public/art/hero.png', 'public/art/cast-v1/a.png', 'public/art/none.png', '../secret.png', 'public/linked/secret.png'].map(game.image));
  assert.equal(game.runs.length, 1);
  assert.deepEqual([hero.status, a.status, missing.status, outside.status, linked.status], [200, 200, 404, 403, 403]);
  assert.deepEqual(Buffer.from(await hero.arrayBuffer()), png(1));
  assert.deepEqual(Buffer.from(await a.arrayBuffer()), png(2, 70));
  assert.equal(hero.headers.get('content-type'), 'application/octet-stream');
});

test('images of a remote workspace are retired, restored and tagged on its machine', async () => {
  const game = await remoteGame();
  await game.call<ScanResult>({ action: 'scan' });
  assert.deepEqual((await game.call<TagResult>({ action: 'tag', paths: ['public/art/cast-v1/a.png'], add: ['old'] })).body, { tags: { 'public/art/cast-v1/a.png': ['old'] } });
  const retired = (await game.call<MoveResult>({ action: 'retire', paths: ['public/art/cast-v1/a.png', 'src/game.ts'] })).body;
  assert.deepEqual([retired.moved, retired.failed], [1, [{ path: 'src/game.ts', error: 'Not an image of this workspace' }]]);
  assert.deepEqual([await exists(join(game.root, 'public/art/cast-v1')), await exists(join(game.root, '_retired/public/art/cast-v1/a.png'))], [false, true]);
  const shelved = retired.scan.assets.find(asset => asset.retired)!;
  assert.deepEqual([shelved.path, shelved.origin, shelved.tags], ['_retired/public/art/cast-v1/a.png', 'public/art/cast-v1/a.png', ['old']]);
  assert.equal((await game.call<MoveResult>({ action: 'restore', paths: [shelved.path] })).body.moved, 1);
  assert.equal(await exists(join(game.root, 'public/art/cast-v1/a.png')), true);
  assert.deepEqual((await game.call<{ note: string }>({ action: 'note', path: 'public/art/hero.png', note: ' the hero ' })).body, { note: 'the hero' });
  assert.deepEqual(JSON.parse(await readFile(join(game.root, '.game-assets.json'), 'utf8')), { version: 1, tags: { 'public/art/cast-v1/a.png': ['old'] }, notes: { 'public/art/hero.png': 'the hero' } });
  // Settings of a remote workspace are kept apart from a local folder of the same path.
  assert.equal((await game.call<ScanResult>({ action: 'configure', folders: { src: { assets: true, code: false } } })).body.assets.every(asset => asset.usage === 'unused'), true);
  assert.equal((await game.call<ScanResult>({ action: 'scan', sessionId: 'local', refresh: true })).body.assets.some(asset => asset.usage === 'used'), true);
});

test('a long selection travels in several runs', async () => {
  const game = await remoteGame();
  for (let i = 0; i < 230; i++) await game.put(`public/art/bulk/sprite-${String(i).padStart(3, '0')}.png`, png(4, 64 + i));
  const scan = (await game.call<ScanResult>({ action: 'scan' })).body, paths = scan.assets.filter(asset => asset.path.includes('/bulk/')).map(asset => asset.path);
  const before = game.runs.length;
  const tagged = (await game.call<TagResult>({ action: 'tag', paths, add: ['bulk'] })).body;
  assert.equal(Object.keys(tagged.tags).length, 230);
  assert.equal(game.runs.length, before + 2);
  assert.ok(game.runs.every(command => Buffer.byteLength(command) < 100 * 1024), 'every command fits one shell argument');
  const retired = (await game.call<MoveResult>({ action: 'retire', paths })).body;
  assert.deepEqual([retired.moved, retired.failed, (await readdir(join(game.root, '_retired/public/art/bulk'))).length], [230, [], 230]);
});

test('what cannot work says why: no Remote Agents service, no Node.js, a conversation that moved', async () => {
  const game = await remoteGame();
  const without = createHandler(game.service(false));
  assert.deepEqual(await game.call({ action: 'scan' }, without), { status: 409, body: { error: 'Assets of a remote workspace need Remote Agents 0.2.130 or newer' } });
  assert.deepEqual((await game.call<ProjectStatus>({ action: 'project' }, without)).body, { root: null, host: null, engine: null, override: null, game: false, mode: 'games' });

  const bare = await remoteGame({ stream: () => ({ output: 'sh: node: command not found\n', code: 127 }) });
  assert.deepEqual(await bare.call({ action: 'scan' }), { status: 502, body: { error: 'Node.js was not found on the remote machine' } });
  // The tab's choice still works for a machine that cannot be asked: its engine is simply unknown.
  assert.deepEqual((await bare.call<ProjectStatus>({ action: 'project' })).body, { root: bare.root.split('/').pop(), host: 'Mac mini', engine: null, override: null, game: false, mode: 'games' });
  assert.equal((await bare.call<ProjectStatus>({ action: 'setProject', game: true })).body.game, true);

  game.move();
  const moved = await game.call<{ error: string }>({ action: 'scan' });
  assert.deepEqual([moved.status, moved.body.error], [502, 'The remote machine could not be reached: The conversation moved to another machine']);
});
