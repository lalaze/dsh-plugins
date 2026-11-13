import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { CLIENT_HEADER, type GeneratedImage, type ProjectSourceStatus, type RevertResult, type SaveResult, type ScanResult, type SourcesAnswer } from '../src/domain.js';
import { createHandler } from '../src/http.js';
import { cleanImagePath } from '../src/manage.js';
import { AssetService } from '../src/service.js';
import { SourceStore, cleanSource, generateImage, type ImageSource } from '../src/sources.js';
import { CODEX_PICTURE, fakeCodex } from './fake-codex.js';

const png = (fill: number, length = 64, size = 16) => {
  const data = Buffer.alloc(length, fill);
  data.writeUInt32BE(0x89504e47, 0); data.writeUInt32BE(0x0d0a1a0a, 4); data.writeUInt32BE(13, 8); data.write('IHDR', 12, 'latin1');
  data.writeUInt32BE(size, 16); data.writeUInt32BE(size, 20);
  return data;
};
const gif = () => Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.from([16, 0, 16, 0]), Buffer.alloc(20)]);
const made: string[] = [];
after(async () => { for (const dir of made) await rm(dir, { recursive: true, force: true }); });
const temp = async (prefix: string) => { const dir = await mkdtemp(join(tmpdir(), prefix)); made.push(dir); return dir; };

