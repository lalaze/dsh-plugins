import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { SshBackend } from '../src/agents/backend.js';
import { Store } from '../src/core/store.js';
import type { WorkspaceHosts } from '../src/workspace/hosts.js';
import { LocalMachine, RemoteMachine } from '../src/workspace/worktree-machine.js';
import { friendlyName, parseBranches, parseConfig, parseWorktrees, slugify, WorktreeService, type DshWorkspace, type DshWorkspaceController, type WorktreeHost, type WorktreeJob } from '../src/workspace/worktrees.js';
import { LocalTransport } from './relay-harness.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e' } }).trim();
const exists = (path: string) => stat(path).then(() => true, () => false);

/** DSH's workspace registry, in memory: creating a known folder returns its workspace, as DSH does. */
class FakeDsh implements DshWorkspaceController {
  items: DshWorkspace[] = [];
  archived: string[] = [];
  private next = 1;
  add(path: string, title = basename(path), sessionIds: string[] = []) { const item = { workspaceId: `ws-${this.next++}-workspace`, path, title, sessionIds }; this.items.push(item); return item; }
  async create({ path }: { path: string }) {
    const known = this.items.find(item => item.path === path);
    return known ? { workspace: known, created: false } : { workspace: this.add(path), created: true };
  }
  async rename({ workspaceId, title }: { workspaceId: string; title: string }) {
    if (this.items.some(item => item.title === title && item.workspaceId !== workspaceId)) throw new Error('workspace/name-conflict');
    this.items.find(item => item.workspaceId === workspaceId)!.title = title; return {};
  }
  async delete({ workspaceId }: { workspaceId: string }) { this.items = this.items.filter(item => item.workspaceId !== workspaceId); return { deleted: true }; }
  async insertBefore({ workspaceId, beforeWorkspaceId }: { workspaceId: string; beforeWorkspaceId?: string }) {
    const moved = this.items.find(item => item.workspaceId === workspaceId)!;
    this.items = this.items.filter(item => item !== moved);
    const at = beforeWorkspaceId ? this.items.findIndex(item => item.workspaceId === beforeWorkspaceId) : -1;
    this.items.splice(at < 0 ? this.items.length : at, 0, moved); return {};
  }
  async archiveSession({ sessionId }: { sessionId: string }) { this.archived.push(sessionId); return {}; }
  async *follow() { yield { type: 'baseline', value: { items: this.items.map(item => ({ ...item })) } }; await new Promise(() => {}); }
}
class FakeTags {
  readonly version = 1;
  state = { tags: [{ id: 'tag-work', name: 'Work', color: 'blue' }], assignments: {} as Record<string, string[]> };
  snapshot() { return structuredClone(this.state); }
  async replace(state: typeof this.state) { this.state = structuredClone(state); return this.snapshot(); }
  subscribe() { return () => {}; }
}

