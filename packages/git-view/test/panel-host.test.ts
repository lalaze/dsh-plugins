import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { PanelHost, panelHandler } from '../src/gp-host.js';
import type { SubprocessLike } from '../src/gp/host/git.js';
import type { GitBatch, RemoteTarget, RemoteWorkspaces } from '../src/runner.js';

const run = promisify(execFile);
/** DSH's subprocess service in the shape the panel's runner spawns with, over child_process. */
function subprocess(home: string, spawned: string[][] = []): SubprocessLike {
  return {
    spawn(spec) {
      spawned.push([...spec.argv]);
      const input = typeof spec.stdio.stdin === 'object' ? spec.stdio.stdin.data : undefined;
      const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), GIT_CONFIG_NOSYSTEM: '1', ...spec.env } as NodeJS.ProcessEnv });
      if (input !== undefined) child.stdin!.end(input);
      let out = '', err = '';
      child.stdout!.on('data', data => { out += data; }); child.stderr!.on('data', data => { err += data; });
      spec.signal?.addEventListener('abort', () => child.kill(), { once: true });
      const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((ok, fail) => { child.on('error', fail); child.on('close', (code, signal) => ok({ exitCode: code, signal })); });
      return { done, collected: { stdout: { readFrom: () => ({ text: out, lossy: false }) }, stderr: { readFrom: () => ({ text: err, lossy: false }) } } };
    },
  };
}
async function setup(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-git-panel-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home'), repo = join(root, 'repo');
  await mkdir(home); await mkdir(repo);
  await writeFile(join(home, '.gitconfig'), '[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n');
  const env = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...argv: string[]) => run('git', argv, { cwd: repo, env }).then(r => r.stdout);
  await git('init', '-q');
  await writeFile(join(repo, 'a.txt'), 'one\n'); await writeFile(join(repo, '.gitignore'), 'build/\n');
  await git('add', '-A'); await git('commit', '-qm', 'Initial');
  await writeFile(join(repo, 'a.txt'), 'two\n'); await mkdir(join(repo, 'new')); await writeFile(join(repo, 'new/b.txt'), 'b\n');
  await mkdir(join(repo, 'build')); await writeFile(join(repo, 'build/out.js'), 'x\n');
  return { root, home, repo, git };
}
const call = async (host: PanelHost, method: string, request: Record<string, unknown>) => {
  const response = await panelHandler(host)(new Request('http://dsh/api/git-view/gp', { method: 'POST', headers: { 'X-DSH-Git-View': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ method, request }) }));
  const body = await response.json() as { ok: boolean; value: { ok: boolean; value: Record<string, unknown> } & Record<string, unknown> };
  assert.equal(body.ok, true);
  return body.value;
};
const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

/**
 * Remote Agents as git-view uses it, over a folder of this machine: Git runs in its own process for each batch, as the
 * SSH host would run it, and files are read, listed and removed by workspace-relative paths.
 */
