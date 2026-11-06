import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Context } from '@deepseek-ai/cordis';
import { apply } from '../src/index.js';
import { sessionCwd, workingDirectoryOf } from '../src/session-cwd.js';

const live = (cwd: string) => ({ get: (id: string) => id === 's1' ? { header: { cwd } } : undefined });
const stored = (cwd: string) => ({ list: async () => [{ header: { id: 's1', cwd } }] });
const lookup = (services: Record<string, unknown>) => (name: string) => services[name];
const local = () => false;

test('a live session in the project it started in stays there', async () => {
  const get = lookup({ sessions: live('/project'), workingDirectory: { get: () => '/project' } });
  assert.equal(await sessionCwd(get, 's1'), '/project');
  assert.equal(await workingDirectoryOf(get, 's1', local), '/project');
});

test('a live session moved into a worktree works there, while its start stays the project', async () => {
  const get = lookup({ sessions: live('/project'), workingDirectory: { get: () => '/project/.agents/worktrees/one' } });
  assert.equal(await sessionCwd(get, 's1'), '/project');
  assert.equal(await workingDirectoryOf(get, 's1', local), '/project/.agents/worktrees/one');
});

test('a closed session keeps its move, read from DSH without reopening the session', async () => {
  const asked: string[] = [];
  const get = lookup({
    sessions: live('/other'), sessionPersistence: stored('/project'),
    sessionController: { projections: async ({ sessionId }: { sessionId: string }, signal: AbortSignal) => {
      asked.push(sessionId); assert.ok(signal instanceof AbortSignal);
      return { kind: 'sequenced', asOfSeq: 3, values: { workingDirectory: '/project/.agents/worktrees/one' } };
    } },
  });
  assert.equal(await workingDirectoryOf(get, 'unlisted', local), undefined, 'a session DSH does not know has no directory');
  assert.deepEqual(asked, []);
  const closed = lookup({ ...Object.fromEntries(['sessionPersistence', 'sessionController'].map(name => [name, get(name)])) });
  assert.equal(await workingDirectoryOf(closed, 's1', local), '/project/.agents/worktrees/one');
  assert.deepEqual(asked, ['s1']);
});

test('without a usable answer from DSH a session stays in the directory it started in', async () => {
  const start = { sessionPersistence: stored('/project') };
  const projections = (value: unknown) => ({ sessionController: { projections: async () => value } });
  for (const services of [
    start,
    { ...start, ...projections(null) },
    { ...start, ...projections({ kind: 'sequenced', asOfSeq: 0, values: {} }) },
    { ...start, ...projections({ kind: 'sequenced', asOfSeq: 0, values: { workingDirectory: null } }) },
    { ...start, sessionController: { projections: async () => { throw new Error('unreadable'); } } },
  ]) assert.equal(await workingDirectoryOf(lookup(services), 's1', local), '/project');
  const broken = lookup({ sessions: live('/project'), workingDirectory: { get: () => { throw new Error('no projection'); } } });
  assert.equal(await workingDirectoryOf(broken, 's1', local), '/project');
  assert.equal(await workingDirectoryOf(lookup({ sessions: live('/project') }), 's1', local), '/project');
});

test('a remote workspace stays on its anchor, whose Git runs on the remote machine', async () => {
  const get = lookup({ sessions: live('/home/.dsh/remote-workspaces/host/ws'), workingDirectory: { get: () => '/elsewhere' } });
  assert.equal(await workingDirectoryOf(get, 's1', () => true), '/home/.dsh/remote-workspaces/host/ws');
});

const run = promisify(execFile);
const server = (home: string) => ({
  resolveExecutable: async () => 'git',
  spawn(spec: { argv: string[]; cwd: string; env?: NodeJS.ProcessEnv; stdio?: { stdin?: unknown } }) {
    const input = typeof spec.stdio?.stdin === 'object' ? (spec.stdio.stdin as { data?: string }).data : undefined;
    const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      env: { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', ...spec.env } as NodeJS.ProcessEnv });
    if (input !== undefined) child.stdin!.end(input);
    let out = '', err = '';
    child.stdout!.on('data', data => { out += data; }); child.stderr!.on('data', data => { err += data; });
    const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((ok, fail) => { child.on('error', fail); child.on('close', (exitCode, signal) => ok({ exitCode, signal })); });
    return { done, collected: { stdout: { readFrom: () => ({ text: out, lossy: false }) }, stderr: { readFrom: () => ({ text: err, lossy: false }) } } };
  },
});

async function installed(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-git-view-cwd-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home'), repo = join(root, 'repo'), worktree = join(repo, '.agents/worktrees/one');
  await mkdir(home); await mkdir(repo);
  await writeFile(join(home, '.gitconfig'), '[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n');
  const env = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...argv: string[]) => run('git', argv, { cwd: repo, env });
  await git('init', '-q'); await writeFile(join(repo, '.gitignore'), '.agents/\n');
  await git('add', '-A'); await git('commit', '-qm', 'Initial');
  await git('worktree', 'add', '-q', '-b', 'dsh-one', worktree);
  await writeFile(join(repo, 'main-only.txt'), 'main\n'); await writeFile(join(worktree, 'worktree-only.txt'), 'worktree\n');
  const routes = new Map<string, (request: Request) => Promise<Response>>();
  const services: Record<string, unknown> = {
    subprocess: server(home), sessions: live(repo), workingDirectory: { get: () => worktree },
  };
  const before = process.env.DSH_HOME;
  process.env.DSH_HOME = join(root, 'dsh');
  t.after(() => { if (before === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = before; });
  apply({ get: (name: string) => services[name], connection: { fetch: { register: (route: { path: string; fetch: (request: Request) => Promise<Response> }) => routes.set(route.path, route.fetch) } } } as unknown as Context);
  const post = async (path: string, body: unknown) => (await routes.get(path)!(new Request(`http://dsh${path}`, {
    method: 'POST', headers: { 'X-DSH-Git-View': '1', 'content-type': 'application/json' }, body: JSON.stringify(body),
  }))).json() as Promise<Record<string, any>>;
  return { repo, worktree, post };
}

test('in a worktree session the Git panel shows the worktree, while file marks and diffs stay with the project DSH’s file tree shows', async t => {
  const { repo, worktree, post } = await installed(t);
  const panel = (await post('/api/git-view/gp', { method: 'snapshot', request: { sessionId: 's1' } })).value.value;
  assert.equal(panel.root, worktree);
  assert.equal(panel.branch, 'dsh-one');
  assert.deepEqual(panel.changes.map((change: { path: string }) => change.path), ['worktree-only.txt']);
  const marks = await post('/api/git-view', { action: 'status', sessionId: 's1' });
  assert.deepEqual(marks.changes.map((change: { path: string }) => change.path), ['main-only.txt']);
  // A diff tab sends the directory DSH's client knows, which is where the conversation started.
  const diff = await post('/api/git-view', { action: 'compare', sessionId: 's1', path: 'main-only.txt', expectedCwd: repo });
  assert.equal(diff.error, undefined);
});