/** A project cloned from a bare origin with `main`, a pushed `feature/remote-only`, and a setup file. */
async function repository(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-worktrees-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const origin = join(root, 'origin.git'), seed = join(root, 'seed'), project = join(root, 'project');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'clone', '-q', origin, seed);
  await mkdir(join(seed, 'packages', 'app'), { recursive: true });
  await writeFile(join(seed, 'README.md'), 'hello\n');
  await writeFile(join(seed, 'packages', 'app', 'index.js'), '');
  await mkdir(join(seed, '.dsh'));
  await writeFile(join(seed, '.dsh', 'worktree.json'), JSON.stringify({
    setup: ['printf "%s|%s|%s" "$DSH_BRANCH_NAME" "$DSH_WORKTREE_PATH" "$DSH_SOURCE_CHECKOUT_PATH" > setup-ran.txt', 'echo set up'],
    teardown: ['echo "$DSH_BRANCH_NAME" > "$DSH_SOURCE_CHECKOUT_PATH/teardown-ran.txt"'],
  }));
  git(seed, 'add', '-A'); git(seed, 'commit', '-q', '-m', 'init'); git(seed, 'push', '-q', 'origin', 'main');
  git(seed, 'checkout', '-q', '-b', 'feature/remote-only'); await writeFile(join(seed, 'remote.txt'), 'r\n');
  git(seed, 'add', '-A'); git(seed, 'commit', '-q', '-m', 'remote'); git(seed, 'push', '-q', 'origin', 'feature/remote-only');
  git(root, 'clone', '-q', origin, project);
  const home = join(root, 'dsh');
  await mkdir(home);
  return { root, origin, seed, project, home };
}
function service(home: string, options: Partial<WorktreeHost> = {}) {
  const dsh = new FakeDsh(), tags = new FakeTags();
  const host: WorktreeHost = {
    machines: { hosts: () => [] } as unknown as WorkspaceHosts,
    access: { resolve: async () => ({ hostIds: [] }) },
    anchors: { create: async () => { throw new Error('no remote machines'); } },
    dsh: () => dsh, tags: () => tags, home, ...options,
  };
  return { worktrees: new WorktreeService(host), dsh, tags };
}
async function settle(worktrees: WorktreeService, job: WorktreeJob): Promise<WorktreeJob> {
  for (const deadline = Date.now() + 30_000; Date.now() < deadline; await new Promise(resolve => setTimeout(resolve, 20))) {
    const view = worktrees.job(job.id);
    if (view.state !== 'running') return view;
  }
  throw new Error('The worktree operation did not finish');
}

test('names, branches, worktree lists and the setup file parse as Git and DSH write them', () => {
  assert.equal(slugify('feature/Login form'), 'feature-Login-form');
  assert.equal(slugify('../..'), 'worktree');
  assert.match(friendlyName(), /^[a-z]+-[a-z]+$/);
  const refs = [
    ['refs/heads/main', '30', 'refs/remotes/origin/main', 'ahead 2, behind 1'],
    ['refs/remotes/origin/main', '20', '', ''],
    ['refs/remotes/fork/main', '10', '', ''],
    ['refs/remotes/team/a/topic', '50', '', ''],
    ['refs/remotes/origin/HEAD', '20', '', ''],
    ['refs/heads/stale', '5', 'refs/remotes/origin/stale', 'gone'],
  ].map(fields => fields.join('\0')).join('\n');
  assert.deepEqual(parseBranches(refs, ['origin', 'fork', 'team/a'], new Map([['main', '/repo']])), [
    { name: 'topic', local: false, date: 50, remote: 'team/a/topic' },
    { name: 'main', local: true, date: 30, remote: 'origin/main', ahead: 2, behind: 1, checkedOutAt: '/repo' },
    { name: 'stale', local: true, date: 5 },
  ]);
  assert.deepEqual(parseWorktrees('worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /w/x\nHEAD def\ndetached\n\nworktree /bare\nbare\n'), [
    { path: '/repo', branch: 'main', head: 'abc' }, { path: '/w/x', branch: null, head: 'def' }, { path: '/bare', branch: null, bare: true },
  ]);
  assert.deepEqual(parseConfig(undefined), { setup: [], teardown: [] });
  assert.deepEqual(parseConfig('{"setup":["pnpm i"]}'), { setup: ['pnpm i'], teardown: [] });
  assert.throws(() => parseConfig('{"setup":"pnpm i"}'), /must be a list of commands/);
  assert.throws(() => parseConfig('nope'), /not valid JSON/);
});

