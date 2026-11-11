import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { clipboardImage, pastedFiles, pastesFor, pickFiles, terminalPath, TuiUploads } from '../src/client/tui-files.js';
import { RemoteError } from '@dsh-plugins/remote-core/domain.js';
import { FILE_LIMIT } from '@dsh-plugins/remote-core/workspace.js';
import { tuiFilesHandler } from '../src/install.js';
import { TuiFiles, tuiFileName, tuiFilePath } from '../src/tui-files.js';

const signal = new AbortController().signal;
const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const chunks = async function* (...parts: Uint8Array[]) { yield* parts; };
async function server(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-tui-files-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const saved: { sessionId: string; path: string; data: Buffer; size: number; sha256: string }[] = [], state = { unreachable: false, leftover: [] as string[] };
  const files = new TuiFiles({ directory, isTui: id => id === 'tui', attach: async (sessionId, path, input, size, sha256) => {
    state.leftover = await readdir(join(directory, 'tui-uploads'));
    if (state.unreachable) throw new Error('The machine is unreachable');
    const parts: Uint8Array[] = [];
    for await (const part of input) parts.push(part);
    saved.push({ sessionId, path, data: Buffer.concat(parts), size, sha256 });
    return `/srv/app/${path}`;
  } });
  return { directory, files, saved, state, scratch: () => readdir(join(directory, 'tui-uploads')) };
}
const request = (query: Record<string, string>, body?: BodyInit, headers: Record<string, string> = { 'X-DSH-Remote-Agents': '1' }) =>
  new Request(`http://dsh.test/api/remote-agents/tui-files?${new URLSearchParams(query)}`, { method: 'POST', headers, body });

test('a file keeps a recognizable name, with nothing a shell or a path detector must be careful about', () => {
  const cases: [unknown, string][] = [
    ['report.pdf', 'report.pdf'],
    ['Screenshot 2026-11-04 at 3.14.25 PM.png', 'Screenshot-2026-11-04-at-3.14.25-PM.png'],
    ['截图 中文.png', '截图-中文.png'],
    ['report final (1).pdf', 'report-final-1.pdf'],
    ["a'b\"c$(rm -rf ~);`x`.txt", 'a-b-c-rm-rf-x.txt'],
    ['../../etc/passwd', 'passwd'],
    ['..\\..\\secret.txt', 'secret.txt'],
    ['line\nbreak\r.txt', 'line-break.txt'],
    ['\u001b[201~evil.txt', '201-evil.txt'],
    ['-rf', 'rf'],
    ['.env', 'file.env'],
    ['..', 'file'],
    ['', 'file'],
    ['😀.png', 'file.png'],
    [undefined, 'file'],
    ['é.txt', 'é.txt'],
  ];
  for (const [input, expected] of cases) assert.equal(tuiFileName(input), expected, String(input));
  const long = tuiFileName(`${'报'.repeat(200)}.png`);
  assert.ok(long.endsWith('.png'), 'a long name keeps its extension');
  assert.ok(Buffer.byteLength(long) <= 160, 'and fits a file system');
});

test('a file reaches the conversation\'s machine whole, under a path set by its content, and leaves nothing behind here', async t => {
  const { files, saved, scratch, state } = await server(t), one = Buffer.from([0, 255, 1]), two = Buffer.from([10, 13, 128]);
  const data = Buffer.concat([one, two]), hash = sha(data);
  assert.equal(await files.upload('tui', 'a b.bin', chunks(one, two), signal), `/srv/app/.dsh-remote-agents/attachments/tui/${hash.slice(0, 16)}/a-b.bin`);
  assert.deepEqual(saved, [{ sessionId: 'tui', path: tuiFilePath(hash, 'a-b.bin'), data, size: data.length, sha256: hash }]);
  assert.equal(state.leftover.length, 1, 'it is staged while it is sent');
  assert.deepEqual(await scratch(), [], 'and removed afterwards');
  await files.upload('tui', 'a b.bin', chunks(data), signal);
  assert.equal(saved[1].path, saved[0].path, 'the same file given twice has one copy');
});

