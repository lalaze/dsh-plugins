import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { build } from 'esbuild';
import { codexPrompt, runCodex } from '../src/codex.js';
import { readProjectSource, writeProjectSource, type ProjectBundle } from '../src/project.js';
import { CODEX_PICTURE, fakeCodex } from './fake-codex.js';

const png = (fill: number, length = 64, size = 16) => {
  const data = Buffer.alloc(length, fill);
  data.writeUInt32BE(0x89504e47, 0); data.writeUInt32BE(0x0d0a1a0a, 4); data.writeUInt32BE(13, 8); data.write('IHDR', 12, 'latin1');
  data.writeUInt32BE(size, 16); data.writeUInt32BE(size, 20);
  return data;
};
const made: string[] = [];
const temp = async (prefix: string) => { const dir = await mkdtemp(join(tmpdir(), prefix)); made.push(dir); return dir; };
after(async () => { for (const dir of made) await rm(dir, { recursive: true, force: true }); });

let bin = '', script = '', calls: Awaited<ReturnType<typeof fakeCodex>>['calls'];
const PICTURE = CODEX_PICTURE;
before(async () => {
  const fake = await fakeCodex();
  made.push(...fake.dirs); bin = fake.bin; calls = fake.calls;
  const { projectBundle } = await import(new URL('../scripts/build-remote.mjs', import.meta.url).href) as { projectBundle: Record<string, unknown> };
  script = (await build({ ...projectBundle, absWorkingDir: fileURLToPath(new URL('../', import.meta.url)), write: false })).outputFiles[0].text;
});

test('Codex is asked for one picture from its image tool, with the references attached, in an empty folder it may only read', async () => {
  const refs = await temp('dsh-codex-refs-');
  await writeFile(join(refs, 'hero.png'), png(1));
  const picture = await runCodex({ prompt: 'a blue slime', references: [join(refs, 'hero.png')], aspect: 'wide', transparent: true, model: 'gpt-5.5' }, { command: join(bin, 'codex') });
  assert.deepEqual([picture.mediaType, picture.width, picture.text, picture.data.equals(PICTURE)], ['image/png', 1024, 'Here is the slime.', true]);
  const [call] = (await calls()).slice(-1);
  assert.deepEqual(call.args.slice(0, 7), ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '--cd', call.args[6]]);
  assert.deepEqual(call.args.slice(7), ['--model', 'gpt-5.5', '--image', join(refs, 'hero.png')]);
  assert.match(call.args[6], /dsh-game-assets-codex-/);
  assert.equal(await stat(call.args[6]).then(() => true, () => false), false, 'the scratch folder is removed');
  assert.equal(call.prompt, codexPrompt({ prompt: 'a blue slime', references: ['x'], aspect: 'wide', transparent: true }));
  assert.match(call.prompt, /^Use your image generation tool to create exactly one image, landscape \(3:2\), on a transparent background\.\nThe attached image is the reference for it\.\n.*\n\nImage request:\na blue slime$/);
  assert.doesNotMatch(codexPrompt({ prompt: 'p', references: [], aspect: 'square', transparent: false }), /attached|transparent/);
});