test('a new branch from a project becomes a DSH workspace next to it, set up and tagged like it', async t => {
  const { project, home, root } = await repository(t);
  const { worktrees, dsh, tags } = service(home);
  const notes = dsh.add(join(root, 'notes'), 'notes'), source = dsh.add(project, 'project'), after = dsh.add(join(root, 'other'), 'other');
  tags.state.assignments[source.workspaceId] = ['tag-work'];
  await mkdir(join(root, 'notes'));
  assert.deepEqual((await worktrees.projects()).map(p => [p.title, p.location.kind]), [['project', 'local']], 'folders outside Git are not projects');

  const detail = await worktrees.inspect(project);
  assert.equal(detail.name, 'project');
  assert.equal(detail.defaultBase, 'main');
  assert.equal(detail.subdir, '');
  assert.equal(detail.root.startsWith(join(await realpath(home), 'worktrees', 'project-')), true);
  assert.deepEqual(detail.branches.map(b => [b.name, b.local, b.remote]).sort(), [['feature/remote-only', false, 'origin/feature/remote-only'], ['main', true, 'origin/main']]);
  assert.equal(detail.setup.length, 2);

  const job = await settle(worktrees, worktrees.create({ path: project, mode: 'new', base: 'main', branch: 'feat/login' }));
  assert.equal(job.state, 'done', JSON.stringify(job));
  assert.deepEqual(job.steps.map(s => [s.id, s.state]), [['prepare', 'done'], ['checkout', 'done'], ['register', 'done'], ['setup', 'done']]);
  const worktree = job.result!.worktree;
  assert.equal(worktree, join(detail.root, 'feat-login'));
  assert.equal(git(worktree, 'symbolic-ref', '--short', 'HEAD'), 'feat/login');
  assert.throws(() => git(worktree, 'rev-parse', '--abbrev-ref', '@{upstream}'), 'a new branch does not track the branch it started from');
  assert.equal(await readFile(join(worktree, 'setup-ran.txt'), 'utf8'), `feat/login|${worktree}|${project}`);
  assert.match(job.log, /\$ echo set up\nset up\n/);
  assert.equal(job.result!.path, worktree);
  assert.equal(job.result!.title, 'project · feat/login');
  assert.deepEqual(dsh.items.map(item => item.title), ['notes', 'project', 'project · feat/login', 'other'], 'the new workspace sits after its project');
  const created = dsh.items[2];
  assert.deepEqual(tags.state.assignments[created.workspaceId], ['tag-work']);
  void notes; void after;

  const again = await worktrees.inspect(project);
  assert.deepEqual(again.worktrees, [{ path: worktree, branch: 'feat/login', workspace: { workspaceId: created.workspaceId, title: 'project · feat/login', path: worktree } }]);
  assert.deepEqual((await worktrees.projects()).map(p => p.path), [project], 'a worktree workspace is listed under its repository once');
  const taken = await settle(worktrees, worktrees.create({ path: project, mode: 'new', base: 'main', branch: 'feat/login' }));
  assert.deepEqual([taken.state, taken.error?.key, taken.actions], ['failed', 'Branch {branch} already exists. Check it out instead.', []]);
  const invalid = await settle(worktrees, worktrees.create({ path: project, mode: 'new', base: 'main', branch: 'bad..name' }));
  assert.equal(invalid.error?.key, '{branch} is not a valid branch name');
});

test('checking out a remote branch tracks it; a branch already checked out elsewhere is refused', async t => {
  const { project, home } = await repository(t);
  const { worktrees, dsh } = service(home);
  dsh.add(project, 'project');
  const job = await settle(worktrees, worktrees.create({ path: project, mode: 'existing', branch: 'feature/remote-only' }));
  assert.equal(job.state, 'done', JSON.stringify(job.error));
  assert.equal(git(job.result!.worktree, 'rev-parse', '--abbrev-ref', '@{upstream}'), 'origin/feature/remote-only');
  assert.equal(await readFile(join(job.result!.worktree, 'remote.txt'), 'utf8'), 'r\n');
  const busy = await settle(worktrees, worktrees.create({ path: project, mode: 'existing', branch: 'main' }));
  assert.equal(busy.error?.key, 'Branch {branch} is already checked out at {path}');
  assert.equal(busy.error?.values?.path, project);
});