test('only a TUI conversation takes files, and a failed upload leaves nothing behind', async t => {
  const { files, saved, scratch, state } = await server(t);
  await assert.rejects(files.upload('chat', 'a.txt', chunks(Buffer.from('x')), signal), (error: RemoteError) => error.status === 409 && /TUI/.test(error.message));
  state.unreachable = true;
  await assert.rejects(files.upload('tui', 'a.txt', chunks(Buffer.from('x')), signal), /unreachable/);
  assert.deepEqual(await scratch(), []);
  state.unreachable = false;
  const broken = async function* () { yield Buffer.from('x'); throw new Error('The browser went away'); };
  await assert.rejects(files.upload('tui', 'a.txt', broken(), signal), /went away/);
  assert.deepEqual(await scratch(), []);
  assert.deepEqual(saved, [], 'a transfer the browser gave up on never reaches the machine');
});

test('the upload route takes only what the client declared, from the client', async t => {
  const { files, saved } = await server(t), handler = tuiFilesHandler(files), query = { sessionId: 'tui', name: 'a.txt' };
  const size = { 'X-DSH-Remote-Agents': '1', 'X-File-Size': '2' };
  assert.equal((await handler(request(query, 'ab', { 'X-File-Size': '2' }))).status, 403, 'another page cannot post here');
  assert.equal((await handler(request(query, 'ab'))).status, 413, 'the size is required');
  assert.equal((await handler(request(query, 'ab', { ...size, 'X-File-Size': String(FILE_LIMIT + 1) }))).status, 413);
  assert.equal((await handler(request(query, 'abc', size))).status, 413, 'more than declared');
  assert.equal((await handler(request(query, 'a', size))).status, 400, 'less than declared');
  assert.equal((await handler(request(query, undefined, size))).status, 400, 'nothing at all');
  assert.equal((await handler(request({ sessionId: 'chat', name: 'a.txt' }, 'ab', size))).status, 409);
  assert.deepEqual(saved, []);
  const accepted = await handler(request(query, 'ab', size));
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { path: `/srv/app/${tuiFilePath(sha(Buffer.from('ab')), 'a.txt')}` });
  const empty = await handler(request({ sessionId: 'tui', name: 'empty.txt' }, undefined, { ...size, 'X-File-Size': '0' }));
  assert.equal(empty.status, 200, 'an empty file is a file');
});

const file = (name: string, type = '', size = 3) => new File([new Uint8Array(size)], name, { type });
const transfer = (files: File[], text = '', types: string[] = [], folders: string[] = []) => ({
  files, types: [...types, ...(text ? ['text/plain'] : []), 'Files'], getData: (format: string) => (format === 'text/plain' ? text : ''),
  items: files.map(item => ({ kind: 'file', webkitGetAsEntry: () => ({ isDirectory: folders.includes(item.name) }) })),
});

test('a folder is told apart from the files dropped with it', () => {
  const picked = pickFiles(transfer([file('a.txt'), file('photos'), file('b.txt')], '', [], ['photos']));
  assert.deepEqual(picked.files.map(item => item.name), ['a.txt', 'b.txt']);
  assert.deepEqual(picked.folders, ['photos']);
  const mixed = pickFiles({ files: [file('a.txt')], items: [{ kind: 'string' }, { kind: 'file', webkitGetAsEntry: () => null }] });
  assert.deepEqual(mixed.files.map(item => item.name), ['a.txt'], 'text in the same transfer does not shift which file is which');
});

test('a paste uploads what the user copied as a file or an image, and leaves copied text to the terminal', () => {
  const image = file('image.png', 'image/png');
  const names = (value: ReturnType<typeof pastedFiles>) => value?.files.map(item => item.name);
  assert.deepEqual(names(pastedFiles(transfer([image]))), ['image.png'], 'a screenshot');
  assert.deepEqual(names(pastedFiles(transfer([file('report.pdf')], 'report.pdf'))), ['report.pdf'], 'a file copied in Finder, whose text is only its name');
  assert.deepEqual(names(pastedFiles(transfer([image], '', ['text/html']))), ['image.png'], 'an image copied from a web page');
  assert.equal(pastedFiles(transfer([image], 'a\tb', ['text/html'])), undefined, 'cells copied from a spreadsheet, with a picture of themselves');
  assert.equal(pastedFiles(transfer([image], 'a paragraph', ['text/rtf'])), undefined);
  assert.equal(pastedFiles(transfer([], 'plain text')), undefined);
  assert.deepEqual(pastedFiles(transfer([file('photos')], '', [], ['photos']))?.folders, ['photos'], 'a copied folder is refused rather than typed');
});