interface Sent { url: string; method?: string; headers: Record<string, string>; body?: unknown; form?: Record<string, unknown[]> }
/** An image API that records what it was sent and answers what the test says. */
function api(answer: (sent: Sent) => Response | Promise<Response>) {
  const sent: Sent[] = [];
  const fetch = async (url: string, init: RequestInit = {}) => {
    const entry: Sent = { url, method: init.method, headers: Object.fromEntries(new Headers(init.headers).entries()) };
    if (typeof init.body === 'string') entry.body = JSON.parse(init.body);
    if (init.body instanceof FormData) {
      entry.form = {};
      for (const [name, value] of init.body.entries()) (entry.form[name] ??= []).push(typeof value === 'string' ? value : { name: value.name, type: value.type, bytes: Buffer.from(await value.arrayBuffer()) });
    }
    sent.push(entry);
    return answer(entry);
  };
  return { sent, fetch };
}
const openaiSource: ImageSource = { id: 'o', name: 'OpenAI', kind: 'openai', baseUrl: 'https://relay.example/v1', model: 'gpt-image-2', apiKey: 'sk-secret-123456' };
const geminiSource: ImageSource = { id: 'g', name: 'Gemini', kind: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-3.1-flash-image', apiKey: 'AIza-secret-9876' };

test('a source is saved only in a plain form, and editing it keeps the key unless a new one is given', () => {
  assert.deepEqual(cleanSource({ name: ' Relay ', kind: 'openai', baseUrl: 'https://relay.example/v1/ ', model: 'models/gpt-image-2', apiKey: ' sk-1 ' }),
    { name: 'Relay', kind: 'openai', baseUrl: 'https://relay.example/v1', model: 'gpt-image-2', apiKey: 'sk-1' });
  assert.equal(cleanSource({ name: 'x', kind: 'gemini', baseUrl: 'http://127.0.0.1:8080', model: 'm' }, openaiSource).apiKey, openaiSource.apiKey);
  for (const bad of [{ name: '' }, { kind: 'midjourney' }, { baseUrl: 'ftp://x' }, { baseUrl: 'relay.example' }, { baseUrl: 'https://user:pw@relay.example' }, { model: '' }, { model: 'a b' }, { apiKey: 'a\nb' }])
    assert.throws(() => cleanSource({ name: 'x', kind: 'openai', baseUrl: 'https://relay.example', model: 'm', ...bad }), JSON.stringify(bad));
});

test('sources are kept in a private file; the client sees them without their keys', async () => {
  const file = join(await temp('dsh-game-sources-'), 'image-sources.json'), store = new SourceStore(file);
  await assert.rejects(store.get(), /Add an image source first/);
  const first = await store.put({ name: 'Relay', kind: 'openai', baseUrl: 'https://relay.example/v1', model: 'gpt-image-2', apiKey: 'sk-abcdef-7890' });
  assert.deepEqual(first.sources, [{ id: first.id, name: 'Relay', kind: 'openai', baseUrl: 'https://relay.example/v1', model: 'gpt-image-2', keyHint: '…7890' }]);
  assert.equal(first.defaultId, first.id, 'the first source becomes the default');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.doesNotMatch(JSON.stringify(await store.list()), /sk-abcdef/);
  const second = await store.put({ name: 'Gemini', kind: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-3.1-flash-image', apiKey: 'AIza-1' });
  assert.equal(second.defaultId, first.id);
  await store.put({ id: first.id, name: 'Relay 2', kind: 'openai', baseUrl: 'https://relay.example/v1', model: 'gpt-image-1.5' });
  assert.equal((await store.get(first.id)).apiKey, 'sk-abcdef-7890');
  await store.setDefault(second.id);
  assert.equal((await store.get()).name, 'Gemini');
  // A new process reads what was saved; removing the default makes the next one the default.
  const again = new SourceStore(file);
  assert.deepEqual((await again.list()).sources.map(source => source.name), ['Relay 2', 'Gemini']);
  assert.equal((await again.remove(second.id)).defaultId, first.id);
  await assert.rejects(again.put({ id: 'gone', name: 'x', kind: 'openai', baseUrl: 'https://x.example', model: 'm' }), /removed/);
});

test('OpenAI: a prompt alone is a generation; references make an edit sent as files', async () => {
  const { sent, fetch } = api(() => Response.json({ data: [{ b64_json: png(1).toString('base64'), revised_prompt: 'a cat' }] }));
  const plain = await generateImage(openaiSource, { prompt: 'a cat', references: [], aspect: 'wide', transparent: true }, { fetch });
  assert.deepEqual([plain.mediaType, plain.width, plain.text], ['image/png', 16, 'a cat']);
  assert.equal(sent[0].url, 'https://relay.example/v1/images/generations');
  assert.equal(sent[0].headers.authorization, 'Bearer sk-secret-123456');
  assert.deepEqual(sent[0].body, { model: 'gpt-image-2', prompt: 'a cat', size: '1536x1024', background: 'transparent', output_format: 'png', n: 1 });

  await generateImage(openaiSource, { prompt: 'redraw', references: [{ name: 'hero.png', data: png(2), mediaType: 'image/png' }], aspect: 'square', transparent: false }, { fetch });
  assert.equal(sent[1].url, 'https://relay.example/v1/images/edits');
  assert.equal(sent[1].headers['content-type'], undefined, 'the form sets its own boundary');
  assert.deepEqual(sent[1].form?.image, [{ name: 'hero.png', type: 'image/png', bytes: png(2) }]);
  assert.deepEqual([sent[1].form?.prompt, sent[1].form?.size, sent[1].form?.background], [['redraw'], ['1024x1024'], undefined]);

  await generateImage(openaiSource, { prompt: 'two', references: [{ name: 'a.png', data: png(3), mediaType: 'image/png' }, { name: 'b.webp', data: png(4), mediaType: 'image/webp' }], aspect: 'tall', transparent: false }, { fetch });
  assert.equal(sent[2].form?.['image[]']?.length, 2);
  assert.deepEqual(sent[2].form?.size, ['1024x1536']);
});

test('OpenAI: a link to the picture is downloaded without the key; refusals are explained without it', async () => {
  const { sent, fetch } = api(entry => entry.url.startsWith('https://files.example') ? new Response(new Uint8Array(png(5))) : Response.json({ data: [{ url: 'https://files.example/p.png' }] }));
  assert.equal((await generateImage({ ...openaiSource, baseUrl: 'https://relay.example/v1?api-version=2' }, { prompt: 'p', references: [], aspect: 'square', transparent: false }, { fetch })).mediaType, 'image/png');
  assert.equal(sent[0].url, 'https://relay.example/v1/images/generations?api-version=2');
  assert.equal(sent[1].headers.authorization, undefined);

  const refused = api(() => Response.json({ error: { message: 'Incorrect API key provided: sk-secret-123456.' } }, { status: 401 }));
  await assert.rejects(generateImage(openaiSource, { prompt: 'p', references: [], aspect: 'square', transparent: false }, { fetch: refused.fetch }),
    (error: Error & { status?: number }) => error.message === 'OpenAI refused the request (401): Incorrect API key provided: ….' && error.status === 502);
  const html = api(() => new Response('<html><body><h1>502 Bad Gateway</h1></body></html>', { status: 502 }));
  await assert.rejects(generateImage(openaiSource, { prompt: 'p', references: [], aspect: 'square', transparent: false }, { fetch: html.fetch }), /refused the request \(502\): 502 Bad Gateway$/);
  const notImage = api(() => Response.json({ data: [{ b64_json: Buffer.from('<svg/>').toString('base64') }] }));
  await assert.rejects(generateImage(openaiSource, { prompt: 'p', references: [], aspect: 'square', transparent: false }, { fetch: notImage.fetch }), /other than a PNG, JPEG or WebP/);
  const down = async () => { throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }); };
  await assert.rejects(generateImage(openaiSource, { prompt: 'p', references: [], aspect: 'square', transparent: false }, { fetch: down }), /^Error: relay\.example could not be reached: ECONNREFUSED$/);
  const slow = (_url: string, init?: RequestInit) => new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)));
  await assert.rejects(generateImage(openaiSource, { prompt: 'p', references: [], aspect: 'square', transparent: false }, { fetch: slow, timeoutMs: 20 }), /took too long/);
});

