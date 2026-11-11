import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { promisify } from 'node:util';
import type { FlowInput, FlowResult, FlowRun } from '../src/conversations.js';
import { defaultSettings, render, type Item, type ItemEvent, type Message, type Route } from '../src/domain.js';
const said = (message: Message | undefined) => message ? render(message) : undefined;
import { refresh } from '../src/pool.js';
import { LocalFiles, Store } from '../src/store.js';
import { Tasks } from '../src/tasks.js';
import type { GitStep, Machine } from '../src/workplaces.js';

const exec = promisify(execFile);
const IDENTITY = { GIT_AUTHOR_NAME: 'rig', GIT_AUTHOR_EMAIL: 'rig@example.invalid', GIT_COMMITTER_NAME: 'rig', GIT_COMMITTER_EMAIL: 'rig@example.invalid' };
async function git(cwd: string, ...argv: string[]): Promise<string> {
  return (await exec('git', argv, { cwd, env: { ...process.env, ...IDENTITY } })).stdout.trim();
}
/** A workspace folder on this computer, as dsh-remote-agents gives one. */
function machine(folder: string): Machine {
  return {
    location: { kind: 'local' }, folder,
    async git(steps: GitStep[]) {
      const results = [];
      for (const step of steps) {
        results.push(await new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve => {
          execFile('git', step.argv, { cwd: folder, env: { ...process.env, ...IDENTITY }, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr }));
        }));
      }
      return results;
    },
    shell: (command, env, output, signal) => new Promise(resolve => {
      const child = spawn('/bin/sh', ['-c', command], { cwd: folder, env: { ...process.env, ...env }, signal });
      child.stdout.on('data', data => output(String(data))); child.stderr.on('data', data => output(String(data)));
      child.on('error', () => resolve(null)); child.on('close', code => resolve(code));
    }),
    async read(file) { try { return await readFile(join(folder, file), 'utf8'); } catch { return undefined; } },
  };
}
const bug = (id: string, title: string, labels: string[] = []): Item => ({ source: 'tapd', id: `100/${id}`, ref: id, title, body: '加法算错了', url: `https://tapd.example/${id}`, project: { id: '100', name: 'Dana' }, labels, images: 3 });

