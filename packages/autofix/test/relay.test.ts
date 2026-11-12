import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { defaultSettings, Failure, type ItemImage, type Route, type Task } from '../src/domain.js';
import { RelayClient, RelayServer, type Published } from '../src/relay.js';
import type { State } from '../src/service.js';
import { Spool } from '../src/spool.js';
import { LocalFiles, Store } from '../src/store.js';
import type { Machine } from '../src/workplaces.js';

type TaskView = State['tasks'][number];
/** A machine's shell, with a line of noise before every answer as a login banner would add. */
const machine = (location: Machine['location'] = { kind: 'remote', hostId: 'h1', host: 'code' }): Machine => ({
  location, folder: '/',
  git: async () => [], read: async () => undefined,
  shell: (command, _env, output, signal) => new Promise(resolve => {
    const child = spawn('/bin/sh', ['-c', `echo 'Last login: today'; ${command}`], { signal });
    child.stdout.on('data', data => output(String(data))); child.stderr.on('data', data => output(String(data)));
    child.on('error', () => resolve(null)); child.on('close', code => resolve(code));
  }),
});
const route = (name: string, project: string): Route => ({ id: name, name, project, defaultBranch: 'main', tests: [], packageGlobs: [], sharedPaths: [], buildScripts: [], preview: '', pushRemote: 'origin', accept: 'merge' });
const said = (error: unknown) => error instanceof Failure ? error.said : String(error);

test('files in the shared folder arrive whole, whatever their size, and what is not there is said to be missing', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-autofix-spool-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const spool = new Spool(machine(), root);
  assert.equal(await spool.read('tasks/none.json'), undefined);
  await spool.writeJson('tasks/manual%3A1.json', { title: '活动页白屏 "quoted" $HOME `x`', n: 1 });
  assert.deepEqual(await spool.readJson('tasks/manual%3A1.json'), { title: '活动页白屏 "quoted" $HOME `x`', n: 1 });
  const big = randomBytes(300_000);
  await spool.write('inbox/a/1.png', big);
  assert.ok((await spool.read('inbox/a/1.png'))?.equals(big), 'a picture sent in several pieces is the same picture');
  assert.deepEqual((await readdir(join(root, 'inbox', 'a'))), ['1.png'], 'nothing is left behind from sending it');
  assert.equal((await stat(join(root, 'inbox', 'a', '1.png'))).mode & 0o077, 0, 'other accounts cannot read it');
  await spool.writeJson('inbox/x.json', { a: 1 }); await spool.writeJson('inbox/y.json', { b: '二' });
  assert.deepEqual(await spool.collect('inbox'), [{ name: 'x', text: '{"a":1}' }, { name: 'y', text: '{"b":"二"}' }]);
  assert.deepEqual(await new Spool(machine(), join(root, 'nowhere')).collect('inbox'), []);
  await spool.remove('inbox/a');
  assert.deepEqual((await readdir(join(root, 'inbox'))).sort(), ['x.json', 'y.json']);
  await assert.rejects(spool.read('../outside'), /Not a path/);
  await assert.rejects(spool.write('a b', 'x'), /Not a path/);
});

