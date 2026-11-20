import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { CLIENT_HEADER, NO_REVISION, type StatusAnswer } from '../src/domain.js';
import { createHandler } from '../src/http.js';
import { ProjectStatusService, type SessionRow } from '../src/service.js';
import { StatusStore } from '../src/store.js';

let base: string, repo: string, tree: string, plain: string, state: string, upstream: string;
let service: ProjectStatusService, handle: (request: Request) => Promise<Response>, clock = 1_000_000;
const rows: SessionRow[] = [];
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } });
const cwds: Record<string, () => string> = { main: () => repo, tree: () => tree, plain: () => plain, sub: () => join(repo, 'src') };

before(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'ps-')));
  repo = join(base, 'My Shop'); tree = join(base, 'trees', 'feat-1'); plain = join(base, 'notes'); state = join(base, 'state'); upstream = join(base, 'upstream.git');
  await mkdir(join(repo, 'src'), { recursive: true }); await mkdir(plain);
  git(base, 'init', '-q', '--bare', upstream);
  git(repo, 'init', '-q', '-b', 'main');
  await writeFile(join(repo, 'a.txt'), 'a\n'); await writeFile(join(repo, 'src', 'b.txt'), 'b\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'first');
  git(repo, 'remote', 'add', 'origin', upstream); git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/1', tree);
  service = new ProjectStatusService(new StatusStore(state), { cwd: async id => cwds[id]?.(), worktrees: () => undefined, sessions: async () => rows, now: () => clock });
  handle = createHandler(service);
});
after(() => rm(base, { recursive: true, force: true }));

const post = async (body: Record<string, unknown>, headers: Record<string, string> = { [CLIENT_HEADER]: '1' }) => {
  const response = await handle(new Request('http://localhost/api/project-status', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }));
  return { status: response.status, body: await response.json() as StatusAnswer & { error?: string } };
};
/** Git is asked again only after a while; the tests move the clock past it. */
const later = () => { clock += 60_000; };

test('every checkout of a repository, and a folder inside one, is the same project', async () => {
  const [main, linked, sub] = [await service.get('main'), await service.get('tree'), await service.get('sub')];
  assert.match(main.project.id, /^My-Shop-[0-9a-f]{8}$/);
  assert.deepEqual([linked.project, sub.project], [main.project, main.project]);
  assert.deepEqual(main.project, { id: main.project.id, name: 'My Shop', root: repo, git: true });
  assert.equal(main.file, join(state, 'projects', `${main.project.id}.md`));
  assert.deepEqual([main.revision, main.updatedAt, main.more], [NO_REVISION, undefined, false]);
});

test('a folder outside Git is a project of its own, without facts', async () => {
  const answer = await service.get('plain');
  assert.deepEqual(answer.project, { id: answer.project.id, name: 'notes', root: plain, git: false });
  assert.match(answer.project.id, /^notes-[0-9a-f]{8}$/);
  assert.equal(answer.facts, undefined);
});

test('the facts are what Git says about the conversation’s folder and its repository', async () => {
  later();
  assert.deepEqual((await service.get('main')).facts && { ...(await service.get('main')).facts, lastCommit: 0 }, { branch: 'main', dirty: 0, unpushed: 0, worktrees: 1, stashes: 0, lastCommit: 0 });
  await writeFile(join(tree, 'a.txt'), 'changed\n'); git(tree, 'stash', '-q');
  await writeFile(join(tree, 'c.txt'), 'c\n'); git(tree, 'add', 'c.txt'); git(tree, 'commit', '-q', '-m', 'second');
  await writeFile(join(tree, 'new.txt'), 'n\n'); await writeFile(join(tree, 'a.txt'), 'again\n');
  later();
  const facts = (await service.get('tree')).facts!;
  assert.deepEqual({ ...facts, lastCommit: 0 }, { branch: 'feat/1', dirty: 2, unpushed: 1, worktrees: 1, stashes: 1, lastCommit: 0 });
  assert.ok(Math.abs(facts.lastCommit! - Date.now()) < 120_000);
  // The main checkout has its own branch and changes; stashes and worktrees are the repository's.
  assert.deepEqual({ ...(await service.get('main')).facts, lastCommit: 0 }, { branch: 'main', dirty: 0, unpushed: 0, worktrees: 1, stashes: 1, lastCommit: 0 });
});

