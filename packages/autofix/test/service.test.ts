import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { say, type Item, type Source } from '../src/domain.js';
import { createHandler } from '../src/http.js';
import { ManualSource } from '../src/manual.js';
import { AutofixService, Sources } from '../src/service.js';
import { LocalFiles, Store } from '../src/store.js';
import { Tasks } from '../src/tasks.js';

const bug = (id: string, title: string, source = 'tapd'): Item => ({ source, id: `100/${id}`, ref: id, title, body: '', project: { id: '100', name: 'Dana' }, labels: [] });
async function setup(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-autofix-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = new Store(new LocalFiles(home));
  await store.open();
  const never = async () => { throw new Error('not used'); };
  const sources = new Sources(), manual = new ManualSource(join(home, 'manual'));
  const tasks = new Tasks({ store, source: id => sources.get(id), workplaces: { create: never, machine: never }, conversations: { open: never, flow: never, picture: never } });
  const service = new AutofixService({ store, tasks, sources, manual, workplaces: { projects: async () => [], inspect: never, machine: never }, folders: { add: never, repository: never }, now: () => 5000 });
  const handler = createHandler(service, tasks);
  const post = async (body: Record<string, unknown>, headers: Record<string, string> = { 'X-DSH-Autofix': '1' }) => {
    const response = await handler(new Request('http://dsh/api/autofix', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }));
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  const settings = { routes: [{ name: 'Web', project: '/repo', defaultBranch: 'main', packageGlobs: ['packages/*', './apps/*/'] }], run: { denyLabels: ['Payment'] } };
  return { home, store, service, post, settings, sources, manual };
}
/** A tracker that is asked for its open bugs. */
function tracker(id: string, name: string) {
  const state = { bugs: [] as unknown[], fails: '', unready: false };
  const source: Source = { id, name, unready: () => state.unready ? say('Sign in to {name} first', { name }) : undefined, async fetch() { if (state.fails) throw new Error(state.fails); return state.bugs as Item[]; } };
  return { source, state };
}

test('settings are checked before they are saved, and only this plugin\'s pages may ask', async t => {
  const host = await setup(t);
  assert.equal((await host.post({ action: 'state' }, {})).status, 403);
  const saved = await host.post({ action: 'saveSettings', settings: host.settings });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.state.settings.routes[0], { id: 'Web', name: 'Web', project: '/repo', defaultBranch: 'main', tests: [], packageGlobs: ['packages/*', 'apps/*'], sharedPaths: [], buildScripts: [], preview: '', pushRemote: 'origin', accept: 'merge' });
  assert.deepEqual(saved.body.state.settings.run, { denyLabels: ['Payment'], permission: 'workspace-write', rounds: 3, flowModels: {}, checkRetries: 1, relay: false });
  assert.equal((await stat(join(host.home, 'settings.json'))).mode & 0o777, 0o600);
  const bad = await host.post({ action: 'saveSettings', settings: { routes: [{ name: 'A', project: '/a', sharedPaths: ['../etc'] }] } });
  assert.deepEqual([bad.status, bad.body.error], [400, 'A shared path must be a path inside the repository']);
  assert.equal(host.store.settings.routes[0].name, 'Web', 'a refused save changes nothing');
});