test('a workspace inside the repository opens the same folder in the worktree', async t => {
  const { project, home } = await repository(t);
  const { worktrees, dsh } = service(home);
  const app = join(project, 'packages', 'app');
  dsh.add(app, 'app');
  const job = await settle(worktrees, worktrees.create({ path: app, mode: 'new', branch: 'app-work' }));
  assert.equal(job.state, 'done', JSON.stringify(job.error));
  assert.equal(job.result!.path, join(job.result!.worktree, 'packages', 'app'));
  assert.equal(job.result!.title, 'app · app-work');
  assert.equal(await exists(join(job.result!.worktree, 'setup-ran.txt')), true, 'setup runs at the top of the worktree');
});

test('a failed setup can be retried, skipped or discarded', async t => {
  const { project, home, seed } = await repository(t);
  await writeFile(join(seed, '.dsh', 'worktree.json'), JSON.stringify({ setup: ['test -f "$DSH_SOURCE_CHECKOUT_PATH/ready"', 'echo done > done.txt'] }));
  git(seed, 'checkout', '-q', 'main'); git(seed, 'commit', '-q', '-am', 'setup'); git(seed, 'push', '-q', 'origin', 'main');
  git(project, 'pull', '-q');
  const { worktrees, dsh } = service(home);
  dsh.add(project, 'project');

  const failed = await settle(worktrees, worktrees.create({ path: project, mode: 'new', branch: 'retry-me' }));
  assert.deepEqual([failed.state, failed.error?.key, failed.error?.values?.code, failed.actions], ['failed', 'Setup command failed with exit code {code}', '1', ['retry', 'skip', 'discard']]);
  assert.equal(dsh.items.length, 2, 'the workspace is in DSH before its setup runs');
  await writeFile(join(project, 'ready'), '');
  const retried = await settle(worktrees, await worktrees.act(failed.id, 'retry'));
  assert.equal(retried.state, 'done');
  assert.equal(await readFile(join(retried.result!.worktree, 'done.txt'), 'utf8'), 'done\n');

  await rm(join(project, 'ready'));
  const skipped = await settle(worktrees, worktrees.create({ path: project, mode: 'new', branch: 'skip-me' }));
  const done = await settle(worktrees, await worktrees.act(skipped.id, 'skip'));
  assert.deepEqual([done.state, done.steps.at(-1)!.state], ['done', 'skipped']);
  assert.equal(await exists(join(done.result!.worktree, 'done.txt')), false);

  const discarded = await settle(worktrees, await worktrees.act((await settle(worktrees, worktrees.create({ path: project, mode: 'new', branch: 'drop-me' }))).id, 'discard'));
  assert.equal(discarded.state, 'discarded', JSON.stringify(discarded.error));
  assert.equal(await exists(discarded.result!.worktree), false);
  assert.throws(() => git(project, 'rev-parse', '--verify', 'refs/heads/drop-me'), 'the branch it created is deleted');
  assert.deepEqual(dsh.items.map(item => item.title), ['project', 'project · skip-me', 'project · retry-me']);
  await assert.rejects(worktrees.act(discarded.id, 'retry'), /not available/);
});