test('Ctrl+V takes only an image without text, and an unavailable clipboard counts as empty', async () => {
  const item = (types: Record<string, string>) => ({ types: Object.keys(types), getType: async (type: string) => new Blob([types[type]], { type }) }) as unknown as ClipboardItem;
  const clipboard = (...items: ClipboardItem[]) => ({ read: async () => items });
  const image = await clipboardImage(clipboard(item({ 'image/png': 'png' })));
  assert.equal(image?.name, 'image.png');
  assert.equal(image?.type, 'image/png');
  assert.equal(await image?.text(), 'png');
  assert.equal((await clipboardImage(clipboard(item({ 'image/svg+xml': 'svg' }))))?.name, 'image.svg');
  assert.equal(await clipboardImage(clipboard(item({ 'text/plain': 'report.pdf', 'image/png': 'icon' }))), undefined, 'a copied file offers its icon');
  assert.equal(await clipboardImage(clipboard(item({ 'text/plain': 'text' }))), undefined);
  assert.equal(await clipboardImage(clipboard()), undefined);
  assert.equal(await clipboardImage({ read: async () => { throw new Error('NotAllowedError'); } }), undefined, 'permission refused');
  assert.equal(await clipboardImage(undefined), undefined, 'a page that is not secure has no such API');
});

test('a path is typed as a terminal types a dropped file', () => {
  assert.equal(terminalPath('/srv/app/.dsh-remote-agents/attachments/tui/ab12/截图-中文.png'), '/srv/app/.dsh-remote-agents/attachments/tui/ab12/截图-中文.png');
  assert.equal(terminalPath("/srv/my app/it's (1)/a.txt"), "/srv/my\\ app/it\\'s\\ \\(1\\)/a.txt");
  assert.equal(terminalPath('/srv/$(x);`y`&|*?<>"#!/a'), String.raw`/srv/\$\(x\)\;\`y\`\&\|\*\?\<\>\"\#\!/a`);
});

test('for Claude Code each file is its own paste, images last, and text stays apart from an earlier image', () => {
  const pastes = (paths: string[], afterImage: boolean) => pastesFor(paths, afterImage, 'claude');
  assert.deepEqual(pastes(['/r/a.txt'], false), ['/r/a.txt '], 'an empty prompt gets no stray space');
  assert.deepEqual(pastes(['/r/a.png'], false), ['/r/a.png ']);
  assert.deepEqual(pastes(['/r/a.png', '/r/b.txt', '/r/c.txt', '/r/d.JPG', '/r/e.webp'], false), ['/r/b.txt ', '/r/c.txt ', '/r/a.png ', '/r/d.JPG ', '/r/e.webp '], 'a placeholder comes late, so text goes first');
  assert.deepEqual(pastes(['/r/b.txt', '/r/c.txt'], true), [' /r/b.txt ', '/r/c.txt '], 'an image dropped earlier counts, once');
  assert.deepEqual(pastes(['/r/b.png'], true), ['/r/b.png '], 'Claude Code spaces its own placeholders');
  assert.deepEqual(pastes(['/my app/a.txt'], false), [String.raw`/my\ app/a.txt `]);
  assert.deepEqual(pastes([], true), []);
});

test('for Codex each file is its own paste, in order, as its placeholder comes at once with a space after it', () => {
  assert.deepEqual(pastesFor(['/r/a.png', '/r/b.txt', '/r/c.png'], false, 'codex'), ['/r/a.png ', '/r/b.txt ', '/r/c.png ']);
  assert.deepEqual(pastesFor(['/r/b.txt'], true, 'codex'), ['/r/b.txt '], 'no extra space after an earlier image');
  assert.deepEqual(pastesFor(['/my app/a.txt'], false, 'codex'), [String.raw`/my\ app/a.txt `]);
});

