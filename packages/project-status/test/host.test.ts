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

const change = (sessionId: string, input: Record<string, unknown>, language = 'zh') => post({ action: 'change', sessionId, change: input, language });
const pay = { title: '支付页' };

test('a change made from one checkout is read from another, in a private file', async () => {
  const first = await change('main', { op: 'aim', value: '今年上线\n', was: '' });
  assert.equal(first.status, 200);
  const file = first.body.file!;
  assert.equal((await change('main', { op: 'add', title: ' 支付页 ' })).status, 200);
  assert.equal((await change('tree', { op: 'part', goal: pay, part: 'steps', value: '- [x] 设计\n- [ ] 开发', was: '' })).status, 200);
  assert.equal((await change('tree', { op: 'part', goal: pay, part: 'blockers', value: '\n等我确认文案\r\n\n', was: '' })).status, 200);
  assert.equal((await change('main', { op: 'add', title: '图标' })).status, 200);
  assert.equal((await change('main', { op: 'part', goal: { title: '图标' }, part: 'next', value: '跑通回归', was: '' })).status, 200);
  assert.equal(await readFile(file, 'utf8'), '# My Shop\n\n## 大目标\n\n今年上线\n\n## 小目标\n\n### [ ] 支付页\n\n- [x] 设计\n- [ ] 开发\n\n#### 卡点\n\n等我确认文案\n\n### [ ] 图标\n\n#### 下一步\n\n跑通回归\n');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(join(state, 'projects'))).mode & 0o777, 0o700);
  const seen = await post({ action: 'get', sessionId: 'tree' });
  assert.deepEqual([seen.body.aim, seen.body.goals, typeof seen.body.updatedAt], ['今年上线', [{ title: '支付页', done: false, steps: '- [x] 设计\n- [ ] 开发', progress: '', blockers: '等我确认文案', next: '' }, { title: '图标', done: false, steps: '', progress: '', blockers: '', next: '跑通回归' }], 'number']);
});

