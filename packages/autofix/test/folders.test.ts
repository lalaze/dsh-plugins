import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Failure } from '../src/domain.js';
import { Folders } from '../src/folders.js';
import { createHandler } from '../src/http.js';
import { ManualSource } from '../src/manual.js';
import { AutofixService, Sources } from '../src/service.js';
import { LocalFiles, Store } from '../src/store.js';
import { Tasks } from '../src/tasks.js';

const git = (folder: string, ...args: string[]) => execFileSync('git', ['-C', folder, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { stdio: 'pipe' }).toString().trim();
async function rig(t: TestContext) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-autofix-folders-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  const repo = join(home, 'repo');
  await mkdir(join(repo, 'packages', 'web'), { recursive: true });
  git(home, 'init', '-q', '-b', 'main', repo);
  await writeFile(join(repo, 'packages', 'web', 'a.txt'), 'a');
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'first');
  const opened: string[] = [];
  const folders = new Folders(name => name === 'workspaceController' ? { create: async ({ path }: { path: string }) => { opened.push(path); return {}; } } : undefined);
  return { home, repo, opened, folders };
}
const key = (error: unknown) => error instanceof Failure && error.said.key;

test('a typed folder becomes a workspace of its repository, and what is not a repository is refused in words', async t => {
  const { home, repo, opened, folders } = await rig(t);
  const added = await folders.add(`  "${join(repo, 'packages', 'web')}/" `);
  assert.deepEqual([added.folder, added.repository, added.remotes], [repo, join(repo, '.git'), []], 'a folder inside the repository stands for the repository');
  assert.deepEqual(opened, [repo]);
  git(repo, 'remote', 'add', 'origin', 'https://example.invalid/x.git');
  assert.deepEqual((await folders.add(repo)).remotes, ['origin']);

  const worktree = join(home, 'wt');
  git(repo, 'worktree', 'add', '-q', '-b', 'fix', worktree);
  assert.equal(await folders.repository(worktree), join(repo, '.git'), 'a worktree is the same repository');

  await mkdir(join(home, 'plain'));
  const before = opened.length;
  for (const [typed, said] of [['', "Write the folder's full path, such as /Users/you/code/project"], ['code/project', "Write the folder's full path, such as /Users/you/code/project"],
    [join(home, 'missing'), '{folder} is not a folder on the computer DSH runs on'], [join(repo, 'packages', 'web', 'a.txt'), '{folder} is not a folder on the computer DSH runs on'],
    [join(home, 'plain'), '{folder} is not a Git repository']] as const) {
    assert.equal(await folders.add(typed).then(() => 'added', key), said, typed);
  }
  assert.equal(opened.length, before, 'nothing refused was opened');
});

test('the settings page gets the project to choose: the folder, or the workspace DSH already has for that repository', async t => {
  const { home, repo, folders } = await rig(t);
  const worktree = join(home, 'wt');
  git(repo, 'worktree', 'add', '-q', '-b', 'fix', worktree);
  const store = new Store(new LocalFiles(join(home, 'state')));
  await store.open();
  const never = async () => { throw new Error('not used'); };
  const sources = new Sources(), listed = [{ path: '/elsewhere', title: 'other', location: { kind: 'remote' as const, hostId: 'h', host: 'code' }, folder: repo }];
  const local = (path: string) => ({ path, title: path.split('/').at(-1)!, location: { kind: 'local' as const }, folder: path });
  const tasks = new Tasks({ store, source: id => sources.get(id), workplaces: { create: never, machine: never }, conversations: { open: never, flow: never, picture: never } });
  const service = new AutofixService({ store, tasks, sources, manual: new ManualSource(join(home, 'manual')), folders, workplaces: { projects: async () => listed, inspect: never, machine: never } });
  const handler = createHandler(service, tasks);
  const post = async (path: unknown) => {
    const response = await handler(new Request('http://dsh/api/autofix', { method: 'POST', headers: { 'content-type': 'application/json', 'X-DSH-Autofix': '1' }, body: JSON.stringify({ action: 'addFolder', path }) }));
    return { status: response.status, body: await response.json() as Record<string, any> };
  };

  const unlisted = await post(repo);
  assert.deepEqual([unlisted.status, unlisted.body.said], [400, { key: 'DSH did not add {folder} as a workspace', values: { folder: repo } }], 'a remote workspace with the same folder name is another machine');
  listed.push(local(repo) as never);
  const direct = await post(repo);
  assert.deepEqual([direct.status, direct.body.project, direct.body.projects.length, direct.body.remotes], [200, repo, 2, []]);
  listed.splice(1, 1, local(worktree) as never);
  assert.equal((await post(repo)).body.project, worktree, 'DSH lists one workspace per repository; that one is chosen');
  const bad = await post(42);
  assert.deepEqual([bad.status, bad.body.error], [400, 'The folder is missing']);
});