test('Gemini: references and prompt go to generateContent; the picture is read from the parts of the answer', async () => {
  const { sent, fetch } = api(() => Response.json({ candidates: [{ content: { parts: [{ text: 'Here it is.' }, { inlineData: { mimeType: 'image/png', data: png(6).toString('base64') } }] } }] }));
  const picture = await generateImage(geminiSource, { prompt: 'redraw', references: [{ name: 'hero.png', data: png(2), mediaType: 'image/png' }], aspect: 'tall', transparent: true }, { fetch });
  assert.deepEqual([picture.mediaType, picture.text], ['image/png', 'Here it is.']);
  assert.equal(sent[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent');
  assert.equal(sent[0].headers['x-goog-api-key'], 'AIza-secret-9876');
  assert.equal(sent[0].headers.authorization, undefined);
  assert.deepEqual(sent[0].body, {
    contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: png(2).toString('base64') } }, { text: 'redraw' }] }],
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '2:3' } },
  });
  // Relays that answer in snake case are read too; an answer with words only says why.
  const snake = api(() => Response.json({ candidates: [{ content: { parts: [{ inline_data: { mime_type: 'image/png', data: png(7).toString('base64') } }] } }] }));
  assert.equal((await generateImage(geminiSource, { prompt: 'p', references: [], aspect: 'square', transparent: false }, { fetch: snake.fetch })).mediaType, 'image/png');
  const words = api(() => Response.json({ candidates: [{ content: { parts: [{ text: 'I cannot draw that.' }] }, finishReason: 'IMAGE_SAFETY' }] }));
  await assert.rejects(generateImage(geminiSource, { prompt: 'p', references: [], aspect: 'square', transparent: false }, { fetch: words.fetch }), /^Error: Gemini answered without a picture \(IMAGE_SAFETY\): I cannot draw that\.$/);
});

test('saved paths are plain, visible and of a format an image API answers', () => {
  assert.deepEqual(['art/a.png', ' art / b.webp ', 'c.JPG', 'art\\d.jpeg'].map(cleanImagePath), ['art/a.png', 'art/b.webp', 'c.JPG', 'art/d.jpeg']);
  for (const bad of ['', 'a.gif', 'a.svg', 'art/a', '../a.png', '.hidden/a.png', 'art/.a.png', 'node_modules/a.png', 'a:b.png', 5]) assert.equal(cleanImagePath(bad), undefined, String(bad));
});