/** Uploads held open until the test finishes them. */
function manual() {
  const sends: { sessionId: string; file: File; signal: AbortSignal; finish(path: string): void; fail(error: Error): void }[] = [];
  const uploads = new TuiUploads((sessionId, item, signal) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    sends.push({ sessionId, file: item, signal, finish: resolve, fail: reject });
  }));
  return { uploads, sends };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('files upload one at a time in order, and their paths wait for the terminal to take them once', async () => {
  const { uploads, sends } = manual();
  let changes = 0;
  uploads.subscribe(() => { changes += 1; });
  uploads.add('s', { files: [file('a.png'), file('b.txt')], folders: [] });
  assert.equal(sends.length, 1, 'one at a time');
  assert.deepEqual([uploads.status('s').current, uploads.status('s').waiting], ['a.png', 1]);
  uploads.add('s', { files: [file('c.txt')], folders: [] });
  assert.equal(uploads.status('s').waiting, 2, 'files added meanwhile join the queue');
  sends[0].finish('/r/a.png'); await settle();
  assert.deepEqual(uploads.status('s').paths, ['/r/a.png']);
  assert.deepEqual([uploads.status('s').current, uploads.status('s').waiting], ['b.txt', 1]);
  sends[1].finish('/r/b.txt'); await settle();
  sends[2].finish('/r/c.txt'); await settle();
  assert.deepEqual(uploads.status('s').paths, ['/r/a.png', '/r/b.txt', '/r/c.txt']);
  assert.equal(uploads.status('s').current, undefined);
  assert.deepEqual(uploads.take('s'), ['/r/a.png', '/r/b.txt', '/r/c.txt']);
  assert.deepEqual(uploads.take('s'), [], 'each is handed over once');
  assert.ok(changes > 0);
  const before = uploads.status('s');
  assert.equal(uploads.status('s'), before, 'an unchanged status is the same object, as React compares them');
  assert.equal(uploads.status('other'), uploads.status('another'));
});

test('a failed file is reported and the rest still upload', async () => {
  const { uploads, sends } = manual();
  uploads.add('s', { files: [file('a.txt'), file('b.txt')], folders: [] });
  sends[0].fail(new Error('File exceeds the 50 MB transfer limit')); await settle();
  sends[1].finish('/r/b.txt'); await settle();
  assert.deepEqual(uploads.status('s').paths, ['/r/b.txt']);
  assert.equal(uploads.status('s').errors.length, 1);
  assert.match(uploads.status('s').errors[0], /^a\.txt: /);
  uploads.close('s');
  assert.deepEqual(uploads.status('s').errors, [], 'dismissed');
  assert.deepEqual(uploads.status('s').paths, ['/r/b.txt'], 'what did upload still reaches the terminal');
});

test('a folder or an oversized file is refused without sending anything, and clears the last errors', async () => {
  const { uploads, sends } = manual();
  uploads.add('s', { files: [file('huge.bin', '', 0), Object.defineProperty(file('big.bin'), 'size', { value: FILE_LIMIT + 1 })], folders: ['photos'] });
  assert.deepEqual(sends.map(send => send.file.name), ['huge.bin'], 'only what fits');
  assert.equal(uploads.status('s').errors.length, 2);
  assert.match(uploads.status('s').errors.join('\n'), /photos/);
  assert.match(uploads.status('s').errors.join('\n'), /big\.bin/);
  sends[0].finish('/r/huge.bin'); await settle();
  uploads.add('s', { files: [], folders: ['more'] });
  assert.equal(uploads.status('s').errors.length, 1, 'errors from the last drop are gone');
  assert.equal(uploads.status('s').current, undefined, 'and nothing started');
});

test('cancelling stops the file being sent and those waiting, and a new upload starts clean', async () => {
  const { uploads, sends } = manual();
  uploads.add('s', { files: [file('a.txt'), file('b.txt')], folders: [] });
  uploads.close('s');
  assert.equal(sends[0].signal.aborted, true);
  assert.equal(uploads.status('s').current, undefined);
  uploads.add('s', { files: [file('c.txt')], folders: [] });
  await settle();
  assert.deepEqual(sends.map(send => send.file.name), ['a.txt', 'c.txt'], 'the cancelled queue sends nothing more');
  assert.equal(uploads.status('s').current, 'c.txt', 'and does not touch the new one');
  assert.deepEqual(uploads.status('s').errors, [], 'a cancelled file is not a failure');
  sends[1].finish('/r/c.txt'); await settle();
  assert.deepEqual(uploads.take('s'), ['/r/c.txt']);
});

test('each conversation has its own uploads', async () => {
  const { uploads, sends } = manual();
  uploads.add('one', { files: [file('a.txt')], folders: [] });
  uploads.add('two', { files: [file('b.txt')], folders: [] });
  assert.equal(sends.length, 2, 'they do not wait for each other');
  sends[1].finish('/r/b.txt'); await settle();
  assert.deepEqual(uploads.take('one'), []);
  assert.deepEqual(uploads.take('two'), ['/r/b.txt']);
  uploads.close('two');
  assert.equal(sends[0].signal.aborted, false);
});