interface Options { route?: Partial<Route>; reportFails?: boolean; retries?: number; noSource?: boolean; blind?: boolean; cardFails?: boolean }
async function setup(t: TestContext, options: Options = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-tapd-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const origin = join(root, 'origin.git'), project = join(root, 'project');
  await git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  await git(root, 'clone', '-q', origin, project);
  await mkdir(join(project, 'packages', 'act'), { recursive: true });
  await mkdir(join(project, 'packages', 'pay'), { recursive: true });
  await writeFile(join(project, 'packages', 'act', 'math.js'), 'export const add = (a, b) => a - b;\n');
  await writeFile(join(project, 'packages', 'act', 'package.json'), '{ "scripts": { "build": "node -e \\"process.exit(require(\'fs\').readFileSync(\'math.js\',\'utf8\').includes(\'a + b\') ? 0 : 3)\\"" } }\n');
  await writeFile(join(project, 'packages', 'pay', 'package.json'), '{ "scripts": {} }\n');
  await writeFile(join(project, 'README.md'), 'repo\n');
  await git(project, 'add', '-A'); await git(project, 'commit', '-q', '-m', 'init'); await git(project, 'push', '-q', 'origin', 'main');

  const store = new Store(new LocalFiles(join(root, 'state')));
  await store.open();
  const route: Route = { id: 'web', name: 'Web', project, defaultBranch: 'main', tests: ['cd {package} && npm run -s {script}'], packageGlobs: ['packages/*'], sharedPaths: [], buildScripts: ['build'], preview: '', pushRemote: 'origin', accept: 'merge', ...options.route };
  store.settings = { ...defaultSettings(), routes: [route], run: { ...defaultSettings().run, checkRetries: options.retries ?? 1 } };
  ({ pool: store.pool } = refresh({}, 'tapd', [bug('1', '【活动页】加法算错'), bug('2', '支付 安全问题', ['Security'])], 1));
  store.pool['tapd:100/1'].assignment = { routeId: 'web', branch: 'main' };
  store.pool['tapd:100/2'].assignment = { routeId: 'web', branch: 'main' };

  const told: ItemEvent[] = [], goals: string[] = [], opened: unknown[] = [];
  /** The cards put into the task's conversation: its number and what the task said then. */
  const cards: [number | undefined, string][] = [];
  const flows: FlowInput[] = [], discarded: string[] = [];
  const source = { id: 'tapd', name: 'TAPD',
    async image(_item: Item, index: number) { if (index === 1) throw new Error('gone'); return { data: new Uint8Array([index]), mediaType: 'image/png', name: `p${index}.png` }; },
    async discard(item: Item) { discarded.push(item.id); },
    async report(_item: Item, event: ItemEvent) { if (options.reportFails && event.kind === 'accepted') throw new Error('TAPD is down'); told.push(event); } };
  /** What the models do in each flow, in order; the last one repeats. */
  const edits: ((worktree: string) => Promise<FlowResult['end'] | void>)[] = [];
  let worktree = '', flowing: { stop(): void } | undefined;
  const tasks = new Tasks({
    store,
    async announce(task) { cards.push([task.cards, task.status]); if (options.cardFails) throw new Error('conversation closed'); },
    source: id => options.noSource || id !== 'tapd' ? undefined : source,
    workplaces: {
      async create({ project: source, base, branch }) {
        worktree = join(root, 'worktrees', branch.replace(/\//gu, '-'));
        await git(source, 'worktree', 'add', '-q', '--no-track', '-b', branch, worktree, `refs/remotes/origin/${base}`);
        return { path: worktree, worktree, branch, warnings: [] };
      },
      async machine(path) { return machine(path); },
    },
    conversations: {
      async open(input) { opened.push(input); return { workspaceId: 'w', sessionId: 's1' }; },
      async picture(image) { return { attachmentId: `sha256:${image.data[0]}`, name: image.name }; },
      async flow(_sessionId: string, input: FlowInput): Promise<FlowRun> {
        if (options.blind && input.attachments?.length) throw Object.assign(new Error('Review model X does not support images.'), { code: 'flow/images-unsupported' });
        goals.push(input.goal); flows.push(input);
        const edit = edits[Math.min(goals.length, edits.length) - 1];
        let stop!: () => void;
        const stopped = new Promise<FlowResult>(resolve => { stop = () => resolve({ end: { kind: 'stopped', ms: 1 }, steps: [] }); });
        flowing = { stop };
        const done = (async (): Promise<FlowResult> => {
          const end = await edit(worktree) ?? { kind: 'passed' as const, round: 1, sentBack: 0, ms: 5 };
          return { end, report: 'fixed', steps: [{ role: 'implement', round: 1, model: 'coder', status: 'done', body: 'x'.repeat(5000) }] };
        })();
        return { done: Promise.race([done, stopped]), stop };
      },
    },
  });
  const fix = async (dir: string) => { await writeFile(join(dir, 'packages', 'act', 'math.js'), 'export const add = (a, b) => a + b;\n'); };
  return { root, origin, project, store, tasks, told, goals, flows, discarded, opened, edits, fix, cards, worktree: () => worktree, stopFlow: () => flowing?.stop() };
}

test('a bug goes from the pool to a local commit, and reaches the remote only when accepted', async t => {
  const host = await setup(t);
  host.edits.push(host.fix);
  await host.tasks.start('tapd:100/1');
  await host.tasks.idle('tapd:100/1');
  const task = host.store.tasks['tapd:100/1'];
  assert.equal(task.status, 'review', said(task.error));
  assert.equal(task.branch, 'tapd/100/1');
  assert.deepEqual(host.opened, [{ path: host.worktree(), title: '1 【活动页】加法算错', permission: 'workspace-write' }]);
  assert.match(host.goals[0], /reported in TAPD, in the repository Web[\s\S]*Bug 1: 【活动页】加法算错\nhttps:\/\/tapd\.example\/1\nProject: Dana[\s\S]*加法算错了[\s\S]*attachment 1 is \[image 1\], attachment 2 is \[image 3\][\s\S]*could not be loaded: \[image 2\][\s\S]*Do not run git commit[\s\S]*Do not write to TAPD/);
  assert.deepEqual(host.flows[0].attachments, [{ type: 'image', attachment: { attachmentId: 'sha256:0', name: 'p0.png' } }, { type: 'image', attachment: { attachmentId: 'sha256:2', name: 'p2.png' } }], 'the pictures that could be loaded, in order');
  assert.ok(task.events.some(event => event.said.key === '{missing} of the bug\'s {count} pictures could not be loaded'));
  assert.deepEqual(task.check?.packages, ['packages/act']);
  assert.deepEqual(task.check?.runs.map(run => [run.command, run.code]), [["cd 'packages/act' && npm run -s 'build'", 0]]);
  assert.equal(task.flow?.steps[0].body?.length, 4001, 'a long step result is cut for storage');
  assert.equal(await git(host.worktree(), 'log', '-1', '--format=%s'), 'fix(tapd): 1 【活动页】加法算错');
  assert.equal(await git(host.worktree(), 'status', '--porcelain'), '');
  assert.equal(await git(host.origin, 'log', '--format=%s', 'main'), 'init', 'nothing is pushed before a person accepts');
  assert.deepEqual(host.told, [{ kind: 'started', baseBranch: 'main' }, { kind: 'review', branch: 'tapd/100/1', commit: task.commit, checks: 1 }]);

  await host.tasks.accept('tapd:100/1');
  await host.tasks.idle('tapd:100/1');
  assert.equal(task.status, 'done', said(task.error));
  assert.deepEqual((await git(host.origin, 'log', '--topo-order', '--format=%s', 'main')).split('\n'), ['merge tapd fix 100/1: 【活动页】加法算错', 'fix(tapd): 1 【活动页】加法算错', 'init']);
  assert.equal(await git(host.origin, 'rev-parse', 'main'), task.mergeCommit);
  assert.equal(await git(host.worktree(), 'rev-parse', '--abbrev-ref', 'HEAD'), 'tapd/100/1', 'the worktree stays on its branch');
  assert.deepEqual(host.told[2], { kind: 'accepted', baseBranch: 'main', branch: 'tapd/100/1', commit: task.commit, mergeCommit: task.mergeCommit });
  assert.deepEqual(host.store.memory, { 'prefix:tapd:【活动页】': { routeId: 'web', branch: 'main', package: 'packages/act' }, 'project:tapd:100': { routeId: 'web', branch: 'main' } });
  assert.equal(host.store.pool['tapd:100/1'], undefined, 'a fixed bug leaves the pool');
  assert.deepEqual(host.discarded, ['100/1'], 'and its source may forget what it kept for it');
  // What is on disk is what a restart finds.
  const reopened = new Store(new LocalFiles(join(host.root, 'state')));
  await reopened.open();
  assert.equal(reopened.tasks['tapd:100/1'].status, 'done');
});

test('a failed check goes back to the models with its output, then fails the task when retries run out', async t => {
  const host = await setup(t);
  host.edits.push(async dir => { await writeFile(join(dir, 'packages', 'act', 'math.js'), 'export const add = (a, b) => a * b;\n'); }, host.fix);
  await host.tasks.start('tapd:100/1');
  await host.tasks.idle('tapd:100/1');
  const task = host.store.tasks['tapd:100/1'];
  assert.equal(task.status, 'review', said(task.error));
  assert.equal(task.attempts, 2);
  assert.match(host.goals[1], /checks that run before it is committed failed[\s\S]*npm run -s 'build'\n\(exit code 3\)[\s\S]*Earlier rounds already changed files/);

  const strict = await setup(t, { retries: 0 });
  strict.edits.push(async dir => { await writeFile(join(dir, 'packages', 'act', 'math.js'), 'export const add = (a, b) => a * b;\n'); });
  await strict.tasks.start('tapd:100/1');
  await strict.tasks.idle('tapd:100/1');
  assert.equal(strict.store.tasks['tapd:100/1'].status, 'failed');
  assert.match(said(strict.store.tasks['tapd:100/1'].error)!, /A check failed[\s\S]*exit code 3/);
  assert.equal(await git(strict.worktree(), 'log', '-1', '--format=%s'), 'init', 'nothing is committed');
});

test('a secret, a sensitive file, a denied label or a review that did not pass never reach a commit', async t => {
  const host = await setup(t);
  await assert.rejects(host.tasks.start('tapd:100/2'), /labelled "Security" are not handed to models/);
  host.edits.push(async dir => { await host.fix(dir); await writeFile(join(dir, '.env.local'), 'A=1\n'); });
  await host.tasks.start('tapd:100/1');
  await host.tasks.idle('tapd:100/1');
  const task = host.store.tasks['tapd:100/1'];
  assert.deepEqual([task.status, said(task.error)], ['failed', 'A sensitive file was changed: .env.local']);
  assert.equal(await git(host.worktree(), 'log', '-1', '--format=%s'), 'init');
  await assert.rejects(host.tasks.accept('tapd:100/1'), /waiting for you/);

  // Sent back without a note: the same worktree and conversation go on.
  host.edits.push(async dir => { await rm(join(dir, '.env.local')); return { kind: 'rejected' as const, rounds: 3, ms: 9 }; });
  await host.tasks.sendBack('tapd:100/1', '');
  await host.tasks.idle('tapd:100/1');
  assert.equal(task.status, 'failed');
  assert.match(said(task.error)!, /did not pass after 3 rounds/);
});

test('a fix sent back is changed in the same worktree; stopping ends the flow', async t => {
  const host = await setup(t);
  host.edits.push(host.fix, async dir => { await writeFile(join(dir, 'packages', 'act', 'note.txt'), 'also this\n'); }, () => new Promise(() => {}));
  await host.tasks.start('tapd:100/1');
  await host.tasks.idle('tapd:100/1');
  await assert.rejects(host.tasks.sendBack('tapd:100/1', '  '), /Say what should change/);
  await host.tasks.sendBack('tapd:100/1', '再加一个说明文件');
  await host.tasks.idle('tapd:100/1');
  const task = host.store.tasks['tapd:100/1'];
  assert.equal(task.status, 'review', said(task.error));
  assert.match(host.goals[1], /sent it back[\s\S]*再加一个说明文件/);
  assert.equal((await git(host.worktree(), 'log', '--format=%s')).split('\n').length, 3, 'a second commit on the branch');

  await host.tasks.sendBack('tapd:100/1', '第三次');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(host.tasks.running('tapd:100/1'), true);
  await assert.rejects(host.tasks.accept('tapd:100/1'), /still running/);
  assert.equal(host.tasks.stop('tapd:100/1'), true);
  await host.tasks.idle('tapd:100/1');
  assert.equal(task.status, 'stopped');
  assert.equal(host.tasks.stop('tapd:100/1'), false);
});

test('a conflict or a TAPD failure at acceptance leaves the task where a person can finish it', async t => {
  const host = await setup(t, { reportFails: true });
  host.edits.push(host.fix);
  await host.tasks.start('tapd:100/1');
  await host.tasks.idle('tapd:100/1');
  // Someone else changes the same line on main.
  const other = join(host.root, 'other');
  await git(host.root, 'clone', '-q', host.origin, other);
  await writeFile(join(other, 'packages', 'act', 'math.js'), 'export const add = (a, b) => Number(a) + Number(b);\n');
  await git(other, 'commit', '-qam', 'their fix'); await git(other, 'push', '-q', 'origin', 'main');
  await host.tasks.accept('tapd:100/1');
  await host.tasks.idle('tapd:100/1');
  const task = host.store.tasks['tapd:100/1'];
  assert.equal(task.status, 'review');
  assert.match(said(task.error)!, /conflicts with origin\/main\.[\s\S]*packages\/act\/math\.js/);
  assert.equal(await git(host.origin, 'log', '-1', '--format=%s', 'main'), 'their fix');
  assert.equal(await git(host.worktree(), 'status', '--porcelain'), '', 'the worktree is untouched');

  // The models resolve it; this time Git succeeds and TAPD does not.
  host.edits.push(async dir => { await git(dir, 'fetch', '-q', 'origin'); await writeFile(join(dir, 'packages', 'act', 'math.js'), 'export const add = (a, b) => Number(a) + Number(b); // a + b\n'); await git(dir, 'commit', '-qam', 'wip'); await git(dir, 'merge', '-q', '-X', 'ours', 'origin/main'); await writeFile(join(dir, 'packages', 'act', 'done.txt'), 'x\n'); });
  await host.tasks.sendBack('tapd:100/1', '解决冲突');
  await host.tasks.idle('tapd:100/1');
  assert.equal(task.status, 'review', said(task.error));
  await host.tasks.accept('tapd:100/1');
  await host.tasks.idle('tapd:100/1');
  assert.equal(task.status, 'done', said(task.error));
  assert.equal(task.reportPending?.kind, 'accepted');
  assert.equal(await git(host.origin, 'rev-parse', 'main'), task.mergeCommit);
  await assert.rejects(host.tasks.retryReport('tapd:100/1'), /TAPD is down/);
});

test('a repository set to push the branch leaves the base branch alone', async t => {
  const host = await setup(t, { route: { accept: 'push-branch', tests: [] } });
  host.edits.push(host.fix);
  await host.tasks.start('tapd:100/1');
  await host.tasks.idle('tapd:100/1');
  await host.tasks.accept('tapd:100/1');
  await host.tasks.idle('tapd:100/1');
  const task = host.store.tasks['tapd:100/1'];
  assert.equal(task.status, 'done', said(task.error));
  assert.equal(await git(host.origin, 'log', '-1', '--format=%s', 'main'), 'init');
  assert.equal(await git(host.origin, 'rev-parse', 'tapd/100/1'), task.commit);
  assert.deepEqual(host.told.at(-1), { kind: 'accepted', baseBranch: 'main', branch: 'tapd/100/1', commit: task.commit });
});

test('a bug whose source is not loaded still runs; nothing is told to anyone', async t => {
  const host = await setup(t, { noSource: true, route: { tests: [] } });
  host.edits.push(host.fix);
  await host.tasks.start('tapd:100/1');
  await host.tasks.idle('tapd:100/1');
  await host.tasks.accept('tapd:100/1');
  await host.tasks.idle('tapd:100/1');
  const task = host.store.tasks['tapd:100/1'];
  assert.equal(task.status, 'done', said(task.error));
  assert.match(host.goals[0], /reported in tapd[\s\S]*prefer to keep the fix inside it[\s\S]*not by itself a reason to reject/);
  assert.equal(task.reportPending?.kind, 'accepted', 'kept for when the source is back');
  await assert.rejects(host.tasks.retryReport('tapd:100/1'), /source of this bug is not loaded/);
  assert.deepEqual(host.told, []);
});

test('when a flow model cannot see pictures the bug is still worked on, from its text', async t => {
  const host = await setup(t, { blind: true, route: { tests: [] } });
  host.edits.push(host.fix);
  await host.tasks.start('tapd:100/1');
  await host.tasks.idle('tapd:100/1');
  const task = host.store.tasks['tapd:100/1'];
  assert.equal(task.status, 'review', said(task.error));
  assert.equal(host.flows[0].attachments, undefined);
  assert.match(host.goals[0], /has 3 pictures \(\[image 1\], \[image 2\], \[image 3\]\) that could not be attached/);
  assert.ok(task.events.some(event => event.said.key === 'The pictures were left out' && /does not support images/.test(event.said.detail ?? '')));
  host.edits.push(async dir => { await writeFile(join(dir, 'packages', 'act', 'more.txt'), 'x\n'); });
  await host.tasks.sendBack('tapd:100/1', 'again');
  await host.tasks.idle('tapd:100/1');
  assert.equal(host.flows[1].attachments, undefined, 'not tried again every round');
});

test('a fix is sent back with pictures of what is still wrong; they go to that round only', async t => {
  const host = await setup(t, { route: { tests: ['test -f packages/act/ok.txt'] } });
  host.edits.push(host.fix, async dir => { await writeFile(join(dir, 'packages', 'act', 'ok.txt'), 'x\n'); }, async dir => { await writeFile(join(dir, 'packages', 'act', 'more.txt'), 'x\n'); });
  await host.tasks.start('tapd:100/1');
  await host.tasks.idle('tapd:100/1');
  const task = host.store.tasks['tapd:100/1'];
  // The first flow passed review but the check failed, so a second one repaired it.
  assert.equal(task.status, 'review', said(task.error));
  const shot = (byte: number) => ({ data: new Uint8Array([byte]), mediaType: 'image/png', name: `after${byte}.png` });
  await host.tasks.sendBack('tapd:100/1', '', [shot(7), shot(8)]);
  await host.tasks.idle('tapd:100/1');
  assert.equal(task.status, 'review', said(task.error));
  const sent = host.flows.at(-1)!;
  assert.deepEqual((sent.attachments as { attachment: { attachmentId: string } }[]).map(block => block.attachment.attachmentId), ['sha256:0', 'sha256:2', 'sha256:7', 'sha256:8'], 'the bug\'s pictures, then the person\'s');
  assert.match(sent.goal, /What they said:\n\(nothing in words: see their pictures\)\nThey added 2 pictures showing what they mean: attachments 3, 4\./);
  assert.ok(task.events.some(event => event.said.key === 'Sent back with {count} pictures: {note}'));
  // The repair of a failed check earlier got the bug's pictures only.
  assert.equal((host.flows[1].attachments as unknown[]).length, 2);
  await assert.rejects(host.tasks.sendBack('tapd:100/1', '  '), /Say what should change/);
});

test('the task puts a card into its conversation each time it needs a person, and the newest one counts', async t => {
  const host = await setup(t, { retries: 0 });
  // First the models leave the bug as it was: the check fails, and the task says so where the person is reading.
  host.edits.push(async () => undefined, host.fix);
  // A bug typed in a conversation: its source keeps no pictures, DSH has the ones that were sent along.
  delete host.store.pool['tapd:100/1'].item.images;
  await host.tasks.start('tapd:100/1', [{ attachmentId: 'typed-1' }]);
  await host.tasks.idle('tapd:100/1');
  const task = host.store.tasks['tapd:100/1'];
  assert.equal(task.status, 'failed');
  assert.deepEqual(host.cards, [[1, 'failed']]);
  assert.deepEqual(task.pictures?.[0], { index: 0, ref: { attachmentId: 'typed-1' } }, 'pictures sent along in the conversation are kept as DSH has them');
  await host.tasks.sendBack('tapd:100/1', '', [], [{ attachmentId: 'kept-1' }]);
  await host.tasks.idle('tapd:100/1');
  assert.equal(task.status, 'review', said(task.error));
  assert.deepEqual(host.cards, [[1, 'failed'], [2, 'review']]);
  assert.equal(task.cards, 2);
  assert.deepEqual(host.flows.at(-1)?.attachments?.at(-1), { type: 'image', attachment: { attachmentId: 'kept-1' } }, 'a picture typed with the feedback reaches the models');
  // Accepting changes the task, not the conversation: the card that asked is the one that then says it is done.
  await host.tasks.accept('tapd:100/1');
  await host.tasks.idle('tapd:100/1');
  assert.deepEqual([task.status, host.cards.length], ['done', 2]);

  const closed = await setup(t, { cardFails: true });
  closed.edits.push(closed.fix);
  await closed.tasks.start('tapd:100/1');
  await closed.tasks.idle('tapd:100/1');
  assert.deepEqual([closed.store.tasks['tapd:100/1'].status, closed.store.tasks['tapd:100/1'].cards], ['review', 0], 'a card that could not be shown is not counted, and the task goes on');
});