test('an agent’s edit shows at the next read; a change over a text it wrote is refused, one to another goal is not', async () => {
  const before = await service.get('main');
  await writeFile(before.file!, `${await readFile(before.file!, 'utf8')}\n## Notes\n\nfrom the agent\n`.replace('跑通回归', '发布 1.0.16'));
  const now = await service.get('tree');
  assert.deepEqual([now.goals[1].next, now.more, now.revision !== before.revision], ['发布 1.0.16', true, true]);
  const stale = await change('main', { op: 'part', goal: { title: '图标' }, part: 'next', value: 'mine', was: '跑通回归' });
  assert.deepEqual([stale.status, stale.body.error], [409, 'The status changed while you were editing']);
  assert.match(await readFile(before.file!, 'utf8'), /发布 1\.0\.16/);
  // The other goal is as it was when the edit began, whatever happened to the rest of the file; the agent's own section stays.
  assert.equal((await change('main', { op: 'part', goal: pay, part: 'progress', value: 'mine', was: '' }, 'en')).status, 200);
  assert.match(await readFile(before.file!, 'utf8'), /### \[ \] 支付页\n\n- \[x\] 设计\n- \[ \] 开发\n\n#### 进度\n\nmine\n\n#### 卡点\n[\s\S]*#### 下一步\n\n发布 1\.0\.16\n\n## Notes\n\nfrom the agent\n$/);
  // The same change again, as after an answer that got lost, changes nothing and is no conflict.
  const text = await readFile(before.file!, 'utf8');
  assert.equal((await change('main', { op: 'part', goal: pay, part: 'progress', value: 'mine', was: '' })).status, 200);
  assert.equal((await change('main', { op: 'add', title: '图标' })).status, 200);
  assert.equal(await readFile(before.file!, 'utf8'), text);
});

test('a goal is ticked, renamed and removed by its name', async () => {
  const done = await change('main', { op: 'done', goal: { title: '图标' }, value: true });
  assert.deepEqual(done.body.goals.map(goal => [goal.title, goal.done]), [['支付页', false], ['图标', true]]);
  const renamed = await change('main', { op: 'title', goal: pay, value: '### [x] 支付页面\n' });
  assert.deepEqual(renamed.body.goals.map(goal => goal.title), ['支付页面', '图标']);
  assert.match(await readFile(renamed.body.file!, 'utf8'), /### \[ \] 支付页面\n[\s\S]*### \[x\] 图标\n/);
  // Under its old name it is gone: someone else renamed it, as far as this change knows.
  assert.equal((await change('main', { op: 'done', goal: pay, value: true })).status, 409);
  // Two of a name are told apart by their order.
  await change('main', { op: 'title', goal: { title: '图标' }, value: '支付页面' });
  assert.deepEqual((await change('main', { op: 'remove', goal: { title: '支付页面', nth: 1 } })).body.goals.map(goal => [goal.title, goal.done]), [['支付页面', false]]);
  // Removing what is gone already is done.
  assert.equal((await change('main', { op: 'remove', goal: { title: '图标' } })).status, 200);
  await change('main', { op: 'title', goal: { title: '支付页面' }, value: '支付页' });
});

test('a line that would start a section of its own is not saved into a text', async () => {
  const refused = await change('main', { op: 'part', goal: pay, part: 'next', value: 'first this\n#### Later\nmore', was: '' });
  assert.deepEqual([refused.status, refused.body.error], [400, 'A line that starts with # would begin another section']);
  assert.equal((await change('main', { op: 'aim', value: '今年上线\n## 其他', was: '今年上线' })).status, 400);
  // Inside a code block it is code.
  assert.equal((await change('main', { op: 'part', goal: pay, part: 'next', value: '```\n## not a heading\n```', was: '' })).status, 200);
  assert.equal((await change('main', { op: 'part', goal: pay, part: 'next', value: '', was: '```\n## not a heading\n```' })).status, 200);
});

test('conversations are counted across the project’s checkouts, without blank ones and helpers', async () => {
  rows.push({ sessionId: 'a', cwd: repo, updatedAt: 5000 }, { sessionId: 'b', cwd: tree, updatedAt: '1970-01-01T00:00:09.000Z' }, { sessionId: 'c', cwd: join(repo, 'src'), updatedAt: 7000 },
    { sessionId: 'd', cwd: plain, updatedAt: 99_000 }, { sessionId: 'e', cwd: repo, blank: true, updatedAt: 99_000 }, { sessionId: 'f', cwd: repo, parentSessionId: 'a', updatedAt: 99_000 }, { sessionId: 'g', cwd: `${repo}-other`, updatedAt: 99_000 });
  assert.deepEqual((await service.get('main')).conversations, { count: 3, lastActive: 9000 });
  assert.deepEqual((await service.get('plain')).conversations, { count: 1, lastActive: 99_000 });
});

test('other plugins can list the projects and read one by folder', async () => {
  const listed = await service.list();
  assert.deepEqual(listed.map(entry => [entry.project.name, entry.aim, entry.goals.length]).sort(), [['My Shop', '今年上线', 1], ['lone', '', 0], ['notes', '', 0]]);
  assert.deepEqual((await service.forFolder(tree)).goals[0].progress, 'mine');
});

test('requests without the client’s header, of another kind, or with a bad status are refused', async () => {
  assert.equal((await post({ action: 'get', sessionId: 'main' }, {})).status, 403);
  assert.equal((await post({ action: 'get', sessionId: 'gone' })).status, 404);
  assert.equal((await post({ action: 'drop', sessionId: 'main' })).status, 400);
  for (const bad of [{ op: 'part', goal: pay, part: 'title', value: 'x', was: '' }, { op: 'part', goal: pay, part: 'next', value: 'x' }, { op: 'aim', value: 'x'.repeat(8001), was: '' }, { op: 'add', title: ' ' }, { op: 'done', goal: pay, value: 'yes' },
    { op: 'remove', goal: { title: '支付页', nth: -1 } }, { op: 'drop' }, 'x']) assert.equal((await post({ action: 'change', sessionId: 'main', change: bad })).status, 400, JSON.stringify(bad));
  assert.equal((await handle(new Request('http://localhost/api/project-status', { method: 'POST', headers: { [CLIENT_HEADER]: '1', 'content-type': 'text/plain' }, body: 'x' }))).status, 415);
});
