import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { FixCommand, type LiveAgent } from '../src/command.js';
import { defaultSettings, type Route, type Task } from '../src/domain.js';
import { parseFix } from '../src/fixline.js';
import { parseRow } from '../src/shared.js';
import { LocalFiles, Store } from '../src/store.js';
import type { ProjectDetail } from '../src/workplaces.js';

const route = (name: string, project: string, defaultBranch = 'main'): Route => ({ id: name, name, project, defaultBranch, tests: [], packageGlobs: [], sharedPaths: [], buildScripts: [], preview: '', pushRemote: 'origin', accept: 'merge' });
const agent = (id: string, turns = 1): LiveAgent & { appended: string[] } => {
  const appended: string[] = [];
  return { id, appended, phase: { kind: 'idle', lastTurn: turns }, session: { append: type => { appended.push(type); }, deriveMessages: () => [] } };
};
const picture = (name: string) => ({ type: 'image', attachment: { attachmentId: name } });

async function setup(t: TestContext, routes: Route[] = [route('Web', '/ws/web'), route('rooh web', '/anchor/code/web', '')]) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-autofix-cmd-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = new Store(new LocalFiles(home));
  await store.open();
  store.settings = { ...defaultSettings(), routes };
  const folders: Record<string, string> = {}, details: Record<string, Partial<ProjectDetail>> = {};
  const created: unknown[] = [], started: [string, readonly unknown[]][] = [], sentBack: unknown[][] = [];
  let clock = 1000;
  const command = new FixCommand({
    store, now: () => clock,
    folder: live => folders[live.id],
    async inspect(project) { const detail = details[project]; if (!detail) throw new Error('not a workspace'); return { name: 'x', defaultBase: null, branches: [], setup: [], ...detail }; },
    async createManual(input) { created.push(input); return { key: `manual:${created.length}` }; },
    tasks: {
      async start(key, pictures = []) {
        started.push([key, pictures]);
        const task = { key, item: { source: 'manual', id: key.slice(7), ref: `M${key.slice(7)}`, title: 'typed', body: '', labels: [] }, routeId: 'Web', baseBranch: 'main', status: 'preparing', attempts: 0, startedAt: 1, updatedAt: 1, events: [] } as Task;
        store.tasks[key] = task;
        return task;
      },
      async sendBack(key, feedback, pictures, kept) { sentBack.push([key, feedback, pictures, kept]); return store.tasks[key]; },
    },
  });
  const run = async (live: LiveAgent, rawInput: string, attachments: { type: string; attachment?: unknown }[] = []) => {
    const result = await command.handle({ agent: live, rawInput, attachments });
    return { kind: result.kind, ...parseRow(result.text) };
  };
  return { store, command, folders, details, created, started, sentBack, run, tick: (ms: number) => { clock += ms; } };
}

test('what follows /fix: where the bug goes if said, then the bug, whose first line is its title', () => {
  assert.deepEqual(parseFix('  活动页在 iOS 上白屏 '), { title: '活动页在 iOS 上白屏', body: '' });
  assert.deepEqual(parseFix('branch=release/2 repo="rooh web" 登录按钮点了没反应\n\n复现：打开首页，点登录'), { repo: 'rooh web', branch: 'release/2', title: '登录按钮点了没反应', body: '登录按钮点了没反应\n\n复现：打开首页，点登录' });
  assert.deepEqual(parseFix('仓库：Web 分支=dev white screen'), { repo: 'Web', branch: 'dev', title: 'white screen', body: '' });
  assert.deepEqual(parseFix('the word repo=x later is text'), { title: 'the word repo=x later is text', body: '' });
  const long = parseFix('字'.repeat(200));
  assert.deepEqual([[...long.title].length, long.body.length], [121, 200], 'a long line is cut for the title and kept whole as the description');
  assert.deepEqual(parseFix(''), { title: '', body: '' });
});