/** A game with one image the code names, one GIF, and an image API that draws a fresh picture each time. */
async function game() {
  const root = await temp('dsh-game-gen-'), state = await temp('dsh-game-gen-state-');
  const put = async (path: string, content: string | Buffer) => { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), content); };
  await put('package.json', '{"dependencies":{"phaser":"4"}}');
  await put('src/game.ts', "load.image('hero', 'art/hero.png');\n");
  await put('public/art/hero.png', png(1));
  await put('public/art/spin.gif', gif());
  let drawn = 0;
  const image = api(() => Response.json({ data: [{ b64_json: png(10 + drawn++, 80).toString('base64') }] }));
  const codex = await fakeCodex();
  made.push(...codex.dirs);
  const handler = createHandler(new AssetService(async id => id === 'game' ? root : undefined, join(state, 'workspaces.json'),
    { fetch: image.fetch, codex: { loginShell: false, command: codex.command }, projectScript: async () => '#!/usr/bin/env node\n// the generate-image script\n' }));
  const call = async <T>(body: Record<string, unknown>) => {
    const answer = await handler(new Request('http://dsh.test/api/game-assets', { method: 'POST', headers: { 'content-type': 'application/json', [CLIENT_HEADER]: '1' }, body: JSON.stringify({ sessionId: 'game', ...body }) }));
    return { status: answer.status, body: await answer.json() as T & { error?: string } };
  };
  return { root, state, put, call, sent: image.sent, codex };
}

test('generating sends listed images as references and writes nothing; the API key never reaches the client', async () => {
  const { root, call, sent } = await game();
  assert.equal((await call({ action: 'generate', prompt: 'a cat', aspect: 'square', transparent: true })).body.error, 'Add an image source first');
  const added = (await call<SourcesAnswer & { id: string }>({ action: 'saveSource', source: { name: 'Relay', kind: 'openai', baseUrl: 'https://relay.example/v1', model: 'gpt-image-2', apiKey: 'sk-never-shown-42' } })).body;
  assert.doesNotMatch(JSON.stringify(added), /never-shown/);
  assert.equal((await call<SourcesAnswer>({ action: 'sources' })).body.sources[0].keyHint, '…n-42');
  await call<ScanResult>({ action: 'scan' });

  const generated = await call<GeneratedImage>({ action: 'generate', sourceId: added.id, prompt: ' Redraw it ', references: ['public/art/hero.png'], aspect: 'square', transparent: true });
  assert.equal(generated.status, 200);
  assert.deepEqual([generated.body.mediaType, generated.body.width, generated.body.source, generated.body.model], ['image/png', 16, 'Relay', 'gpt-image-2']);
  assert.deepEqual(Buffer.from(generated.body.data, 'base64'), png(10, 80));
  assert.deepEqual(sent[0].form?.image, [{ name: 'hero.png', type: 'image/png', bytes: png(1) }]);
  assert.deepEqual(sent[0].form?.prompt, ['Redraw it']);
  assert.equal((await readFile(join(root, 'public/art/hero.png'))).equals(png(1)), true, 'nothing was written');

  for (const [body, error] of [
    [{ references: ['public/art/spin.gif'] }, 'Only PNG, WebP and JPEG images can be sent to an image API'],
    [{ references: ['../secret.png'] }, 'Not an image of this workspace'],
    [{ references: ['a.png', 'b.png', 'c.png', 'd.png', 'e.png'] }, 'Up to 4 images can be sent as references'],
    [{ prompt: '   ' }, 'Describe the picture in up to 8000 characters'],
    [{ aspect: 'round' }, 'Invalid picture settings'],
    [{ sourceId: 'gone' }, 'That image source was removed'],
  ] as const) assert.equal((await call({ action: 'generate', prompt: 'p', aspect: 'square', transparent: false, ...body })).body.error, error, JSON.stringify(body));
  assert.equal(sent.length, 1);
});