test('sources come and go; each is asked for its own bugs, and one failing does not stop the others', async t => {
  const host = await setup(t);
  await host.post({ action: 'saveSettings', settings: host.settings });
  const tapd = tracker('tapd', 'TAPD'), jira = tracker('jira', 'Jira');
  assert.throws(() => host.service.register({ id: 'Bad ID', name: 'x' }), /lowercase letters/);
  const removeTapd = host.service.register(tapd.source), removeJira = host.service.register(jira.source);
  tapd.state.bugs = [bug('1', '【活动页】白屏'), { id: '100/x', title: '' }];
  await assert.rejects(host.service.fetch('tapd'), /needs an ID and a title/, 'a source\'s data is checked');
  tapd.state.bugs = [bug('1', '【活动页】白屏'), { id: 7, title: 'loose shape', labels: 'nope' }].slice(0, 1);
  jira.state.fails = 'Jira is down';
  const fetched = await host.post({ action: 'fetch' });
  assert.deepEqual([fetched.status, fetched.body.added], [200, 1], 'TAPD\'s bugs arrive although Jira failed');
  assert.deepEqual(fetched.body.state.sources, [
    { id: 'jira', name: 'Jira', fetches: true, error: 'Jira is down', busy: false },
    { id: 'tapd', name: 'TAPD', fetches: true, at: 5000, busy: false },
  ]);
  assert.deepEqual(fetched.body.state.pool.map((entry: { key: string; sourceName: string }) => [entry.key, entry.sourceName]), [['tapd:100/1', 'TAPD']]);
  assert.equal((await host.post({ action: 'fetch', source: 'jira' })).body.error, 'Jira is down');
  jira.state.unready = true; jira.state.fails = '';
  const skipped = await host.post({ action: 'fetch' });
  assert.deepEqual(skipped.body.state.sources[0].unready, { key: 'Sign in to {name} first', values: { name: 'Jira' } }, 'a source that is not set up is not asked');

  // A person assigns one; later bugs with that prefix follow it, and those of another source do not.
  assert.equal((await host.post({ action: 'assign', key: 'tapd:100/1', assignment: { routeId: 'nope' } })).body.error, 'Choose a repository');
  await host.post({ action: 'assign', key: 'tapd:100/1', assignment: { routeId: 'Web', branch: '', package: 'packages/act/' } });
  tapd.state.bugs = [bug('1', '【活动页】白屏'), bug('2', '【活动页】倒计时'), bug('3', '没有前缀')];
  jira.state.unready = false; jira.state.bugs = [bug('2', '【活动页】来自 Jira', 'jira')];
  const again = await host.post({ action: 'fetch' });
  assert.equal(again.body.added, 3, JSON.stringify(again.body.state.sources) + JSON.stringify(again.body.state.pool.map((e: { key: string }) => e.key)));
  const pool = Object.fromEntries(again.body.state.pool.map((entry: { key: string; assignment?: unknown }) => [entry.key, entry.assignment]));
  assert.deepEqual(pool['tapd:100/2'], { routeId: 'Web', branch: 'main', package: 'packages/act' });
  assert.deepEqual([pool['tapd:100/3'], pool['jira:100/2']], [undefined, undefined]);
  assert.equal((await host.post({ action: 'start', key: 'tapd:100/3' })).body.said.key, 'Choose a repository and a branch for this bug first');
  assert.equal((await host.post({ action: 'start', key: 'x' })).status, 400);

  // A source's plugin unloads: its bugs stay readable, under its ID.
  removeJira();
  const without = await host.post({ action: 'state' });
  assert.deepEqual(without.body.state.sources.map((source: { id: string }) => source.id), ['tapd']);
  assert.equal(without.body.state.pool.find((entry: { key: string }) => entry.key === 'jira:100/2').sourceName, 'jira');
  assert.equal((await host.post({ action: 'fetch', source: 'jira' })).body.error, 'This source is not loaded');
  removeTapd();
});

test('a source that is not asked hands bugs in when it has them', async t => {
  const host = await setup(t);
  await assert.rejects(host.service.submit('alerts', [bug('1', 'x', 'alerts')]), /Register the source/);
  host.service.register({ id: 'alerts', name: 'Alerts' });
  assert.deepEqual(await host.service.submit('alerts', [{ id: 'a1', title: 'TypeError in pay.ts', body: 'stack…', labels: ['prod'], url: 'javascript:alert(1)' } as unknown as Item]), { added: 1 });
  assert.deepEqual(await host.service.submit('alerts', [{ id: 'a2', title: 'Another' } as unknown as Item]), { added: 1 });
  const state = host.service.state();
  assert.deepEqual(state.sources, [{ id: 'alerts', name: 'Alerts', fetches: false, busy: false }]);
  assert.deepEqual(state.pool.map(entry => [entry.key, entry.item.ref, entry.stale ?? false, entry.item.url]), [['alerts:a1', 'a1', false, undefined], ['alerts:a2', 'a2', false, undefined]], 'the first is not stale because the second came alone');
  assert.deepEqual(await host.service.fetch(), { added: 0 }, 'nothing to ask');
  await assert.rejects(host.service.fetch('alerts'), /hands bugs in by itself/);
});