test('a bug typed in a conversation goes to the repository that conversation works in, with the pictures sent along', async t => {
  const host = await setup(t), chat = agent('chat-1', 0);
  host.folders['chat-1'] = '/ws/web';
  const reply = await host.run(chat, '活动页白屏\n只在 iOS 上', [picture('a'), picture('b')]);
  assert.deepEqual([reply.kind, reply.words, reply.meta], ['success', 'M1 · typed', { key: 'manual:1' }]);
  assert.deepEqual(host.created, [{ title: '活动页白屏', body: '活动页白屏\n只在 iOS 上', attached: 2, assignment: { routeId: 'Web', branch: 'main' } }]);
  assert.deepEqual(host.started, [['manual:1', [{ attachmentId: 'a' }, { attachmentId: 'b' }]]], 'DSH already keeps the pictures: they go as they are');
  assert.deepEqual(chat.appended, ['turn/start', 'turn/end'], 'a blank session becomes a conversation, or DSH would hand it out again');
  assert.equal(host.command.lastCommand(15_000), 'chat-1');
  host.tick(20_000);
  assert.equal(host.command.lastCommand(15_000), undefined);

  const refusedFile = await host.run(chat, 'x', [{ type: 'file' }]);
  assert.deepEqual([refusedFile.kind, refusedFile.meta?.said?.key], ['error', 'Only pictures can be sent along with /fix']);
  const empty = await host.run(chat, '   ');
  assert.equal(empty.meta?.said?.key, 'Say what is wrong after /fix, and paste screenshots if they help. repo=<name> and branch=<name> may lead the line.');
  const onlyPictures = await host.run(chat, '', [picture('c')]);
  assert.deepEqual([onlyPictures.kind, (host.created.at(-1) as { title: string }).title], ['success', 'See the attached pictures']);
});

test('the repository is the one named, a worktree of a fix, or another workspace of the same repository', async t => {
  const host = await setup(t), elsewhere = agent('chat-2');
  host.folders['chat-2'] = '/somewhere/else';
  const lost = await host.run(elsewhere, 'bug');
  assert.deepEqual([lost.kind, lost.meta?.said], ['error', { key: 'This conversation is not in a repository Autofix knows. Start the line with repo=<name>. There are: {names}', values: { names: 'Web, rooh web' } }]);

  // Named: by its whole name in any case, or by an unmistakable start. Its default branch is read from the repository when the settings have none.
  host.details['/anchor/code/web'] = { defaultBase: 'master' };
  assert.equal((await host.run(elsewhere, 'repo="ROOH WEB" bug')).kind, 'success');
  assert.deepEqual((host.created.at(-1) as { assignment: unknown }).assignment, { routeId: 'rooh web', branch: 'master' });
  assert.equal((await host.run(elsewhere, 'repo=roo branch=dev bug')).kind, 'success');
  assert.deepEqual((host.created.at(-1) as { assignment: unknown }).assignment, { routeId: 'rooh web', branch: 'dev' });
  const unknown = await host.run(elsewhere, 'repo=nope bug');
  assert.deepEqual(unknown.meta?.said, { key: 'No repository is called {name}. There are: {names}', values: { name: 'nope', names: 'Web, rooh web' } });
  delete host.details['/anchor/code/web'];
  assert.equal((await host.run(elsewhere, 'repo=roo bug')).meta?.said?.key, '{route} has no default branch; choose a branch for this bug');

  // A conversation in the worktree of an earlier fix.
  host.store.tasks['manual:9'] = { key: 'manual:9', routeId: 'Web', workspacePath: '/wt/manual-9', sessionId: 'task-9', item: { ref: 'M9', title: 'old' } } as Task;
  host.folders['chat-3'] = '/wt/manual-9';
  assert.equal((await host.run(agent('chat-3'), 'another one')).kind, 'success');
  assert.equal((host.created.at(-1) as { assignment: { routeId: string } }).assignment.routeId, 'Web');

  // Another DSH workspace of the same repository on the same machine, and not the same path on another machine.
  host.details['/ws/web'] = { repository: '/srv/web', location: { kind: 'remote', hostId: 'h1', host: 'code' } };
  host.details['/ws/web-copy'] = { repository: '/srv/web', location: { kind: 'remote', hostId: 'h1', host: 'code' } };
  host.details['/ws/web-other-machine'] = { repository: '/srv/web', location: { kind: 'remote', hostId: 'h2', host: 'mini' } };
  host.folders['chat-4'] = '/ws/web-copy'; host.folders['chat-5'] = '/ws/web-other-machine';
  assert.equal((await host.run(agent('chat-4'), 'same repo')).kind, 'success');
  assert.equal((await host.run(agent('chat-5'), 'other machine')).kind, 'error');

  const single = await setup(t, [route('Web', '/ws/web')]);
  assert.deepEqual((await single.run(agent('x'), 'bug')).meta?.said, { key: 'This conversation is not in {route}. Open a conversation there, or start the line with repo={route}.', values: { route: 'Web' } });
  const none = await setup(t, []);
  assert.equal((await none.run(agent('x'), 'bug')).meta?.said?.key, 'Nothing can take this bug yet. Add the repository in Settings → Autofix here; or, if another DSH should run the fix, add it there and switch on taking bugs from other DSHes.');
});