test('a picture is saved at a free path, never over a file; replacing retires the image there first, each time under a free name', async () => {
  const { root, call } = await game();
  await call<ScanResult>({ action: 'scan' });
  const next = png(20, 90).toString('base64');

  const saved = await call<SaveResult>({ action: 'save', path: 'public/art/new/hero-redraw.png', data: next });
  assert.deepEqual([saved.status, saved.body.path, saved.body.retired], [200, 'public/art/new/hero-redraw.png', undefined]);
  assert.deepEqual(await readFile(join(root, 'public/art/new/hero-redraw.png')), png(20, 90));
  assert.ok(saved.body.scan.assets.some(asset => asset.path === 'public/art/new/hero-redraw.png'), 'the answer carries the new scan');

  for (const [body, error] of [
    [{ path: 'public/art/new/hero-redraw.png' }, 'A file of that name is already there'],
    [{ path: 'public/art/hero.png' }, 'A file of that name is already there'],
    [{ path: 'public/art/x.webp' }, 'The picture is not a WEBP file'],
    [{ path: 'public/art/x.gif' }, 'Save pictures as .png, .webp or .jpg files in a visible folder of the workspace'],
    [{ path: '_retired/x.png' }, 'Pictures cannot be saved in the retired folder'],
    [{ path: 'public/art/none.png', replace: true }, 'Only an image of the last scan can be replaced'],
    [{ path: 'public/art/x.png', data: Buffer.from('not a picture').toString('base64') }, 'The picture is not a PNG file'],
  ] as const) assert.equal((await call({ action: 'save', data: next, ...body })).body.error, error, JSON.stringify(body));

  await call({ action: 'tag', paths: ['public/art/hero.png'], add: ['cast'] });
  const replaced = await call<SaveResult>({ action: 'save', path: 'public/art/hero.png', data: next, replace: true });
  assert.deepEqual([replaced.body.path, replaced.body.retired], ['public/art/hero.png', '_retired/public/art/hero.png']);
  assert.deepEqual(await readFile(join(root, 'public/art/hero.png')), png(20, 90));
  assert.deepEqual(await readFile(join(root, '_retired/public/art/hero.png')), png(1));
  const hero = replaced.body.scan.assets.find(asset => asset.path === 'public/art/hero.png');
  assert.deepEqual([hero?.usage, hero?.tags], ['used', ['cast']], 'the new picture keeps the role, the references and the tags');
  assert.equal(replaced.body.scan.assets.find(asset => asset.path === '_retired/public/art/hero.png')?.origin, 'public/art/hero.png');

  const again = await call<SaveResult>({ action: 'save', path: 'public/art/hero.png', data: png(21, 90).toString('base64'), replace: true });
  assert.equal(again.body.retired, '_retired/public/art/hero.2.png');
  assert.deepEqual(await readFile(join(root, '_retired/public/art/hero.2.png')), png(20, 90));
  const list = JSON.parse(await readFile(join(root, '_retired/retired.json'), 'utf8')) as { entries: { from: string; to: string }[] };
  assert.deepEqual(list.entries.map(({ from, to }) => [from, to]), [['public/art/hero.png', '_retired/public/art/hero.2.png'], ['public/art/hero.png', '_retired/public/art/hero.png']]);
  // No temporary file is left behind.
  assert.deepEqual([...await readdir(join(root, 'public/art')), ...await readdir(join(root, 'public/art/new'))].filter(name => name.startsWith('.')), []);
});