async function setup(t: TestContext, options: { relay?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-autofix-relay-')), home = await mkdtemp(join(tmpdir(), 'dsh-autofix-relay-state-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(home, { recursive: true, force: true })]));
  const store = new Store(new LocalFiles(home));
  await store.open();
  store.settings = { ...defaultSettings(), routes: [route('Web', '/mini/web'), route('Docs', '/mini/docs')], run: { ...defaultSettings().run, relay: options.relay ?? true } };
  const created: { title: string; body: string; images: { name: string; mediaType: string; data: string }[]; assignment: unknown; kind?: string }[] = [], calls: unknown[][] = [], chosen: unknown[] = [];
  let clock = 1_000_000;
  const view = (key: string): TaskView | undefined => store.tasks[key] && { ...store.tasks[key], running: false, sourceName: 'Manual' };
  const server = new RelayServer({
    store, root, now: () => clock, identity: { id: 'exec-1', name: 'Mac mini' },
    machine: async () => machine(),
    // The DSH that runs fixes knows the repositories by its own workspace paths; the main folder on the machine is what both sides share.
    inspect: async project => ({ name: 'x', defaultBase: 'main', branches: [], setup: [], repository: project === '/mini/web' ? '/srv/web' : '/srv/docs' }),
    async createManual(input) { created.push(input); return { key: `manual:${created.length}` }; },
    view, diff: async key => ({ stat: ` a.js | 2 +-`, patch: `diff for ${key}`, truncated: false }),
    tasks: {
      async start(key, _pictures, choice) {
        chosen.push(choice);
        const task = { key, item: { source: 'manual', id: key.slice(7), ref: `M${key.slice(7)}`, title: created.at(-1)!.title, body: '', labels: [] }, routeId: 'Web', baseBranch: 'main', status: 'working', attempts: 1, startedAt: clock, updatedAt: clock, events: [],
          flow: { steps: [{ role: 'implement', round: 1, model: 'm', status: 'done', body: 'x'.repeat(9000) }], report: 'fixed' } } as unknown as Task;
        store.tasks[key] = task;
        return task;
      },
      async sendBack(key, feedback, pictures = []) { calls.push(['sendBack', key, feedback, pictures.map((picture: ItemImage) => [picture.mediaType, picture.data.length])]); return store.tasks[key]; },
      async accept(key) { calls.push(['accept', key]); if (store.tasks[key].status !== 'review') throw new Failure({ key: 'Only a fix that is waiting for you can be accepted' }); return store.tasks[key]; },
      stop(key) { calls.push(['stop', key]); return true; },
      async retryReport(key) { calls.push(['retryReport', key]); return store.tasks[key]; },
      async removeWorkspace(key) { calls.push(['removeWorkspace', key]); return store.tasks[key]; },
    },
  });
  const shot = randomBytes(70_000);
  // The DSH a person types into reaches the same machine through its own workspace of the repository.
  const client = new RelayClient({
    root, now: () => clock, waitMs: 6000, pollMs: 60,
    machine: async () => machine({ kind: 'remote', hostId: 'air-knows-it-as-h9', host: 'code' }),
    inspect: async folder => ({ name: 'x', defaultBase: null, branches: [], setup: [], ...(folder === '/air/web' ? { repository: '/srv/web' } : folder === '/air/other' ? { repository: '/srv/other' } : {}) }),
    readImage: async ref => ({ data: shot, mediaType: (ref as { mediaType: string }).mediaType }),
  });
  /** The other DSH keeps looking while this one waits for it. */
  const serving = () => { let on = true; const loop = (async () => { while (on) { await server.tick(); await new Promise(resolve => setTimeout(resolve, 40)); } })(); return async () => { on = false; await loop; }; };
  return { root, store, server, client, created, calls, chosen, shot, serving, tick: (ms: number) => { clock += ms; } };
}

test('a bug typed in one DSH is taken by the DSH that runs fixes for that machine, and followed from there', async t => {
  const host = await setup(t);
  assert.equal(await host.client.file('/air/web', { title: 'bug', body: '' }, []), undefined, 'nobody runs fixes there yet');
  await host.server.tick();
  const published = JSON.parse(await readFile(join(host.root, 'executor.json'), 'utf8')) as Published;
  assert.deepEqual([published.name, published.routes.map(entry => [entry.name, entry.repository, entry.defaultBranch])], ['Mac mini', [['Web', '/srv/web', 'main'], ['Docs', '/srv/docs', 'main']]]);
  assert.deepEqual(host.server.status, [{ label: 'code', routes: ['Web', 'Docs'] }]);

  const stop = host.serving();
  t.after(stop);
  const handed = await host.client.file('/air/web', { title: '活动页白屏', body: '活动页白屏\n只在 iOS' }, [{ mediaType: 'image/png' }]);
  assert.deepEqual(handed, { key: 'manual:1', ref: 'M1', title: '活动页白屏' });
  assert.deepEqual([host.created[0].title, host.created[0].body, host.created[0].assignment], ['活动页白屏', '活动页白屏\n只在 iOS', { routeId: 'Web', branch: 'main' }]);
  assert.deepEqual(host.created[0].images.map(image => [image.name, image.mediaType, Buffer.from(image.data, 'base64').equals(host.shot)]), [['1.png', 'image/png', true]], 'the screenshot crossed over whole');
  // The answer is written first and the request tidied away right after it, so the reply can arrive a moment earlier.
  let left = await readdir(join(host.root, 'inbox'));
  for (let tries = 0; left.length && tries < 200; tries++) { await new Promise(resolve => setTimeout(resolve, 10)); left = await readdir(join(host.root, 'inbox')); }
  assert.deepEqual(left, [], 'a request that was taken is gone');

  // The card on the first DSH reads the task, without the steps' full text.
  await stop(); await host.server.tick();
  const seen = await host.client.task('/air/web', 'manual:1');
  assert.deepEqual([seen?.task.status, seen?.task.item.ref, seen?.route, seen?.task.flow?.report, (seen?.task.flow?.steps[0] as { body?: string }).body], ['working', 'M1', { id: 'Web', name: 'Web', accept: 'merge' }, 'fixed', undefined]);
  await assert.rejects(host.client.diff('/air/web', 'manual:1'), error => (said(error) as { key: string }).key === 'The changes are not here yet');
  Object.assign(host.store.tasks['manual:1'], { status: 'review', commit: 'abc1234', updatedAt: 1_000_500 });
  await host.server.tick();
  assert.equal((await host.client.task('/air/web', 'manual:1'))?.task.status, 'review');
  assert.deepEqual(await host.client.diff('/air/web', 'manual:1'), { stat: ' a.js | 2 +-', patch: 'diff for manual:1', truncated: false });

  // What the person decides there is carried out here; a refusal comes back in words the page can translate.
  const again = host.serving();
  await host.client.act('/air/web', { kind: 'sendBack', key: 'manual:1', feedback: '还是白屏' }, [{ data: host.shot, mediaType: 'image/jpeg', name: 's.jpg' }]);
  await host.client.act('/air/web', { kind: 'accept', key: 'manual:1' });
  assert.deepEqual(host.calls, [['sendBack', 'manual:1', '还是白屏', [['image/jpeg', 70_000]]], ['accept', 'manual:1']]);
  host.store.tasks['manual:1'].status = 'working';
  await assert.rejects(host.client.act('/air/web', { kind: 'accept', key: 'manual:1' }), error => (said(error) as { key: string }).key === 'Only a fix that is waiting for you can be accepted');
  await assert.rejects(host.client.act('/air/web', { kind: 'stop', key: 'manual:404' }), error => (said(error) as { key: string }).key === 'There is no task for this bug');
  // Something to build crosses over as that, with the models and rounds its /flow line chose; what is not a choice is dropped on arrival.
  await host.client.file('/air/web', { title: '给导出加 CSV', body: '' }, [], { kind: 'feature', models: { implement: 'codex', nonsense: 'x' } as never, rounds: 2 });
  assert.deepEqual([host.created.at(-1)?.kind, host.chosen.at(-1)], ['feature', { models: { implement: 'codex' }, rounds: 2 }]);
  assert.deepEqual([host.created[0].kind, host.chosen[0]], [undefined, {}], 'a bug is still a bug');
  delete host.store.tasks['manual:2'];
  await host.client.act('/air/web', { kind: 'removeWorkspace', key: 'manual:1' });
  assert.deepEqual(host.calls.at(-1), ['removeWorkspace', 'manual:1'], 'the workspace of a finished fix is removed where it is');
  await again();

  // A task that is forgotten there disappears here too.
  delete host.store.tasks['manual:1'];
  await host.server.tick();
  assert.equal(await host.client.task('/air/web', 'manual:1'), undefined);
  assert.deepEqual(await readdir(join(host.root, 'tasks')), []);
});

