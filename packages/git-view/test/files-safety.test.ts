import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { LocalFiles } from '../src/files.js';
import { TEXT_LIMIT } from '../src/domain.js';
import { GitError } from '../src/runner.js';

const hash = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const conflict = (error: unknown) => error instanceof GitError && error.status === 409;
async function fixture(t: TestContext) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'git-files-safety-')));
  t.after(async () => { assert.match(base, /[/\\]git-files-safety-[^/\\]+$/); await rm(base, { recursive: true, force: true }); });
  const root = join(base, 'repo'), directory = join(root, 'src'), outside = join(base, 'outside');
  await mkdir(directory, { recursive: true }); await mkdir(outside);
  const file = join(directory, 'a.ts'), external = join(outside, 'a.ts');
  await writeFile(file, 'original\n'); await writeFile(external, 'outside secret\n');
  return { base, root, directory, outside, file, external };
}
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};

test('local snapshots and atomic saves preserve UTF-8 BOM, CRLF, permissions and internal symlinks', async t => {
  const { root, file } = await fixture(t), files = new LocalFiles(root), original = '\ufefforiginal\r\n';
  await writeFile(file, original); await chmod(file, 0o751);
  await symlink('src', join(root, 'alias-dir')); await symlink('src/a.ts', join(root, 'alias-file'));
  assert.deepEqual(await files.read('alias-dir/a.ts'), { kind: 'text', content: original, revision: hash(original), size: Buffer.byteLength(original) });
  const inode = (await stat(file)).ino;
  assert.deepEqual(await files.write('alias-file', '\ufeffsaved\r\n', hash(original)), { revision: hash('\ufeffsaved\r\n') });
  assert.equal(await readFile(file, 'utf8'), '\ufeffsaved\r\n');
  assert.equal((await stat(file)).mode & 0o777, 0o751);
  assert.notEqual((await stat(file)).ino, inode, 'save atomically replaces the file rather than truncating it');
  assert.equal((await lstat(join(root, 'alias-file'))).isSymbolicLink(), true);
});

test('static external symlinks, traversal and non-files fail closed; absent files stay missing', async t => {
  const { root, outside, external } = await fixture(t), files = new LocalFiles(root);
  await symlink(outside, join(root, 'escape'));
  for (const operation of [() => files.read('escape/a.ts'), () => files.write('escape/a.ts', 'bad', hash('outside secret\n'))]) {
    await assert.rejects(operation(), (error: GitError) => error.status === 403);
  }
  await assert.rejects(files.read('../outside/a.ts'), /Invalid file path/);
  await assert.rejects(files.read('src'), /Not a file/);
  assert.deepEqual(await files.read('missing.ts'), { kind: 'missing' });
  assert.equal(await readFile(external, 'utf8'), 'outside secret\n');
});

test('binary, non-UTF8, exact-limit and oversized reads remain bounded', async t => {
  const { root, file } = await fixture(t), files = new LocalFiles(root);
  for (const bytes of [Buffer.from([0, 1, 2]), Buffer.from([0xc0, 0xaf])]) {
    await writeFile(file, bytes); assert.deepEqual(await files.read('src/a.ts'), { kind: 'binary', size: bytes.length });
  }
  await writeFile(file, Buffer.alloc(TEXT_LIMIT, 97));
  const exact = await files.read('src/a.ts'); assert.equal(exact.kind, 'text');
  if (exact.kind === 'text') assert.equal(exact.size, TEXT_LIMIT);
  await writeFile(file, Buffer.alloc(TEXT_LIMIT + 1, 97));
  assert.deepEqual(await files.read('src/a.ts'), { kind: 'large', size: TEXT_LIMIT + 1 });
  await assert.rejects(files.write('src/a.ts', 'a'.repeat(TEXT_LIMIT + 1), hash('original\n')), (error: GitError) => error.status === 413);
});

