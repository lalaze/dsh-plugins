import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { FileError, LocalFiles } from '../src/files.js';
import { CLIENT_HEADER, createHandler } from '../src/http.js';

const sha = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
async function workspace(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-file-editor-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project'), outside = join(root, 'outside');
  await mkdir(join(project, 'src'), { recursive: true }); await mkdir(outside);
  const cwds: Record<string, string> = { session: project, remote: join(root, 'dsh', 'remote-workspaces', 'box', 'app') };
  return { root, project, outside, files: new LocalFiles(async id => cwds[id]) };
}
const rejects = (promise: Promise<unknown>, status: number, message?: RegExp) =>
  assert.rejects(promise, (error: unknown) => error instanceof FileError && error.status === status && (!message || message.test(error.message)));

test('text files read with a revision; binary, invalid UTF-8 and missing files are told apart', async t => {
  const { project, files } = await workspace(t);
  await writeFile(join(project, 'src', 'a.ts'), 'const a = 1;\n');
  await writeFile(join(project, 'bom.txt'), '﻿hello');
  await writeFile(join(project, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1]));
  await writeFile(join(project, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
  assert.deepEqual(await files.read('session', 'src/a.ts').then(({ mtimeMs: _, ...rest }) => rest), { path: 'src/a.ts', size: 13, kind: 'text', content: 'const a = 1;\n', revision: sha('const a = 1;\n') });
  assert.equal((await files.read('session', join(project, 'src', 'a.ts'))).path, 'src/a.ts', 'absolute paths inside the workspace work');
  assert.equal((await files.read('session', 'bom.txt') as { content: string }).content, '﻿hello', 'a BOM is kept');
  assert.equal((await files.read('session', 'logo.png')).kind, 'binary');
  assert.equal((await files.read('session', 'latin1.txt')).kind, 'binary');
  await rejects(files.read('session', 'missing.txt'), 404);
  await rejects(files.read('session', 'src'), 400, /Not a file/);
});

test('paths and symbolic links cannot leave the workspace, and remote anchors are left to Remote Agents', async t => {
  const { project, outside, files } = await workspace(t);
  await writeFile(join(outside, 'secret.txt'), 'secret');
  await symlink(join(outside, 'secret.txt'), join(project, 'link.txt'));
  await symlink(outside, join(project, 'linked-dir'));
  await writeFile(join(project, 'inside.txt'), 'inside'); await symlink(join(project, 'inside.txt'), join(project, 'alias.txt'));
  await rejects(files.read('session', '../outside/secret.txt'), 403);
  await rejects(files.read('session', join(outside, 'secret.txt')), 403);
  await rejects(files.read('session', 'link.txt'), 403);
  await rejects(files.read('session', 'linked-dir/secret.txt'), 403);
  await rejects(files.raw('session', 'link.txt'), 403);
  assert.equal((await files.read('session', 'alias.txt') as { content: string }).content, 'inside', 'links inside the workspace work');
  await writeFile(join(project, '..name.txt'), 'dots'); assert.equal((await files.read('session', '..name.txt')).path, '..name.txt');
  await rejects(files.read('remote', 'a.txt'), 409, /Remote Agents/);
  await rejects(files.read('unknown', 'a.txt'), 409);
  await rejects(files.read('session', 'a\0b'), 400);
});

test('saving replaces the file atomically with its permissions, refuses stale revisions and lets one of two concurrent saves through', async t => {
  const { project, files } = await workspace(t);
  const path = join(project, 'run.sh');
  await writeFile(path, 'echo one\r\n'); await chmod(path, 0o750);
  const read = await files.read('session', 'run.sh') as { revision: string };
  const saved = await files.write('session', 'run.sh', 'echo two\r\n', read.revision);
  assert.equal(await readFile(path, 'utf8'), 'echo two\r\n');
  assert.equal(saved.revision, sha('echo two\r\n'));
  assert.equal((await stat(path)).mode & 0o777, 0o750);
  assert.deepEqual((await readdir(project)).filter(name => name.endsWith('.tmp')), [], 'no temporary file is left');
  await rejects(files.write('session', 'run.sh', 'stale', read.revision), 409, /changed on disk/);
  const results = await Promise.allSettled([files.write('session', 'run.sh', 'first', saved.revision), files.write('session', 'run.sh', 'second', saved.revision)]);
  assert.deepEqual(results.map(r => r.status).sort(), ['fulfilled', 'rejected']);
  await rejects(files.write('session', 'run.sh', 'x', 'not-a-revision'), 400);
  await rejects(files.write('session', 'run.sh', 'x'.repeat(4 * 1024 * 1024 + 1), sha('first')), 413);
});

test('the HTTP route needs the client header, serves raw bytes inert and reports errors', async t => {
  const { project, files } = await workspace(t);
  await writeFile(join(project, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const handler = createHandler(files);
  const post = (body: unknown, headers: Record<string, string> = { [CLIENT_HEADER]: '1', 'content-type': 'application/json' }) =>
    handler(new Request('http://dsh.test/api/file-editor', { method: 'POST', headers, body: JSON.stringify(body) }));
  assert.equal((await post({ action: 'read', sessionId: 'session', path: 'icon.svg' }, { 'content-type': 'application/json' })).status, 403);
  assert.equal((await post({ action: 'read', sessionId: 'session', path: 'icon.svg' }, { [CLIENT_HEADER]: '1', 'content-type': 'text/plain' })).status, 415);
  const read = await post({ action: 'read', sessionId: 'session', path: 'icon.svg' });
  assert.equal(read.status, 200); assert.equal((await read.json()).kind, 'text');
  const raw = await handler(new Request('http://dsh.test/api/file-editor?sessionId=session&path=icon.svg', { headers: { [CLIENT_HEADER]: '1' } }));
  assert.equal(raw.headers.get('content-type'), 'application/octet-stream');
  assert.equal(raw.headers.get('content-disposition'), 'attachment');
  assert.match(raw.headers.get('content-security-policy') ?? '', /sandbox/);
  assert.equal((await handler(new Request('http://dsh.test/api/file-editor?sessionId=session&path=icon.svg'))).status, 403, 'a plain link cannot load it');
  const missing = await post({ action: 'read', sessionId: 'session', path: 'missing.svg' });
  assert.deepEqual([missing.status, await missing.json()], [404, { error: 'File not found' }]);
  assert.equal((await post({ action: 'delete', sessionId: 'session', path: 'icon.svg' })).status, 400);
});


test('HTTP saves allow JSON escaping up to the decoded text limit', async t => {
  const { project, files } = await workspace(t);
  const path = join(project, 'escaped.txt');
  await writeFile(path, 'old');
  const handler = createHandler(files);
  const content = '\u0001'.repeat(4 * 1024 * 1024);
  const post = (value: string, revision: string) => handler(new Request('http://dsh.test/api/file-editor', {
    method: 'POST', headers: { [CLIENT_HEADER]: '1', 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'write', sessionId: 'session', path: 'escaped.txt', content: value, revision }),
  }));
  assert.equal((await post(content, sha('old'))).status, 200);
  assert.equal(await readFile(path, 'utf8'), content);
  assert.equal((await post(content + 'x', sha(content))).status, 413, 'the decoded limit still applies');
  assert.equal(await readFile(path, 'utf8'), content, 'an oversized save leaves the file unchanged');
});