test('a Codex source draws on the workspace machine with references read there; it needs no address or key', async () => {
  const { root, call, codex } = await game();
  await call<ScanResult>({ action: 'scan' });
  const added = (await call<SourcesAnswer & { id: string }>({ action: 'saveSource', source: { name: 'Codex', kind: 'codex', model: '', baseUrl: 'ignored', apiKey: 'ignored' } })).body;
  assert.deepEqual(added.sources, [{ id: added.id, name: 'Codex', kind: 'codex', baseUrl: '', model: '', keyHint: '' }]);

  const generated = await call<GeneratedImage>({ action: 'generate', sourceId: added.id, prompt: 'winter hero', references: ['public/art/hero.png'], aspect: 'square', transparent: true });
  assert.equal(generated.status, 200, generated.body.error);
  assert.deepEqual([generated.body.mediaType, generated.body.width, generated.body.source, generated.body.model], ['image/png', 1024, 'Codex', 'Codex']);
  assert.deepEqual(Buffer.from(generated.body.data, 'base64'), CODEX_PICTURE);
  const call1 = (await codex.calls()).at(-1)!;
  assert.deepEqual(call1.args.slice(-2), ['--image', join(await realpath(root), 'public/art/hero.png')]);
  assert.match(call1.prompt, /on a transparent background[\s\S]*winter hero$/);

  process.env.FAKE_CODEX_MODE = 'auth';
  try {
    const failed = await call({ action: 'generate', sourceId: added.id, prompt: 'p', aspect: 'square', transparent: false });
    assert.deepEqual([failed.status, failed.body.error], [502, 'Codex made no picture (exit 1): Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.']);
  } finally { process.env.FAKE_CODEX_MODE = 'ok'; }
  assert.equal((await call({ action: 'generate', sourceId: added.id, prompt: 'p', references: ['public/art/spin.gif'], aspect: 'square', transparent: false })).body.error, 'Only PNG, WebP and JPEG images can be sent to an image API');
});

test('the source is recorded in the project for its agents, its key on the machine only, and can be removed again', async () => {
  const home = await temp('dsh-game-gen-home-'), before = process.env.HOME;
  process.env.HOME = home;
  try {
    const { root, call } = await game();
    assert.deepEqual((await call({ action: 'projectSource' })).body, { source: null, files: [] });
    const added = (await call<SourcesAnswer & { id: string }>({ action: 'saveSource', source: { name: 'Relay', kind: 'openai', baseUrl: 'https://relay.example/v1', model: 'gpt-image-2', apiKey: 'sk-recorded-5555' } })).body;
    const recorded = await call<ProjectSourceStatus>({ action: 'setProjectSource', sourceId: added.id });
    assert.equal(recorded.status, 200, recorded.body.error);
    assert.deepEqual(recorded.body, { source: { id: added.id, name: 'Relay', kind: 'openai', model: 'gpt-image-2', baseUrl: 'https://relay.example/v1', retireDir: '_retired' },
      files: ['.game-assets/image-source.json', '.game-assets/generate-image.cjs', '.game-assets/README.md', 'AGENTS.md', 'CLAUDE.md'] });
    assert.equal(await readFile(join(root, '.game-assets/generate-image.cjs'), 'utf8'), '#!/usr/bin/env node\n// the generate-image script\n');
    for (const file of ['.game-assets/image-source.json', '.game-assets/README.md', 'AGENTS.md', 'CLAUDE.md']) assert.doesNotMatch(await readFile(join(root, file), 'utf8'), /sk-recorded/, file);
    assert.match(await readFile(join(home, '.dsh-game-assets/keys.json'), 'utf8'), /sk-recorded-5555/);
    assert.deepEqual((await call({ action: 'projectSource' })).body, recorded.body);
    // The script and the agent files are not images: the scan does not list them.
    assert.equal((await call<ScanResult>({ action: 'scan', refresh: true })).body.assets.some(asset => asset.path.startsWith('.game-assets')), false);

    assert.equal((await call({ action: 'setProjectSource', sourceId: 'gone' })).body.error, 'That image source was removed');
    assert.equal((await call({ action: 'setProjectSource', sourceId: 5 })).body.error, 'Invalid image source');
    assert.deepEqual((await call({ action: 'setProjectSource', sourceId: null })).body, { source: null, files: [] });
    assert.deepEqual((await readdir(root)).sort(), ['package.json', 'public', 'src'], 'nothing of the recording is left');
  } finally { process.env.HOME = before; }
});