test('two in-process saves consuming the same revision allow only one through, including aliases', async t => {
  const { root, file } = await fixture(t);
  await symlink('src/a.ts', join(root, 'alias'));
  const results = await Promise.allSettled([new LocalFiles(root).write('src/a.ts', 'one', hash('original\n')), new LocalFiles(root).write('alias', 'two', hash('original\n'))]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected' && conflict(r.reason)).length, 1);
  assert.ok(['one', 'two'].includes(await readFile(file, 'utf8')));
});

test('a replaced parent directory cannot redirect a read into an external symlink', async t => {
  const { root, directory, outside, external } = await fixture(t);
  const files = new LocalFiles(root, { checkpoint: async stage => {
    if (stage !== 'directory-bound') return;
    await rename(directory, join(root, 'old-src')); await symlink(outside, directory);
  } });
  await assert.rejects(files.read('src/a.ts'), conflict);
  assert.equal(await readFile(external, 'utf8'), 'outside secret\n');
});

test('parent replacement during a save cannot create, replace or clean up anything outside the bound directory', async t => {
  const { root, directory, outside, external } = await fixture(t), old = join(root, 'old-src');
  const files = new LocalFiles(root, { checkpoint: async stage => {
    if (stage !== 'temporary-written') return;
    await rename(directory, old); await symlink(outside, directory);
  } });
  await assert.rejects(files.write('src/a.ts', 'bad', hash('original\n')), conflict);
  assert.equal(await readFile(external, 'utf8'), 'outside secret\n');
  assert.equal(await readFile(join(old, 'a.ts'), 'utf8'), 'original\n');
  assert.deepEqual(await readdir(outside), ['a.ts']);
  assert.deepEqual(await readdir(old), ['a.ts'], 'temporary cleanup uses the pinned directory, not the replacement symlink');
});

test('replacing the workspace root with an external symlink rejects the operation', async t => {
  const { root, base, outside, external } = await fixture(t), old = join(base, 'old-root');
  const files = new LocalFiles(root, { checkpoint: async stage => {
    if (stage !== 'directory-bound') return;
    await rename(root, old); await symlink(outside, root);
  } });
  await assert.rejects(files.write('src/a.ts', 'bad', hash('original\n')), conflict);
  assert.equal(await readFile(external, 'utf8'), 'outside secret\n');
  assert.equal(await readFile(join(old, 'src/a.ts'), 'utf8'), 'original\n');
});

test('an inode replaced with identical bytes is rejected for both reads and writes', async t => {
  const { root, file, directory } = await fixture(t);
  for (const action of ['read', 'write']) {
    const files = new LocalFiles(root, { checkpoint: async stage => {
      if (stage !== 'file-opened') return;
      await rename(file, join(directory, `old-${action}`)); await writeFile(file, 'original\n');
    } });
    await assert.rejects(action === 'read' ? files.read('src/a.ts') : files.write('src/a.ts', 'bad', hash('original\n')), conflict);
    assert.equal(await readFile(file, 'utf8'), 'original\n');
  }
});

test('file-to-directory replacement is rejected without altering the new directory', async t => {
  const { root, file, directory } = await fixture(t);
  const files = new LocalFiles(root, { checkpoint: async stage => {
    if (stage !== 'file-opened') return;
    await rename(file, join(directory, 'old')); await mkdir(file);
  } });
  await assert.rejects(files.write('src/a.ts', 'bad', hash('original\n')), conflict);
  assert.deepEqual(await readdir(file), []);
});

test('a read rejects content changed after the file was opened rather than returning a mixed snapshot', async t => {
  const { root, file } = await fixture(t);
  const files = new LocalFiles(root, { checkpoint: async stage => { if (stage === 'file-opened') await writeFile(file, 'external new data\n'); } });
  await assert.rejects(files.read('src/a.ts'), conflict);
});

test('a final revision and identity check preserves external edits made while writing the temporary file', async t => {
  const { root, file, directory } = await fixture(t);
  const files = new LocalFiles(root, { checkpoint: async stage => { if (stage === 'before-commit') await writeFile(file, 'external edit\n'); } });
  await assert.rejects(files.write('src/a.ts', 'must not overwrite', hash('original\n')), conflict);
  assert.equal(await readFile(file, 'utf8'), 'external edit\n');
  assert.deepEqual(await readdir(directory), ['a.ts']);
});

test('an aborted save waits for worker cleanup and does not commit its temporary file', async t => {
  const { root, file, directory } = await fixture(t), entered = deferred(), release = deferred(), controller = new AbortController();
  const files = new LocalFiles(root, { checkpoint: async stage => {
    if (stage === 'temporary-written') { entered.resolve(); await release.promise; }
  } });
  const reason = new Error('cancel test'), pending = files.write('src/a.ts', 'not saved', hash('original\n'), controller.signal);
  const rejection = assert.rejects(pending, error => error === reason);
  await entered.promise; controller.abort(reason); await rejection; release.resolve();
  assert.equal(await readFile(file, 'utf8'), 'original\n');
  assert.deepEqual(await readdir(directory), ['a.ts']);
  await assert.rejects(files.read('src/a.ts', controller.signal), error => error === reason);
});


test('a directory swapped between observation and chdir is rejected before its files are opened', async t => {
  const { root, directory, outside, external } = await fixture(t);
  const files = new LocalFiles(root, { checkpoint: async stage => {
    if (stage !== 'directory-observed') return;
    await rename(directory, join(root, 'old-src')); await symlink(outside, directory);
  } });
  await assert.rejects(files.read('src/a.ts'), conflict);
  assert.equal(await readFile(external, 'utf8'), 'outside secret\n');
  assert.deepEqual(await readdir(outside), ['a.ts']);
});


test('a temporary save file modified by another writer is rejected and cleaned up', async t => {
  const { root, file, directory } = await fixture(t);
  const files = new LocalFiles(root, { checkpoint: async stage => {
    if (stage !== 'before-commit') return;
    const temporary = (await readdir(directory)).find(name => name.startsWith('.a.ts.') && name.endsWith('.tmp'))!;
    assert.ok(temporary); await writeFile(join(directory, temporary), 'unexpected contents');
  } });
  await assert.rejects(files.write('src/a.ts', 'expected contents', hash('original\n')), conflict);
  assert.equal(await readFile(file, 'utf8'), 'original\n');
  assert.deepEqual(await readdir(directory), ['a.ts']);
});