test('a repository the other DSH does not have, a name, and a DSH that has gone quiet are each said plainly', async t => {
  const host = await setup(t);
  await host.server.tick();
  await assert.rejects(host.client.file('/air/other', { title: 'bug', body: '' }, []), error => assert.deepEqual(said(error), { key: '{name} runs fixes on this machine, but not for this repository. It has: {names}', values: { name: 'Mac mini', names: 'Web, Docs' } }) === undefined);
  assert.equal(await host.client.file('/air/not-a-repository', { title: 'bug', body: '' }, []), undefined);
  const stop = host.serving();
  assert.equal((await host.client.file('/air/other', { repo: 'doc', title: 'typo', body: '' }, []))?.key, 'manual:1', 'named, it need not be the repository of the conversation');
  assert.deepEqual(host.created[0].assignment, { routeId: 'Docs', branch: 'main' });
  await assert.rejects(host.client.file('/air/web', { repo: 'nope', title: 'bug', body: '' }, []), error => (said(error) as { key: string }).key === 'No repository is called {name}. There are: {names}');
  await stop();

  // Nobody is taking requests: the bug is not left lying there to be carried out later.
  const quiet = new RelayClient({ root: host.root, now: () => 1_000_000, waitMs: 300, pollMs: 50, machine: async () => machine(), inspect: async () => ({ name: 'x', defaultBase: null, branches: [], setup: [], repository: '/srv/web' }), readImage: async () => ({ data: host.shot, mediaType: 'image/png' }) });
  await assert.rejects(quiet.file('/air/web', { title: 'late', body: '' }, [{}]), error => (said(error) as { key: string }).key === '{name} did not take this within {seconds} s. Is its DSH running, with taking bugs from other DSHes switched on?');
  assert.deepEqual(await readdir(join(host.root, 'inbox')), []);
  host.tick(10 * 60_000);
  await assert.rejects(host.client.file('/air/web', { title: 'bug', body: '' }, []), error => (said(error) as { key: string }).key === '{name} runs fixes for this machine but is not answering. Is its DSH running, with taking bugs from other DSHes switched on?');

  // Switched off, a DSH neither says it is there nor takes anything.
  const off = await setup(t, { relay: false });
  await off.server.tick();
  assert.deepEqual([off.server.status, await readdir(off.root)], [[], []]);
});