test('each version keeps how it was made; going back swaps the versions, so the one replaced can be gone back to as well', async () => {
  const { root, call } = await game();
  await call<ScanResult>({ action: 'scan' });
  await call({ action: 'tag', paths: ['public/art/hero.png'], add: ['cast'] });
  const first = png(30, 90), second = png(31, 90);
  const made = (prompt: string) => ({ source: 'Codex', model: 'Codex', prompt, at: '1999-01-01T00:00:00.000Z', extra: 'dropped' });

  const one = (await call<SaveResult>({ action: 'save', path: 'public/art/hero.png', data: first.toString('base64'), replace: true, made: made('winter hero') })).body;
  const live = (scan: ScanResult, path = 'public/art/hero.png') => scan.assets.find(asset => asset.path === path)!;
  assert.deepEqual(Object.keys(live(one.scan).made!), ['at', 'source', 'model', 'prompt']);
  assert.equal(live(one.scan).made!.prompt, 'winter hero');
  assert.notEqual(live(one.scan).made!.at, '1999-01-01T00:00:00.000Z', 'the time is the machine’s own');
  const two = (await call<SaveResult>({ action: 'save', path: 'public/art/hero.png', data: second.toString('base64'), replace: true, made: made('spring hero') })).body;
  assert.equal(live(two.scan).made!.prompt, 'spring hero');
  // The versions it replaced: the original without a record, then the winter one with its own.
  const versions = two.scan.assets.filter(asset => asset.retired && asset.origin === 'public/art/hero.png').sort((a, b) => (b.retiredAt ?? '').localeCompare(a.retiredAt ?? ''));
  assert.deepEqual(versions.map(asset => [asset.path, asset.made?.prompt]), [['_retired/public/art/hero.2.png', 'winter hero'], ['_retired/public/art/hero.png', undefined]]);
  assert.ok(versions.every(asset => /^\d{4}-\d\d-\d\dT/.test(asset.retiredAt!)));

  // Back to the original: the spring picture is retired in its turn, under a free name, with its record.
  const back = await call<RevertResult>({ action: 'revert', path: '_retired/public/art/hero.png' });
  assert.deepEqual([back.status, back.body.path, back.body.retired], [200, 'public/art/hero.png', '_retired/public/art/hero.3.png']);
  assert.deepEqual(await readFile(join(root, 'public/art/hero.png')), png(1));
  assert.deepEqual(await readFile(join(root, '_retired/public/art/hero.3.png')), second);
  assert.equal(live(back.body.scan).made, undefined);
  assert.deepEqual(live(back.body.scan).tags, ['cast'], 'the tags stay with the place');
  assert.equal(live(back.body.scan, '_retired/public/art/hero.3.png').made!.prompt, 'spring hero');
  const list = JSON.parse(await readFile(join(root, '_retired/retired.json'), 'utf8')) as { entries: { from: string; to: string }[] };
  assert.deepEqual(list.entries.map(entry => entry.to), ['_retired/public/art/hero.2.png', '_retired/public/art/hero.3.png']);

  // And forward again to the winter one; the original goes back to the retired folder's first free name.
  const forward = (await call<RevertResult>({ action: 'revert', path: '_retired/public/art/hero.2.png' })).body;
  assert.deepEqual(await readFile(join(root, 'public/art/hero.png')), first);
  assert.equal(live(forward.scan).made!.prompt, 'winter hero');
  assert.equal(forward.retired, '_retired/public/art/hero.png');
  assert.deepEqual(await readFile(join(root, '_retired/public/art/hero.png')), png(1));
  assert.equal(forward.scan.assets.filter(asset => asset.origin === 'public/art/hero.png').length, 2, 'every version is still there');

  // An image retired the ordinary way comes back without anything being retired.
  await call({ action: 'retire', paths: ['public/art/spin.gif'] });
  const restored = (await call<RevertResult>({ action: 'revert', path: '_retired/public/art/spin.gif' })).body;
  assert.deepEqual([restored.path, restored.retired], ['public/art/spin.gif', undefined]);
  assert.equal((await call({ action: 'revert', path: 'public/art/hero.png' })).body.error, 'Only a retired image whose place was recorded can be brought back');
});