test('a picture Codex reports inline is taken too; a failed login, a missing Codex and a turn without a picture are explained', async () => {
  process.env.FAKE_CODEX_MODE = 'inline';
  try { assert.equal((await runCodex({ prompt: 'p', references: [], aspect: 'square', transparent: false }, { command: join(bin, 'codex') })).data.equals(PICTURE), true); }
  finally { process.env.FAKE_CODEX_MODE = 'ok'; }
  process.env.FAKE_CODEX_MODE = 'auth';
  try {
    await assert.rejects(runCodex({ prompt: 'p', references: [], aspect: 'square', transparent: false }, { command: join(bin, 'codex') }),
      /^Error: Codex made no picture \(exit 1\): Your access token could not be refreshed because your refresh token was revoked\. Please log out and sign in again\.$/);
  } finally { process.env.FAKE_CODEX_MODE = 'ok'; }
  await assert.rejects(runCodex({ prompt: 'p', references: [], aspect: 'square', transparent: false }, { command: join(bin, 'nowhere') }), /Codex was not found on this machine/);
  // Through a login shell, as DSH started from the Dock needs, the command and its arguments arrive intact.
  const shell = process.env.SHELL;
  process.env.SHELL = '/bin/sh';
  try { assert.equal((await runCodex({ prompt: "it's a 'quoted' prompt", references: [], aspect: 'tall', transparent: false }, { command: join(bin, 'codex'), loginShell: true })).mediaType, 'image/png'); }
  finally { process.env.SHELL = shell; }
  assert.match((await calls()).at(-1)!.prompt, /it's a 'quoted' prompt$/);
});

const bundle = (kind: 'codex' | 'openai', extra: Partial<ProjectBundle['source']> = {}): ProjectBundle => ({
  source: { id: `src-${kind}`, name: kind === 'codex' ? 'Codex' : 'Relay', kind, model: kind === 'codex' ? '' : 'gpt-image-2', baseUrl: kind === 'codex' ? '' : 'https://relay.example/v1', ...extra },
  script, ...(kind === 'openai' ? { key: 'sk-project-9876' } : {}),
});

test('recording a source writes .game-assets and a section in the agent files, the key only to the home folder; removing it restores the files', async () => {
  const root = await temp('dsh-project-'), home = await temp('dsh-project-home-');
  await writeFile(join(root, 'AGENTS.md'), '# Agents\n\nRun npm test before committing.\n');
  await symlink('AGENTS.md', join(root, 'CLAUDE.md'));

  const status = await writeProjectSource(root, bundle('openai'), home);
  assert.deepEqual(status, { source: { id: 'src-openai', name: 'Relay', kind: 'openai', model: 'gpt-image-2', baseUrl: 'https://relay.example/v1' },
    files: ['.game-assets/image-source.json', '.game-assets/generate-image.cjs', '.game-assets/README.md', 'AGENTS.md'] });
  const recorded = await readFile(join(root, '.game-assets/image-source.json'), 'utf8');
  assert.doesNotMatch(recorded, /sk-project/);
  assert.equal((await stat(join(root, '.game-assets/generate-image.cjs'))).mode & 0o111, 0o111);
  const agents = await readFile(join(root, 'AGENTS.md'), 'utf8');
  assert.match(agents, /^# Agents\n\nRun npm test before committing\.\n\n<!-- dsh-game-assets:image-source -->\n## Generating images\n\nThis project generates images with the image source "Relay" \(an OpenAI-compatible image API, model gpt-image-2\)/);
  assert.match(agents, /node \.game-assets\/generate-image\.cjs --prompt "a blue slime, pixel art" --out assets\/slime\.png/);
  assert.equal(await readlink(join(root, 'CLAUDE.md')), 'AGENTS.md', 'a CLAUDE.md that links to AGENTS.md stays a link and is written once');
  const keys = join(home, '.dsh-game-assets/keys.json');
  assert.deepEqual(JSON.parse(await readFile(keys, 'utf8')), { version: 1, keys: { 'src-openai': { name: 'Relay', key: 'sk-project-9876' } } });
  assert.deepEqual([(await stat(keys)).mode & 0o777, (await stat(dirname(keys))).mode & 0o777], [0o600, 0o700]);

  // Another source replaces the section rather than adding one; Codex needs no key.
  await writeProjectSource(root, bundle('codex'), home);
  const again = await readFile(join(root, 'AGENTS.md'), 'utf8');
  assert.equal(again.split('<!-- dsh-game-assets:image-source -->').length, 2);
  assert.match(again, /the image source "Codex" \(the Codex CLI signed in on this machine\)/);
  assert.match(await readFile(join(root, '.game-assets/README.md'), 'utf8'), /run `codex login` on the machine once/);

  const removed = await writeProjectSource(root, null, home);
  assert.deepEqual(removed, { source: null, files: [] });
  assert.equal(await readFile(join(root, 'AGENTS.md'), 'utf8'), '# Agents\n\nRun npm test before committing.\n');
  assert.deepEqual(await readdir(root), ['AGENTS.md', 'CLAUDE.md']);
});

test('a project without agent files gets both, and loses them again with the source; something else named .game-assets is left alone', async () => {
  const root = await temp('dsh-project-bare-'), home = await temp('dsh-project-home-');
  await writeProjectSource(root, bundle('codex'), home);
  assert.deepEqual((await readProjectSource(root)).files, ['.game-assets/image-source.json', '.game-assets/generate-image.cjs', '.game-assets/README.md', 'AGENTS.md', 'CLAUDE.md']);
  assert.match(await readFile(join(root, 'CLAUDE.md'), 'utf8'), /^<!-- dsh-game-assets:image-source -->\n/);
  assert.deepEqual(await readdir(home), [], 'Codex leaves no key behind');
  await writeProjectSource(root, null, home);
  assert.deepEqual(await readdir(root), []);

  const blocked = await temp('dsh-project-blocked-');
  await writeFile(join(blocked, '.game-assets'), 'mine');
  await assert.rejects(writeProjectSource(blocked, bundle('codex'), home), /\.game-assets is in the way: it is not a folder/);
  assert.equal(await readFile(join(blocked, '.game-assets'), 'utf8'), 'mine');
  assert.equal((await lstat(join(blocked, 'AGENTS.md')).catch(() => undefined)), undefined);
});

/** Runs the project's script as an agent would, from a folder of the project. */
/** Asynchronous, as an image API this test serves must keep answering while the script runs. */
const run = (root: string, args: string[], env: Record<string, string> = {}, cwd = root) => new Promise<{ code: number | null; out: string; err: string }>(resolve => {
  const child = spawn(process.execPath, [join(root, '.game-assets/generate-image.cjs'), ...args], { cwd, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env } });
  let out = '', err = '';
  child.stdout.on('data', chunk => { out += chunk; }); child.stderr.on('data', chunk => { err += chunk; });
  child.on('close', code => resolve({ code, out: out.trim(), err: err.split('\n').filter(line => !/UNDICI|trace-warnings/.test(line)).join('\n').trim() }));
});

test('an agent runs the project script with Codex: references from the project, the picture saved at a free path', async () => {
  const root = await temp('dsh-project-run-'), home = await temp('dsh-project-home-');
  await mkdir(join(root, 'art'), { recursive: true });
  await writeFile(join(root, 'art/hero.png'), png(1));
  await writeProjectSource(root, bundle('codex'), home);

  const made = await run(root, ['--prompt', 'winter hero', '--ref', 'hero.png', '--out', 'hero-winter.png', '--transparent', '--shape', 'tall'], {}, join(root, 'art'));
  assert.equal(made.code, 0, made.err);
  assert.deepEqual(JSON.parse(made.out), { path: 'art/hero-winter.png', width: 1024, height: 1024, bytes: 120, source: 'Codex' });
  assert.deepEqual(await readFile(join(root, 'art/hero-winter.png')), PICTURE);
  const call = (await calls()).at(-1)!;
  assert.equal(call.args.at(-1), join(await import('node:fs/promises').then(fs => fs.realpath(root)), 'art/hero.png'));
  assert.match(call.prompt, /portrait \(2:3\), on a transparent background\.[\s\S]*winter hero$/);

  const taken = await run(root, ['--prompt', 'again', '--out', 'art/hero-winter.png']);
  assert.deepEqual([taken.code, taken.err], [1, 'generate-image: A file of that name is already there']);
  const outside = await run(root, ['--prompt', 'p', '--out', '../escape.png']);
  assert.match(outside.err, /^--out must be inside the project: \.\.\/escape\.png/);
  const missing = await run(root, ['--out', 'a.png']);
  assert.match(missing.err, /^--prompt is required\n\nUsage: node \.game-assets\/generate-image\.cjs/);
  // A name in another format than the picture is corrected, not mislabelled.
  const renamed = await run(root, ['--prompt', 'p', '--out', 'art/other.webp']);
  assert.deepEqual(JSON.parse(renamed.out).path, 'art/other.png');
});

test('with an API source the script uses the key saved on this machine, or DSH_IMAGE_API_KEY', async () => {
  const seen: { url?: string; auth?: string }[] = [];
  const server = createServer((request, response) => {
    seen.push({ url: request.url, auth: request.headers.authorization });
    request.resume();
    request.on('end', () => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ data: [{ b64_json: PICTURE.toString('base64') }] })); });
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  try {
    const port = (server.address() as { port: number }).port;
    const root = await temp('dsh-project-api-'), home = await temp('dsh-project-home-');
    await writeProjectSource(root, bundle('openai', { baseUrl: `http://127.0.0.1:${port}/v1` }), home);
    const env = { HOME: home, NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' };
    const made = await run(root, ['--prompt', 'a coin', '--out', 'coin.png'], env);
    assert.equal(made.code, 0, made.err);
    assert.deepEqual(seen.at(-1), { url: '/v1/images/generations', auth: 'Bearer sk-project-9876' });
    assert.equal((await run(root, ['--prompt', 'a coin', '--out', 'coin2.png'], { ...env, DSH_IMAGE_API_KEY: 'sk-env-1' })).code, 0);
    assert.equal(seen.at(-1)!.auth, 'Bearer sk-env-1');
    const elsewhere = await run(root, ['--prompt', 'a coin', '--out', 'coin3.png'], { ...env, HOME: await temp('dsh-other-home-') });
    assert.match(elsewhere.err, /No API key for "Relay" on this machine/);
  } finally { server.close(); }
});