test('archiving warns about unsaved work, runs teardown, removes the worktree and its workspace, and deletes a merged branch', async t => {
  const { project, home } = await repository(t);
  const { worktrees, dsh } = service(home);
  dsh.add(project, 'project');
  const job = await settle(worktrees, worktrees.create({ path: project, mode: 'new', branch: 'to-archive' }));
  const worktree = job.result!.worktree;
  dsh.items.find(item => item.path === worktree)!.sessionIds = ['session-a', 'session-b'];

  const clean = await worktrees.archiveCheck(project, worktree);
  assert.equal(clean.branch, 'to-archive');
  assert.equal(clean.dirty, 1, 'setup output is untracked');
  assert.equal(clean.unpushed, 0);
  assert.equal(clean.mergedInto, 'origin/main', 'a branch without commits of its own is merged');
  assert.deepEqual(clean.workspaces.map(w => [w.title, w.sessions]), [['project · to-archive', 2]]);
  assert.equal(clean.teardown.length, 1);
  await writeFile(join(worktree, 'new.txt'), 'x');
  git(worktree, 'add', 'new.txt'); git(worktree, 'commit', '-q', '-m', 'work');
  const busy = await worktrees.archiveCheck(project, worktree);
  assert.deepEqual([busy.unpushed, busy.mergedInto], [1, null]);

  await assert.rejects(worktrees.archiveCheck(project, project), /Only worktrees created here/);
  const kept = await settle(worktrees, worktrees.archive({ path: project, worktree, deleteBranch: true }));
  assert.equal(kept.state, 'done', JSON.stringify(kept.error));
  assert.deepEqual(kept.result!.warnings.map(w => w.key), ['Branch {branch} was kept because it is not merged']);
  assert.equal(await exists(worktree), false);
  assert.equal(git(project, 'rev-parse', '--verify', '--quiet', 'refs/heads/to-archive').length, 40, 'an unmerged branch stays');
  assert.equal(await readFile(join(project, 'teardown-ran.txt'), 'utf8'), 'to-archive\n');
  assert.deepEqual(dsh.archived, ['session-a', 'session-b']);
  assert.deepEqual(dsh.items.map(item => item.title), ['project']);
  assert.deepEqual((await worktrees.inspect(project)).worktrees, []);

  const merged = await settle(worktrees, worktrees.create({ path: project, mode: 'new', branch: 'merged' }));
  const archived = await settle(worktrees, worktrees.archive({ path: project, worktree: merged.result!.worktree, deleteBranch: true }));
  assert.deepEqual(archived.steps.map(s => [s.id, s.state]), [['sessions', 'done'], ['teardown', 'done'], ['remove', 'done'], ['branch', 'done'], ['unregister', 'done']]);
  assert.throws(() => git(project, 'rev-parse', '--verify', 'refs/heads/merged'));
});