test('a repository with no remote has nothing to push to', async () => {
  const lone = join(base, 'lone');
  await mkdir(lone); git(lone, 'init', '-q', '-b', 'main'); await writeFile(join(lone, 'x'), 'x'); git(lone, 'add', '.'); git(lone, 'commit', '-q', '-m', 'x');
  cwds.lone = () => lone;
  assert.equal((await service.get('lone')).facts!.unpushed, null);
});

test('a status saved from one checkout is read from another, in a private file', async () => {
  const first = await post({ action: 'save', sessionId: 'main', fields: { goal: '上线支付页', progress: '', blockers: '等我确认文案', next: '跑通回归' }, revision: NO_REVISION, language: 'zh' });
  assert.equal(first.status, 200);
  const file = first.body.file!;
  assert.equal(await readFile(file, 'utf8'), '# My Shop\n\n## 目标\n\n上线支付页\n\n## 进度\n\n## 卡点\n\n等我确认文案\n\n## 下一步\n\n跑通回归\n');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(join(state, 'projects'))).mode & 0o777, 0o700);
  const seen = await post({ action: 'get', sessionId: 'tree' });
  assert.deepEqual([seen.body.fields.blockers, seen.body.revision, typeof seen.body.updatedAt], ['等我确认文案', first.body.revision, 'number']);
});

test('an agent’s edit of the file shows at the next read, and a save made from the old text is refused', async () => {
  const before = await service.get('main');
  await writeFile(before.file!, `${await readFile(before.file!, 'utf8')}\n## Notes\n\nfrom the agent\n`.replace('跑通回归', '发布 1.0.16'));
  const now = await service.get('tree');
  assert.deepEqual([now.fields.next, now.more, now.revision !== before.revision], ['发布 1.0.16', true, true]);
  const stale = await post({ action: 'save', sessionId: 'main', fields: { ...before.fields, goal: 'mine' }, revision: before.revision, language: 'zh' });
  assert.deepEqual([stale.status, stale.body.error], [409, 'The status changed while you were editing']);
  assert.match(await readFile(before.file!, 'utf8'), /上线支付页/);
  // From the new revision the save goes through and the agent's own section stays.
  const saved = await post({ action: 'save', sessionId: 'main', fields: { ...now.fields, goal: 'mine' }, revision: now.revision, language: 'en' });
  assert.equal(saved.status, 200);
  assert.match(await readFile(before.file!, 'utf8'), /^# My Shop\n\n## 目标\n\nmine\n[\s\S]*## Notes\n\nfrom the agent\n$/);
});

test('conversations are counted across the project’s checkouts, without blank ones and helpers', async () => {
  rows.push({ sessionId: 'a', cwd: repo, updatedAt: 5000 }, { sessionId: 'b', cwd: tree, updatedAt: '1970-01-01T00:00:09.000Z' }, { sessionId: 'c', cwd: join(repo, 'src'), updatedAt: 7000 },
    { sessionId: 'd', cwd: plain, updatedAt: 99_000 }, { sessionId: 'e', cwd: repo, blank: true, updatedAt: 99_000 }, { sessionId: 'f', cwd: repo, parentSessionId: 'a', updatedAt: 99_000 }, { sessionId: 'g', cwd: `${repo}-other`, updatedAt: 99_000 });
  assert.deepEqual((await service.get('main')).conversations, { count: 3, lastActive: 9000 });
  assert.deepEqual((await service.get('plain')).conversations, { count: 1, lastActive: 99_000 });
});

test('other plugins can list the projects and read one by folder', async () => {
  const listed = await service.list();
  assert.deepEqual(listed.map(entry => [entry.project.name, entry.fields.goal]).sort(), [['My Shop', 'mine'], ['lone', ''], ['notes', '']]);
  assert.deepEqual((await service.forFolder(tree)).fields.goal, 'mine');
});

test('requests without the client’s header, of another kind, or with a bad status are refused', async () => {
  assert.equal((await post({ action: 'get', sessionId: 'main' }, {})).status, 403);
  assert.equal((await post({ action: 'get', sessionId: 'gone' })).status, 404);
  assert.equal((await post({ action: 'drop', sessionId: 'main' })).status, 400);
  assert.equal((await post({ action: 'save', sessionId: 'main', fields: { goal: 'x' }, revision: 'r', language: 'en' })).status, 400);
  assert.equal((await handle(new Request('http://localhost/api/project-status', { method: 'POST', headers: { [CLIENT_HEADER]: '1', 'content-type': 'text/plain' }, body: 'x' }))).status, 415);
});
