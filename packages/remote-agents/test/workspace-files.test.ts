import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm, readdir, realpath, chmod, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { OpenSshTransport } from '../src/ssh.js';
import { WorkspaceFiles } from '../src/workspace-files.js';
import { fileOperation, hash, WorkspaceService } from '../src/workspace-service.js';
import { RemoteAgentsService } from '../src/service.js';
import { expectedTarget, workspaceTransferHandler } from '../src/workspace-http.js';
import type { WorkspaceFile, WorkspaceManifest } from '../src/workspace-domain.js';
import { fixture } from './fakes.js';
import { REMOTE_DSH_RUNNER } from '../src/workspace-runner.js';
import { promisify } from 'node:util';

class LocalTransport extends OpenSshTransport {
  // The runner keeps its locks under the remote home; tests give it a temporary one.
  constructor(private readonly home: string) { super('ssh://test.invalid'); }
  protected override spawnRemote(command: string): ChildProcessWithoutNullStreams {
    return spawn('/bin/sh', ['-c', command], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, SHELL: '/bin/sh', HOME: this.home } });
  }
}
// A runner's lock entry for one file: the file's key, the runner's pid and a unique suffix.
const lockEntry = (key: string, pid: number) => `${key}.${pid}.test`;
async function directory(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-workspace-files-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const remote = join(root, 'remote'), local = join(root, 'local');
  await mkdir(remote); await mkdir(local);
  return { root, remote, local, files: new WorkspaceFiles(new LocalTransport(root)) };
}
test('remote files list, read, edit with revision checks, search, rename and delete', async t => {
  const { remote, files } = await directory(t);
  await writeFile(join(remote, "literal ' $HOME.txt"), 'hello 🌏\nsecond line\n');
  const listing = await files.operate(remote, { op: 'list', path: '.' }) as { entries: { name: string }[] };
  assert.deepEqual(listing.entries.map(e => e.name), ["literal ' $HOME.txt"]);
  const first = await files.operate(remote, { op: 'read', path: "literal ' $HOME.txt" }) as WorkspaceFile;
  assert.equal(first.content, 'hello 🌏\nsecond line\n');
  await files.operate(remote, { op: 'write', path: first.path, content: 'new contents', revision: first.revision });
  await assert.rejects(files.operate(remote, { op: 'write', path: first.path, content: 'stale', revision: first.revision }), /file changed/);
  await assert.rejects(files.operate(remote, { op: 'write', path: first.path, content: 'overwrite', revision: null }), /file changed/);
  const found = await files.operate(remote, { op: 'search', path: '.', query: 'contents' }) as { matches: { path: string; line: number }[] };
  assert.equal(found.matches[0].path, first.path); assert.equal(found.matches[0].line, 1);
  await files.operate(remote, { op: 'move', path: first.path, destination: 'renamed.txt', revision: hash('new contents') });
  await files.operate(remote, { op: 'remove', path: 'renamed.txt', revision: hash('new contents') });
  assert.deepEqual(await readdir(remote), []);
});
test('workspace paths reject traversal, symlink escapes, binary editing and excessive uploads', async t => {
  const { root, remote, files } = await directory(t);
  await writeFile(join(root, 'outside'), 'secret'); await symlink(root, join(remote, 'escape'));
  for (const path of ['../outside', join(root, 'outside'), 'escape/outside']) await assert.rejects(files.operate(remote, { op: 'read', path }), /outside the remote workspace/);
  await writeFile(join(remote, 'binary'), Buffer.from([0, 255, 1]));
  await assert.rejects(files.operate(remote, { op: 'read', path: 'binary' }), /binary file/);
  assert.deepEqual(await files.download(remote, 'binary', hash(Buffer.from([0, 255, 1]))), Buffer.from([0, 255, 1]));
  await assert.rejects(files.upload(remote, 'file', null, 50 * 1024 * 1024 + 1, (async function* () {})()), /50 MB/);
  await assert.rejects(files.upload(remote, 'file', null, 2, (async function* () { yield Buffer.from('long'); })()), /byte count/);
  assert.equal((await readdir(remote)).some(n => n.startsWith('.dsh-ra-upload-')), false);
});
test('binary transfers are atomic, preserve exact bytes and require the current revision', async t => {
  const { remote, files } = await directory(t), data = Buffer.alloc(300000, 227);
  await files.upload(remote, 'large.bin', null, data.length, (async function* () { yield data.subarray(0, 140000); yield data.subarray(140000); })());
  assert.deepEqual(await files.download(remote, 'large.bin', hash(data)), data);
  await assert.rejects(files.upload(remote, 'large.bin', hash('stale'), 0, (async function* () {})()), /file changed/);
  assert.deepEqual(await readFile(join(remote, 'large.bin')), data);
});
test('remote commands preserve stdout, stderr and exit codes', async t => {
  const { remote, files } = await directory(t);
  const result = await files.operate(remote, { op: 'command', path: '.', command: 'printf output; printf problem >&2; exit 7' });
  assert.deepEqual(result, { stdout: 'output', stderr: 'problem', exitCode: 7, timedOut: false, truncated: false });
});
test('workspace files and commands never start Node.js on the SSH host', async t => {
  const { root, remote, files } = await directory(t), bin = join(root, '.local/bin'), marker = join(root, 'node-started');
  // The login PATH prefers this node after its version check; any real start of it is recorded and fails.
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'node'), `#!/bin/sh\n[ "$1" = --version ] && { echo v99.0.0; exit 0; }\n: > '${marker}'\nexit 127\n`, { mode: 0o755 });
  await files.operate(remote, { op: 'mkdir', path: 'src' });
  const created = await files.operate(remote, { op: 'write', path: 'src/app.txt', content: 'hello', revision: null }) as { revision: string };
  assert.equal((await files.operate(remote, { op: 'read', path: 'src/app.txt' }) as WorkspaceFile).content, 'hello');
  assert.deepEqual(await files.operate(remote, { op: 'stat', path: 'src/app.txt' }), { path: 'src/app.txt', revision: created.revision, size: 5 });
  assert.deepEqual((await files.operate(remote, { op: 'list', path: 'src' }) as { entries: { path: string; kind: string; size: number }[] }).entries.map(e => [e.path, e.kind, e.size]), [['src/app.txt', 'file', 5]]);
  assert.deepEqual((await files.operate(remote, { op: 'search', path: '.', query: 'ell' }) as { matches: unknown[] }).matches, [{ path: 'src/app.txt', line: 1, text: 'hello' }]);
  assert.deepEqual({ ...(await files.operate(remote, { op: 'manifest', path: '.' }) as WorkspaceManifest).files }, { 'src/app.txt': { hash: created.revision, size: 5 } });
  assert.deepEqual(await files.download(remote, 'src/app.txt', created.revision), Buffer.from('hello'));
  await files.operate(remote, { op: 'move', path: 'src/app.txt', destination: 'app.txt', revision: created.revision });
  await files.operate(remote, { op: 'remove', path: 'app.txt', revision: created.revision });
  assert.equal((await files.operate(remote, { op: 'command', path: 'src', command: 'pwd -P' }) as { stdout: string }).stdout.trim(), await realpath(join(remote, 'src')));
  assert.equal(await stat(marker).then(() => true, () => false), false);
});
test('a remote command that times out stops everything it started, and flooding output is cut', async t => {
  const { remote, files } = await directory(t);
  const started = Date.now();
  const timed = await files.operate(remote, { op: 'command', path: '.', command: 'printf started; (sleep 3; : > survived) & sleep 30', timeoutMs: 1000 }) as { stdout: string; timedOut: boolean; exitCode: number | null };
  assert.deepEqual([timed.stdout, timed.timedOut, timed.exitCode], ['started', true, null]);
  assert.ok(Date.now() - started < 2800, 'the command stops at its timeout');
  await new Promise(resolve => setTimeout(resolve, 3500 - (Date.now() - started)));
  assert.deepEqual(await readdir(remote), []);
  const flood = await files.operate(remote, { op: 'command', path: '.', command: 'yes' }) as { stdout: string; truncated: boolean; exitCode: number | null };
  assert.deepEqual([flood.truncated, flood.exitCode], [true, null]);
  assert.ok(flood.stdout.length <= 256 * 1024 && flood.stdout.startsWith('y\ny\n'));
});
test('a name containing a newline is listed and readable, but scans skip it', async t => {
  const { remote, files } = await directory(t);
  await writeFile(join(remote, 'two\nlines'), 'needle'); await writeFile(join(remote, 'plain'), 'needle');
  assert.deepEqual((await files.operate(remote, { op: 'list', path: '.' }) as { entries: { name: string }[] }).entries.map(e => e.name), ['plain', 'two\nlines']);
  assert.equal((await files.operate(remote, { op: 'read', path: 'two\nlines' }) as WorkspaceFile).content, 'needle');
  const manifest = await files.operate(remote, { op: 'manifest', path: '.' }) as WorkspaceManifest;
  assert.deepEqual([Object.keys(manifest.files), manifest.skipped], [['plain'], ['two\nlines']]);
  const found = await files.operate(remote, { op: 'search', path: '.', query: 'needle' }) as { matches: { path: string }[]; skipped: string[] };
  assert.deepEqual([found.matches.map(m => m.path), found.skipped], [['plain'], ['two\nlines']]);
});
test('managed remote DSH startup is isolated, idempotent, scoped to its workspace and explicitly stopped', async t => {
  const { root, remote } = await directory(t), bin = join(root, 'bin'); await mkdir(bin);
  await writeFile(join(bin, 'dsh'), `#!${process.execPath}\nconst port=process.argv[process.argv.indexOf('--port')+1];console.log(process.argv.slice(2).join(' '));console.log('http://127.0.0.1:'+port+'/?token=fixture-only');setInterval(()=>{},1000);\n`, { mode: 0o700 });
  await writeFile(join(bin, 'ps'), `#!${process.execPath}\ntry{process.kill(Number(process.argv[process.argv.indexOf('-p')+1]),0);console.log('fixed-test-start-stamp');}catch{process.exit(1);}\n`, { mode: 0o700 });
  const source = `require('node:os').homedir=()=>${JSON.stringify(root)};\n${REMOTE_DSH_RUNNER}`;
  const run = async (op: string, cwd = remote, host = '100.96.195.115') => JSON.parse((await promisify(execFile)(process.execPath, ['-e', source, JSON.stringify({ op, cwd, path: '.', port: 3080, host })], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, timeout: 10000 })).stdout);
  let pid: number | undefined;
  t.after(() => { if (pid) try { process.kill(-pid, 'SIGKILL'); } catch {} });
  assert.equal((await run('webStart')).result.url, 'http://127.0.0.1:3080/?token=fixture-only');
  pid = JSON.parse(await readFile(join(root, '.dsh-remote-agents/web-ui/3080/process.json'), 'utf8')).pid;
  // The browser reaches the instance through a tunnel on the access address, which it must trust.
  assert.match(await readFile(join(root, '.dsh-remote-agents/web-ui/3080/output.log'), 'utf8'), /--trusted-host 100\.96\.195\.115\b/);
  assert.equal((await run('webStart', remote, 'other.example')).status, 409);
  assert.throws(() => fileOperation({ op: 'webStart', path: '.', port: 3080, host: '-oProxyCommand=x' }), /address/);
  assert.equal((await run('webStart')).result.managed, true);
  assert.equal(JSON.parse(await readFile(join(root, '.dsh-remote-agents/web-ui/3080/process.json'), 'utf8')).pid, pid);
  assert.equal((await run('webStop', root)).status, 409);
  assert.equal((await run('webStop')).result.stopped, true);
  assert.equal((await run('webStop')).status, 409);
});
test('three-way pull and push preserve metadata, detect conflicts, preview without writes and propagate deletes', async t => {
  const f = await fixture(t), d = await directory(t); await f.service.close();
  const agents = new RemoteAgentsService(f.store, host => ({ ...f.remote.backend(host), workspaceFiles: d.files })); t.after(() => agents.close());
  const workspace = new WorkspaceService(agents, async () => ({ hostIds: [f.hostId], cwd: d.remote }), async () => d.local);
  const signal = new AbortController().signal;
  await writeFile(join(d.local, '.dsh-remote-meta.json'), 'keep this metadata');
  await writeFile(join(d.remote, 'code.txt'), 'one');
  assert.equal((await workspace.sync('session', 'pull', true, signal)).changes.length, 1);
  assert.deepEqual(await readdir(d.local), ['.dsh-remote-meta.json']);
  await workspace.sync('session', 'pull', false, signal);
  assert.equal(await readFile(join(d.local, 'code.txt'), 'utf8'), 'one');
  await writeFile(join(d.remote, 'code.txt'), 'remote'); await writeFile(join(d.local, 'code.txt'), 'local');
  assert.deepEqual((await workspace.sync('session', 'pull', false, signal)).conflicts, ['code.txt']);
  assert.equal(await readFile(join(d.local, 'code.txt'), 'utf8'), 'local');
  await writeFile(join(d.remote, 'code.txt'), 'one');
  await workspace.sync('session', 'push', false, signal);
  assert.equal(await readFile(join(d.remote, 'code.txt'), 'utf8'), 'local');
  await rm(join(d.remote, 'code.txt')); await workspace.sync('session', 'pull', false, signal);
  assert.deepEqual(await readdir(d.local), ['.dsh-remote-meta.json']);
  assert.equal(await readFile(join(d.local, '.dsh-remote-meta.json'), 'utf8'), 'keep this metadata');
});
test('a changed sync preview cannot be applied and large editor saves use stdin rather than SSH argv', async t => {
  const f = await fixture(t), d = await directory(t); await f.service.close();
  const agents = new RemoteAgentsService(f.store, host => ({ ...f.remote.backend(host), workspaceFiles: d.files })); t.after(() => agents.close());
  const workspace = new WorkspaceService(agents, async () => ({ hostIds: [f.hostId], cwd: d.remote }), async () => d.local), signal = new AbortController().signal;
  const content = '\n'.repeat(200000);
  await d.files.operate(d.remote, { op: 'write', path: 'large.txt', revision: null, content });
  assert.equal(await readFile(join(d.remote, 'large.txt'), 'utf8'), content);
  const preview = await workspace.sync('session', 'pull', true, signal);
  await writeFile(join(d.remote, 'new.txt'), 'new file after preview');
  await assert.rejects(workspace.sync('session', 'pull', false, signal, undefined, preview.planId), /Preview again/);
  assert.deepEqual(await readdir(d.local), []);
});
test('file routes use the verified session binding and never accept another machine or stale workspace', async t => {
  const f = await fixture(t), d = await directory(t); await f.service.close();
  const agents = new RemoteAgentsService(f.store, host => ({ ...f.remote.backend(host), workspaceFiles: d.files })); t.after(() => agents.close());
  let cwd = d.remote;
  const workspace = new WorkspaceService(agents, async id => { assert.equal(id, 'session'); return { hostIds: [f.hostId], cwd }; }, async () => d.local);
  const handler = workspaceTransferHandler(workspace), target = { hostId: f.hostId, cwd: d.remote, label: '' };
  const q = new URLSearchParams({ sessionId: 'session', hostId: target.hostId, cwd: target.cwd, path: 'new.bin' });
  const upload = new Request(`http://dsh.test/api/remote-agents/files?${q}`, { method: 'POST', headers: { 'X-DSH-Remote-Agents': '1', 'X-File-Size': '3', 'X-File-Revision': 'new' }, body: new Uint8Array([0, 1, 255]) });
  assert.equal((await handler(upload)).status, 200);
  q.set('revision', hash(Buffer.from([0, 1, 255])));
  assert.deepEqual(new Uint8Array(await (await handler(new Request(`http://dsh.test/api/remote-agents/files?${q}`, { headers: { 'X-DSH-Remote-Agents': '1' } }))).arrayBuffer()), new Uint8Array([0, 1, 255]));
  cwd = d.root;
  assert.equal((await handler(new Request(`http://dsh.test/api/remote-agents/files?${q}`, { headers: { 'X-DSH-Remote-Agents': '1' } }))).status, 409);
  await assert.rejects(workspace.operate('session', { op: 'list', path: '.' }, new AbortController().signal, { ...target, hostId: 'other-host' }), /verified remote workspace/);
});
test('sync never deletes a synced path that became a symbolic link on either side, nor anything below it', async t => {
  const f = await fixture(t), d = await directory(t); await f.service.close();
  const agents = new RemoteAgentsService(f.store, host => ({ ...f.remote.backend(host), workspaceFiles: d.files })); t.after(() => agents.close());
  const workspace = new WorkspaceService(agents, async () => ({ hostIds: [f.hostId], cwd: d.remote }), async () => d.local), signal = new AbortController().signal;
  await mkdir(join(d.remote, 'dir')); await writeFile(join(d.remote, 'dir/inner.txt'), 'inner');
  await writeFile(join(d.remote, 'file.txt'), 'file'); await writeFile(join(d.remote, 'local.txt'), 'local');
  await workspace.sync('session', 'pull', false, signal);
  await rm(join(d.remote, 'file.txt')); await symlink('missing-target', join(d.remote, 'file.txt'));
  await rm(join(d.remote, 'dir'), { recursive: true }); await symlink('missing-directory', join(d.remote, 'dir'));
  const pull = await workspace.sync('session', 'pull', true, signal);
  assert.deepEqual(pull.changes, []); assert.deepEqual(pull.conflicts, []);
  assert.deepEqual([...pull.skipped].sort(), ['dir', 'file.txt']);
  await workspace.sync('session', 'pull', false, signal, undefined, pull.planId);
  assert.equal(await readFile(join(d.local, 'file.txt'), 'utf8'), 'file');
  assert.equal(await readFile(join(d.local, 'dir/inner.txt'), 'utf8'), 'inner');
  // A local edit to a path that is a link on the remote is not pushed over the link.
  await writeFile(join(d.local, 'file.txt'), 'edited locally');
  const edited = await workspace.sync('session', 'push', true, signal);
  assert.deepEqual([edited.changes, edited.conflicts], [[], []]);
  // The same holds when the local copy becomes the link.
  await rm(join(d.local, 'local.txt')); await symlink('missing-target', join(d.local, 'local.txt'));
  const push = await workspace.sync('session', 'push', true, signal);
  assert.deepEqual([push.changes, push.conflicts], [[], []]);
  await workspace.sync('session', 'push', false, signal, undefined, push.planId);
  assert.equal(await readFile(join(d.remote, 'local.txt'), 'utf8'), 'local');
});
test('a sync preview with no changes can be applied to record the baseline', async t => {
  const f = await fixture(t), d = await directory(t); await f.service.close();
  const agents = new RemoteAgentsService(f.store, host => ({ ...f.remote.backend(host), workspaceFiles: d.files })); t.after(() => agents.close());
  const workspace = new WorkspaceService(agents, async () => ({ hostIds: [f.hostId], cwd: d.remote }), async () => d.local), signal = new AbortController().signal;
  await writeFile(join(d.remote, 'same.txt'), 'same'); await writeFile(join(d.local, 'same.txt'), 'same');
  const preview = await workspace.sync('session', 'pull', true, signal);
  assert.deepEqual(preview.changes, []);
  await workspace.sync('session', 'pull', false, signal, undefined, preview.planId);
  await writeFile(join(d.remote, 'same.txt'), 'changed on the remote only');
  const next = await workspace.sync('session', 'pull', true, signal);
  assert.deepEqual(next.conflicts, []); assert.deepEqual(next.changes.map(c => c.path), ['same.txt']);
});
test('a pull that updates a mirrored file keeps its permissions', async t => {
  const f = await fixture(t), d = await directory(t); await f.service.close();
  const agents = new RemoteAgentsService(f.store, host => ({ ...f.remote.backend(host), workspaceFiles: d.files })); t.after(() => agents.close());
  const workspace = new WorkspaceService(agents, async () => ({ hostIds: [f.hostId], cwd: d.remote }), async () => d.local), signal = new AbortController().signal;
  await writeFile(join(d.remote, 'run.sh'), '#!/bin/sh\necho one\n');
  await workspace.sync('session', 'pull', false, signal);
  await chmod(join(d.local, 'run.sh'), 0o755);
  await writeFile(join(d.remote, 'run.sh'), '#!/bin/sh\necho two\n');
  await workspace.sync('session', 'pull', false, signal);
  assert.equal(await readFile(join(d.local, 'run.sh'), 'utf8'), '#!/bin/sh\necho two\n');
  assert.equal((await stat(join(d.local, 'run.sh'))).mode & 0o777, 0o755);
});
test('concurrent saves holding the same revision let exactly one through', async t => {
  const { remote, files } = await directory(t);
  await writeFile(join(remote, 'shared.txt'), 'base');
  for (let round = 0; round < 6; round++) {
    const revision = hash(await readFile(join(remote, 'shared.txt')));
    const results = await Promise.allSettled(Array.from({ length: 6 }, (_, writer) =>
      files.operate(remote, { op: 'write', path: 'shared.txt', content: `round ${round} writer ${writer}`, revision }) as Promise<{ revision: string }>));
    const saved = results.flatMap(r => r.status === 'fulfilled' ? [r.value] : []);
    assert.equal(saved.length, 1, `round ${round}: ${saved.length} saves succeeded`);
    for (const r of results) if (r.status === 'rejected') assert.match(String(r.reason), /file changed/);
    assert.equal(hash(await readFile(join(remote, 'shared.txt'))), saved[0].revision);
  }
});
test('a save waits for a live lock holder and breaks the lock of one that died', async t => {
  const { root, remote, files } = await directory(t);
  await writeFile(join(remote, 'locked.txt'), 'base');
  const locks = join(root, '.dsh-remote-agents/locks'), key = hash(join(await realpath(remote), 'locked.txt'));
  await mkdir(locks, { recursive: true });
  const lock = join(locks, lockEntry(key, process.pid)); await writeFile(lock, '');
  let done = false;
  const save = files.operate(remote, { op: 'write', path: 'locked.txt', content: 'after the live holder', revision: hash('base') }).then(() => { done = true; });
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(done, false, 'the save must wait while the holder is alive');
  await rm(lock); await save;
  assert.equal(await readFile(join(remote, 'locked.txt'), 'utf8'), 'after the live holder');
  const exited = spawn(process.execPath, ['-e', '']); await new Promise(resolve => exited.once('exit', resolve));
  await writeFile(join(locks, lockEntry(key, exited.pid!)), '');
  await files.operate(remote, { op: 'write', path: 'locked.txt', content: 'after the dead holder', revision: hash('after the live holder') });
  assert.equal(await readFile(join(remote, 'locked.txt'), 'utf8'), 'after the dead holder');
  assert.deepEqual(await readdir(locks), []);
});
test('saves that reclaim a dead holder\'s lock together still let exactly one through', async t => {
  const { root, remote, files } = await directory(t);
  const exited = spawn(process.execPath, ['-e', '']); await new Promise(resolve => exited.once('exit', resolve));
  const locks = join(root, '.dsh-remote-agents/locks'); await mkdir(locks, { recursive: true });
  await writeFile(join(remote, 'shared.txt'), 'base');
  for (let round = 0; round < 8; round++) {
    await writeFile(join(locks, lockEntry(hash(join(await realpath(remote), 'shared.txt')), exited.pid!)), '');
    const revision = hash(await readFile(join(remote, 'shared.txt')));
    const results = await Promise.allSettled(Array.from({ length: 6 }, (_, writer) =>
      files.operate(remote, { op: 'write', path: 'shared.txt', content: `round ${round} writer ${writer}`, revision }) as Promise<{ revision: string }>));
    const saved = results.flatMap(r => r.status === 'fulfilled' ? [r.value] : []);
    assert.equal(saved.length, 1, `round ${round}: ${saved.length} saves succeeded`);
    assert.equal(hash(await readFile(join(remote, 'shared.txt'))), saved[0].revision);
  }
  assert.deepEqual(await readdir(locks), []);
});
test('paths keep leading and trailing spaces, so an operation never reaches a differently named file', async t => {
  const f = await fixture(t), d = await directory(t); await f.service.close();
  const agents = new RemoteAgentsService(f.store, host => ({ ...f.remote.backend(host), workspaceFiles: d.files })); t.after(() => agents.close());
  const workspace = new WorkspaceService(agents, async () => ({ hostIds: [f.hostId], cwd: d.remote }), async () => d.local), signal = new AbortController().signal;
  await writeFile(join(d.remote, 'notes.txt'), 'plain'); await writeFile(join(d.remote, ' notes.txt '), 'spaced');
  const spaced = await workspace.operate('session', { op: 'read', path: ' notes.txt ' }, signal) as WorkspaceFile;
  assert.equal(spaced.content, 'spaced'); assert.equal(spaced.path, ' notes.txt ');
  await workspace.operate('session', { op: 'write', path: ' notes.txt ', content: 'saved', revision: spaced.revision }, signal);
  await workspace.operate('session', { op: 'move', path: ' notes.txt ', destination: ' moved ', revision: hash('saved') }, signal);
  assert.equal(await readFile(join(d.remote, ' moved '), 'utf8'), 'saved');
  await workspace.operate('session', { op: 'remove', path: ' moved ', revision: hash('saved') }, signal);
  assert.deepEqual(await readdir(d.remote), ['notes.txt']);
  assert.equal(await readFile(join(d.remote, 'notes.txt'), 'utf8'), 'plain');
  // File transfers keep the exact name too.
  const handler = workspaceTransferHandler(workspace), q = new URLSearchParams({ sessionId: 'session', hostId: f.hostId, cwd: d.remote, path: ' upload ' });
  const upload = await handler(new Request(`http://dsh.test/api/remote-agents/files?${q}`, { method: 'POST', headers: { 'X-DSH-Remote-Agents': '1', 'X-File-Size': '2', 'X-File-Revision': 'new' }, body: new Uint8Array([1, 2]) }));
  assert.equal(upload.status, 200);
  q.set('revision', hash(Buffer.from([1, 2])));
  assert.deepEqual(new Uint8Array(await (await handler(new Request(`http://dsh.test/api/remote-agents/files?${q}`, { headers: { 'X-DSH-Remote-Agents': '1' } }))).arrayBuffer()), new Uint8Array([1, 2]));
  assert.deepEqual((await readdir(d.remote)).sort(), [' upload ', 'notes.txt']);
  assert.equal(expectedTarget({ hostId: f.hostId, cwd: '/srv/project ' })?.cwd, '/srv/project ');
  assert.throws(() => fileOperation({ op: 'read', path: 'bad\0name' }), /Invalid workspace path/);
});
test('a workspace at the filesystem root reaches its subpaths', async t => {
  const { remote, files } = await directory(t);
  await writeFile(join(remote, 'root.txt'), 'under the root');
  const file = relative('/', await realpath(join(remote, 'root.txt')));
  const read = await files.operate('/', { op: 'read', path: file }) as WorkspaceFile;
  assert.equal(read.content, 'under the root'); assert.equal(read.path, file);
  await files.operate('/', { op: 'write', path: file, content: 'saved from /', revision: read.revision });
  assert.equal(await readFile(join(remote, 'root.txt'), 'utf8'), 'saved from /');
  const listing = await files.operate('/', { op: 'list', path: relative('/', await realpath(remote)) }) as { entries: { name: string }[] };
  assert.deepEqual(listing.entries.map(e => e.name), ['root.txt']);
});