test('a bug typed in keeps its pictures until it is fixed or thrown away', async t => {
  const host = await setup(t);
  host.sources.register(host.manual);
  await host.post({ action: 'saveSettings', settings: host.settings });
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20, 7)]), jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20, 9)]);
  const picture = (data: Buffer, mediaType = 'image/png') => ({ name: 'shot', mediaType, data: data.toString('base64') });
  assert.equal((await host.post({ action: 'createManual', bug: { title: '  ', body: 'x' } })).body.error, 'Give the bug a title');
  assert.equal((await host.post({ action: 'createManual', bug: { title: 'x', images: [picture(Buffer.from('<svg/>'), 'image/png')] } })).body.error, 'Picture 1 is not a PNG, JPEG, WebP or GIF');
  assert.equal((await host.post({ action: 'createManual', bug: { title: 'x', images: Array.from({ length: 9 }, () => picture(png)) } })).body.error, 'Add at most 8 pictures');
  assert.equal((await host.post({ action: 'createManual', bug: { title: 'x', assignment: { routeId: 'nope' } } })).body.error, 'Choose a repository');
  assert.deepEqual(Object.keys(host.store.pool), [], 'a bug that could not be placed is not left half made');

  const made = await host.post({ action: 'createManual', bug: { title: '充值按钮白屏', body: '点击后见 [image 2]', labels: ['h5'], images: [picture(png), picture(jpeg, 'image/png')], assignment: { routeId: 'Web', branch: '' } } });
  assert.equal(made.status, 200, made.body.error);
  const key = made.body.key as string, entry = made.body.state.pool.find((item: { key: string }) => item.key === key);
  assert.match(key, /^manual:\d+$/);
  assert.deepEqual([entry.item.ref, entry.item.title, entry.item.body, entry.item.images, entry.item.labels, entry.sourceName, entry.assignment], [`M${key.slice(7)}`, '充值按钮白屏', '点击后见 [image 2]\n\n[image 1]', 2, ['h5'], 'Manual', { routeId: 'Web', branch: 'main' }]);
  const first = await host.manual.image(entry.item, 0), second = await host.manual.image(entry.item, 1);
  assert.deepEqual([first?.mediaType, first?.data.length, second?.mediaType], ['image/png', 28, 'image/jpeg'], 'the bytes decide what a picture is, not what the page called it');
  assert.equal(await host.manual.image(entry.item, 2), undefined);
  const next = await host.post({ action: 'createManual', bug: { title: 'second' } });
  assert.equal(Number((next.body.key as string).slice(7)), Number(key.slice(7)) + 1, 'numbers are never reused');

  await host.post({ action: 'discard', key });
  assert.equal(host.store.pool[key], undefined);
  assert.deepEqual((await readdir(join(host.home, 'manual'))).filter(name => name !== 'counter'), [], 'its pictures are gone with it');
  // A tracker's open bug cannot be thrown away: the next fetch would bring it back.
  const tapd = tracker('tapd', 'TAPD');
  host.service.register(tapd.source);
  tapd.state.bugs = [bug('1', 'open in the tracker')];
  await host.post({ action: 'fetch' });
  assert.equal((await host.post({ action: 'discard', key: 'tapd:100/1' })).body.error, 'TAPD still lists this bug; ignore it instead');
});