function fakeRemote(cwd: string, home: string, batches: GitBatch[]): RemoteWorkspaces {
  const at = (path: string) => { const full = resolve(cwd, path); assert.ok(!relative(cwd, full).startsWith('..'), `inside the workspace: ${path}`); return full; };
  const target: RemoteTarget = { hostId: 'box', label: 'devbox', cwd };
  return {
    gitWorkspaceVersion: 1,
    target: async () => target,
    async git(_session, batch, _signal, expected) {
      assert.deepEqual(expected, target, 'every call is bound to the verified target');
      batches.push(batch);
      return Promise.all(batch.commands.map(async command => {
        try { const { stdout, stderr } = await run('git', command.argv, { cwd, env: { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1' } }); return { exitCode: 0, stdout, stderr, timedOut: false, truncated: false, skipped: false }; }
        catch (error) { const e = error as { code?: number; stdout?: string; stderr?: string }; return { exitCode: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '', timedOut: false, truncated: false, skipped: false }; }
      }));
    },
    cancelGit: async () => {},
    stat: async (_s, path) => { const data = await readFile(at(path)); return { path, revision: sha(data), size: data.length }; },
    download: async (_s, path, revision) => { const data = await readFile(at(path)); assert.equal(sha(data), revision); return data; },
    upload: async () => assert.fail('the panel writes no files'),
    list: async (_s, path) => ({ path, entries: await Promise.all((await readdir(at(path), { withFileTypes: true })).map(async entry => {
      const info = await stat(join(at(path), entry.name));
      return { name: entry.name, kind: entry.isDirectory() ? 'directory' : 'file', size: info.size, modified: info.mtime.toISOString() };
    })) }),
    remove: async (_s, path, revision) => { const full = at(path); assert.equal(sha(await readFile(full)), revision); await rm(full); return { path }; },
  };
}

test('locally, the panel reads the snapshot, history, folders and diffs, and stages and commits through DSH’s subprocess service', async t => {
  const { home, repo, git } = await setup(t), spawned: string[][] = [];
  const host = new PanelHost({ cwdOf: async () => repo, isRemoteCwd: () => false, subprocess: subprocess(home, spawned), git: async () => 'git',
    gitConfig: async () => ['-c', 'credential.helper='], remote: () => undefined, get: () => undefined, config: {} });
  const snapshot = await call(host, 'snapshot', { sessionId: 's1' });
  assert.equal(snapshot.ok, true);
  const value = snapshot.value as { branch: string; changes: { path: string }[]; root: string };
  assert.equal(value.branch, 'main');
  assert.deepEqual(value.changes.map(change => change.path).sort(), ['a.txt', 'new/b.txt']);
  assert.ok(spawned.every(argv => argv[0] === 'git' && argv[1] === '-c' && argv[2] === 'credential.helper='), 'saved credentials apply to every command');
  const history = await call(host, 'query', { sessionId: 's1', query: { kind: 'history', limit: 10, skip: 0 } });
  assert.deepEqual((history.value as { commits: { subject: string }[] }).commits.map(commit => commit.subject), ['Initial']);
  const listing = await call(host, 'query', { sessionId: 's1', query: { kind: 'dir-list', path: '' } });
  const entries = (listing.value as { entries: { name: string; ignored?: boolean }[] }).entries;
  assert.equal(entries.find(entry => entry.name === 'build')?.ignored, true, 'ignored folders are marked through check-ignore on standard input');
  assert.equal(entries.some(entry => entry.name === '.git'), false);
  await call(host, 'run', { sessionId: 's1', action: { kind: 'stage', paths: ['a.txt'] } });
  const committed = await call(host, 'run', { sessionId: 's1', action: { kind: 'commit', message: 'Second' } });
  assert.equal(committed.ok, true, JSON.stringify(committed));
  assert.equal((await git('log', '-1', '--pretty=%s')).trim(), 'Second');
  assert.equal(await git('status', '--porcelain=v1', '--', 'a.txt'), '');
  assert.deepEqual(await call(host, 'version', {}), { current: '0.0.0', updateAvailable: false, checkedRemote: false });
});

test('in a Remote Agents workspace, the panel runs Git and reads files on the remote machine, never in the local anchor', async t => {
  const { root, home, repo, git } = await setup(t), batches: GitBatch[] = [];
  const anchor = join(root, 'anchor', 'remote-workspaces', 'box');
  await mkdir(anchor, { recursive: true });
  const service = fakeRemote(repo, home, batches), spawned: string[][] = [];
  const host = new PanelHost({ cwdOf: async () => anchor, isRemoteCwd: cwd => cwd === anchor, subprocess: subprocess(home, spawned), git: async () => 'git',
    gitConfig: async () => [], remote: () => service, get: () => undefined, config: {} });
  const snapshot = await call(host, 'snapshot', { sessionId: 's2' });
  assert.equal(snapshot.ok, true, JSON.stringify(snapshot));
  const value = snapshot.value as { root: string; changes: { path: string }[] };
  assert.equal(value.root, repo);
  assert.deepEqual(value.changes.map(change => change.path).sort(), ['a.txt', 'new/b.txt']);
  assert.deepEqual(spawned, [], 'no Git runs on this machine');
  assert.ok(batches.every(batch => batch.commands.length === 1 && batch.commands[0].argv[0] === '-C' && posix.isAbsolute(batch.commands[0].argv[1])));
  // The folder listing marks ignored entries; the remote batch passes the paths as arguments.
  const listing = await call(host, 'query', { sessionId: 's2', query: { kind: 'dir-list', path: '' } });
  const entries = (listing.value as { entries: { name: string; dir: boolean; ignored?: boolean }[] }).entries;
  assert.deepEqual(entries.filter(entry => entry.dir).map(entry => [entry.name, entry.ignored === true]).sort(), [['build', true], ['new', false]]);
  assert.ok(batches.some(batch => batch.commands[0].argv.includes('check-ignore') && !batch.commands[0].argv.includes('--stdin')));
  const file = await call(host, 'query', { sessionId: 's2', query: { kind: 'file-content', path: 'a.txt' } });
  assert.equal(file.ok, true, JSON.stringify(file));
  assert.match(JSON.stringify(file.value), /two/);
  const diff = await call(host, 'query', { sessionId: 's2', query: { kind: 'diff', path: 'a.txt', base: 'worktree' } });
  assert.match((diff.value as { text: string }).text, /-one\n\+two/);
  // Discarding an untracked file removes it on the remote machine.
  const discarded = await call(host, 'run', { sessionId: 's2', action: { kind: 'discard', paths: ['new/b.txt'] } });
  assert.equal(discarded.ok, true, JSON.stringify(discarded));
  await assert.rejects(stat(join(repo, 'new/b.txt')));
  assert.equal((await git('status', '--porcelain=v1')).trim(), 'M a.txt');
  const opened = await call(host, 'openFile', { sessionId: 's2', path: 'a.txt' });
  assert.equal(opened.ok, false, 'remote files do not open in an application on this computer');
});

test('a remote workspace without Remote Agents, or with one before Git workspace support, is reported instead of read locally', async t => {
  const { root, home } = await setup(t), anchor = join(root, 'remote-workspaces', 'box');
  const host = (remote: () => RemoteWorkspaces | undefined) => new PanelHost({ cwdOf: async () => anchor, isRemoteCwd: () => true, subprocess: subprocess(home), git: async () => 'git',
    gitConfig: async () => [], remote, get: () => undefined, config: {} });
  assert.deepEqual(await call(host(() => undefined), 'snapshot', { sessionId: 's' }), { ok: false, error: { code: 'git-unavailable', message: 'Install Remote Agents to use Git in this remote workspace' } });
  assert.deepEqual(await call(host(() => ({ gitWorkspaceVersion: 0 }) as never), 'snapshot', { sessionId: 's' }),
    { ok: false, error: { code: 'git-unavailable', message: 'Update Remote Agents to a version with Git workspace support' } });
  const response = await panelHandler(host(() => undefined))(new Request('http://dsh/api/git-view/gp', { method: 'POST', body: '{}' }));
  assert.equal(response.status, 403, 'requests need the Git view’s header');
});