test('in a task\'s own conversation /fix sends the fix back, and the task\'s cards are numbered', async t => {
  const host = await setup(t), own = agent('task-1');
  host.store.tasks['manual:1'] = { key: 'manual:1', routeId: 'Web', sessionId: 'task-1', status: 'review', cards: 2, item: { ref: 'M1', title: '白屏' } } as Task;
  const back = await host.run(own, '还是白屏，看截图', [picture('shot')]);
  assert.deepEqual([back.kind, back.meta], ['success', { said: { key: 'Sent back with {count} pictures: {note}', values: { count: '1', note: '还是白屏，看截图' } } }]);
  assert.deepEqual(host.sentBack, [['manual:1', '还是白屏，看截图', [], [{ attachmentId: 'shot' }]]]);
  assert.deepEqual(host.created, [], 'nothing new is filed from there');
  assert.equal((await host.run(own, 'repo=Web another bug')).meta?.said?.key, 'This conversation belongs to {ref}: what you type after /fix here is sent back to its models. File another bug from a conversation of the project.');
  assert.deepEqual((await host.run(own, '')).meta, { key: 'manual:1' }, 'a bare /fix shows the task');

  // The plugin's own line puts a numbered card into the conversation; nobody can type it.
  const line = host.command.cardLine('manual:1', 2);
  assert.match(line, /^\/fix ⁣[0-9a-f-]{36}:2:manual:1$/u);
  const card = await host.run(own, line.slice('/fix '.length));
  assert.deepEqual([card.kind, card.words, card.meta], ['success', 'M1 · 白屏', { key: 'manual:1', card: 2, home: true }]);
  assert.equal(host.sentBack.length, 1, 'a card is not feedback');
  assert.equal((await host.run(own, line.slice('/fix '.length).replace('manual:1', 'manual:404'))).kind, 'error');
});

test('a conversation in a repository another DSH fixes hands the bug over, and its card follows that DSH', async t => {
  const host = await setup(t, []), handed: unknown[][] = [];
  const command = new FixCommand({
    store: host.store, folder: live => live.id === 'air-chat' ? '/air/web' : '/air/elsewhere',
    inspect: async () => { throw new Error('not used'); }, createManual: async () => { throw new Error('this DSH files nothing itself'); },
    tasks: { start: async () => { throw new Error('this DSH runs nothing itself'); }, sendBack: async () => { throw new Error('not used'); } },
    async handOver(folder, line, pictures) { handed.push([folder, line, pictures]); return folder === '/air/web' ? { key: 'manual:7', ref: 'M7', title: line.title } : undefined; },
  });
  const run = async (id: string, rawInput: string, attachments: { type: string; attachment?: unknown }[] = []) => { const result = await command.handle({ agent: agent(id), rawInput, attachments }); return { kind: result.kind, ...parseRow(result.text) }; };
  const reply = await run('air-chat', 'branch=dev 活动页白屏', [picture('a')]);
  assert.deepEqual([reply.kind, reply.words, reply.meta], ['success', 'M7 · 活动页白屏', { key: 'manual:7', at: '/air/web' }]);
  assert.deepEqual(handed[0], ['/air/web', { branch: 'dev', title: '活动页白屏', body: '' }, [{ attachmentId: 'a' }]]);
  const nowhere = await run('other-chat', 'bug');
  assert.deepEqual([nowhere.kind, nowhere.meta?.said?.key?.slice(0, 29)], ['error', 'Nothing can take this bug yet']);
});