test('on an SSH machine the worktree, its setup and its archive run through the remote shell', async t => {
  const { project, home, root } = await repository(t);
  const remoteHome = join(root, 'remote-home');
  await mkdir(remoteHome);
  const store = new Store(join(root, 'state.json')); await store.open();
  const backend = new SshBackend({ id: 'host-box-1', label: 'Box', connection: 'ssh://builder@localhost' }, store, new LocalTransport(remoteHome));
  t.after(() => backend.close?.());
  const machines = {
    hosts: () => [{ id: 'host-box-1', label: 'Box' }],
    browse: (_id: string, path?: string, options?: { entries?: boolean }) => backend.listDirectory(path, options),
    withWorkspace: (_id: string, verify: () => Promise<void>, action: (files: NonNullable<typeof backend.workspaceFiles>) => Promise<unknown>) => verify().then(() => action(backend.workspaceFiles)),
  } as unknown as WorkspaceHosts;
  // Anchors stand for remote folders; DSH sees only them.
  const anchors = new Map<string, string>(), anchorRoot = join(home, 'remote-workspaces', 'box');
  const anchor = async (folder: string) => { const path = join(anchorRoot, basename(folder)); await mkdir(path, { recursive: true }); anchors.set(path, folder); return path; };
  const projectAnchor = await anchor(project);
  const archivedIn: string[] = [];
  const { worktrees, dsh } = service(home, {
    machines,
    access: { resolve: async path => anchors.has(path!) ? { hostIds: ['host-box-1'], cwd: anchors.get(path!) } : { hostIds: [] } },
    anchors: { create: async (_hostId, folder) => ({ hostId: 'host-box-1', path: await anchor(folder), remotePath: folder }) },
    stopRemoteSessions: async (_hostId, folder) => { archivedIn.push(folder); },
    remote: hostId => new RemoteMachine(machines, hostId),
  });
  dsh.add(projectAnchor, 'project');
  dsh.add(join(root, 'project-local-view'), 'not a folder');

  assert.deepEqual((await worktrees.projects()).map(p => [p.title, p.location]), [['project', { kind: 'remote', hostId: 'host-box-1', host: 'Box' }]]);
  const detail = await worktrees.inspect(projectAnchor);
  assert.equal(detail.root.startsWith(join(await realpath(remoteHome), '.dsh-remote-agents', 'worktrees', 'project-')), true);
  const job = await settle(worktrees, worktrees.create({ path: projectAnchor, mode: 'new', branch: 'remote-work' }));
  assert.equal(job.state, 'done', JSON.stringify(job.error));
  assert.equal(anchors.get(job.result!.path!), job.result!.worktree);
  assert.equal(await readFile(join(job.result!.worktree, 'setup-ran.txt'), 'utf8'), `remote-work|${job.result!.worktree}|${project}`);
  assert.match(job.log, /set up/);
  assert.deepEqual((await worktrees.inspect(projectAnchor)).worktrees.map(w => w.workspace?.title), ['project · remote-work']);

  const archived = await settle(worktrees, worktrees.archive({ path: projectAnchor, worktree: job.result!.worktree }));
  assert.equal(archived.state, 'done', JSON.stringify(archived.error));
  assert.equal(await exists(job.result!.worktree), false);
  assert.equal(await exists(job.result!.path!), false, 'the anchor folder is removed');
  assert.deepEqual(archivedIn, [job.result!.worktree]);
  assert.deepEqual(dsh.items.map(item => item.title), ['project', 'not a folder']);
});

test('a remote setup command can be stopped, with everything it started', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-worktree-stream-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, 'state.json')); await store.open();
  const backend = new SshBackend({ id: 'host-box-2', label: 'Box', connection: 'ssh://builder@localhost' }, store, new LocalTransport(root));
  const output: string[] = [];
  const finished = await backend.workspaceFiles.stream(root, 'echo "$GREETING"; exit 3', { GREETING: "it's here" }, data => output.push(data.toString()), new AbortController().signal);
  assert.deepEqual([finished, output.join('')], [3, "it's here\n"]);

  const controller = new AbortController(), seen: string[] = [];
  const running = backend.workspaceFiles.stream(root, 'sleep 30 & echo $! > child.pid; echo started; wait', {}, data => seen.push(data.toString()), controller.signal);
  for (const deadline = Date.now() + 10_000; !seen.join('').includes('started') && Date.now() < deadline;) await new Promise(resolve => setTimeout(resolve, 20));
  controller.abort();
  assert.equal(await running, null);
  const child = Number(await readFile(join(root, 'child.pid'), 'utf8'));
  for (const deadline = Date.now() + 5000; Date.now() < deadline; await new Promise(resolve => setTimeout(resolve, 50))) {
    try { process.kill(child, 0); } catch { return; }
  }
  assert.fail('the command\'s child process kept running');
});

test('this computer\'s shell reports exit codes and stops the whole command', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-worktree-local-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const machine = new LocalMachine(), output: string[] = [];
  assert.equal(await machine.shell(root, 'echo "$NAME"; echo oops >&2; exit 4', { NAME: 'value' }, text => output.push(text), new AbortController().signal), 4);
  assert.equal(output.join(''), 'value\noops\n');
  const controller = new AbortController();
  const running = machine.shell(root, 'sleep 30', {}, () => {}, controller.signal);
  setTimeout(() => controller.abort(), 100);
  assert.equal(await running, null);
  const [missing] = await machine.git(join(root, 'nowhere'), [{ argv: ['status'] }]).catch(error => [error]);
  assert.match(String(missing.message), /No such file or directory/);
});
