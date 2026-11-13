import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { tuiHolder } from '../src/holder-protocol.js';
import { sharedTui, sharedTuiName, sharedTuis, TuiSharing, type SharedTui } from '../src/tui-shared.js';
import { tuiKey } from '../src/tui-state.js';
import { TuiSessions, tuiClaudeSession } from '../src/tui.js';
import { fixture } from './state-fixture.js';

const signal = new AbortController().signal;
const SESSION = '0a1b2c3d-1111-4222-8333-444455556666', OTHER = '9f8e7d6c-aaaa-4bbb-8ccc-ddddeeeeffff';

/** One account on a machine: the files `SHARED_TUI_FOLDER` holds, by name. */
class Machine {
  readonly files = new Map<string, string>();
  down = false; reads = 0; puts = 0;
  list(): string { if (this.down) throw new Error('ssh: connect to host box port 22: Operation timed out'); this.reads += 1; return [...this.files.values()].join('\n'); }
  put(name: string, record: string): void { if (this.down) throw new Error('ssh: connect to host box port 22: Operation timed out'); this.puts += 1; this.files.set(name, record); }
  record(key: string): SharedTui { return JSON.parse(this.files.get(sharedTuiName(key)) ?? 'null') as SharedTui; }
}

/** A DSH with the plugin: its conversations, which of them are archived, and the machines it has saved. */
async function dsh(t: TestContext, machines: Record<string, Machine>, options: { ids?: (wanted: string) => string; archive?: boolean } = {}) {
  const f = await fixture(t);
  const rows = new Map<string, { blank: boolean; title?: string; workspace: string; live: boolean; events: string[]; model?: string }>();
  const archived: string[] = [], warnings: string[] = [], clock = { now: Date.parse('2026-11-13T10:00:00Z') };
  const cwds = new Map<string, { hostId: string; cwd: string }>();
  const tui = new TuiSessions(f.store, {
    verify: async id => { const target = cwds.get(rows.get(id)?.workspace ?? ''); if (!target) throw new Error('Select a verified remote workspace first.'); return target; },
    session: id => { const row = rows.get(id); return row?.live ? { append: type => { row.events.push(type); if (type === 'turn/start') row.blank = false; } } : undefined; },
    list: async () => [...rows].map(([sessionId, row]) => ({ sessionId, blank: row.blank })),
    rename: async (id, title) => { rows.get(id)!.title = title; },
    selectModel: async selection => { rows.get(selection.sessionId)!.model = selection.model; },
    titleRecords: async () => '', codexThread: async () => '01a1a960-0696-7481-b86c-ea7a878c6479', codexTitleRecords: async () => '',
  });
  const sharing = new TuiSharing(f.store, tui, {
    hosts: async () => Object.keys(machines).map(id => ({ id, label: id })),
    list: async hostId => machines[hostId].list(),
    put: async (hostId, name, record) => machines[hostId].put(name, record),
    target: async id => { const target = cwds.get(rows.get(id)?.workspace ?? ''); if (!target) throw new Error('Select a verified remote workspace first.'); return target; },
    archived: () => (options.archive === false ? undefined : archived),
    archive: async (id, value) => { if (!rows.has(id)) throw new Error('unknown session'); const at = archived.indexOf(id); if (value && at < 0) archived.push(id); if (!value && at >= 0) archived.splice(at, 1); },
    rows: async () => new Map([...rows].map(([id, row]) => [id, { blank: row.blank, ...(row.title === undefined ? {} : { title: row.title }) }])),
    anchor: async (hostId, cwd) => { if (cwd === '/gone') throw new Error('Not a readable directory'); const path = `/anchors/${hostId}${cwd}`; cwds.set(path, { hostId, cwd }); return path; },
    workspace: async path => path,
    create: async (workspace, wanted) => { const id = options.ids?.(wanted) ?? wanted; if (!rows.has(id)) rows.set(id, { blank: true, workspace, live: true, events: [] }); return id; },
    warn: message => { warnings.push(message); }, now: () => clock.now,
  });
  /** A new conversation in the remote workspace of `cwd`, started in the TUI as its button does. */
  const start = async (id: string, cwd = '/srv/app', hostId = Object.keys(machines)[0], selection: Record<string, unknown> = {}) => {
    const workspace = `/anchors/${hostId}${cwd}`;
    cwds.set(workspace, { hostId, cwd });
    rows.set(id, { blank: true, workspace, live: true, events: [] });
    await tui.start(id, selection, signal);
  };
  const details = (id: string) => f.store.snapshot().tuiDetails?.[id];
  return { f, tui, sharing, rows, archived, warnings, clock, start, details };
}

test('a TUI conversation started in one DSH appears in another that uses the same machine, on the same CLI session and terminal', async t => {
  const box = new Machine(), a = await dsh(t, { box }), b = await dsh(t, { box });
  await a.start(SESSION, '/srv/app', 'box', { model: 'box/claude/opus%5B1m%5D', effort: 'high' });
  await b.sharing.run();
  assert.equal(b.rows.size, 0, 'nothing is listed until the first DSH has had its round');
  await a.sharing.run();
  assert.deepEqual(box.record(SESSION), { v: 1, key: SESSION, cli: 'claude', cwd: '/srv/app', title: 'Claude Code', model: 'opus[1m]', effort: 'high', at: '2026-11-13T10:00:00.000Z' });
  await b.sharing.run();
  assert.deepEqual([...b.rows], [[SESSION, { blank: false, workspace: '/anchors/box/srv/app', live: true, events: ['turn/start', 'turn/end'], model: 'box/claude/opus%5B1m%5D', title: 'Claude Code' }]]);
  assert.deepEqual(b.tui.list(), [SESSION]);
  assert.deepEqual(b.details(SESSION), { title: 'Claude Code', model: 'opus[1m]', effort: 'high', modelRecorded: true, shared: { archived: false, title: 'Claude Code' }, usageFrom: '2026-11-13T10:00:00.000Z' });
  const puts = box.puts;
  await a.sharing.run(); await b.sharing.run(); await a.sharing.run();
  assert.equal(box.puts, puts, 'once both agree, nothing more is written');
  assert.equal(a.rows.size, 1); assert.equal(b.rows.size, 1);
  assert.deepEqual([a.warnings, b.warnings], [[], []]);
});

test('where DSH gives the conversation another ID, it still runs the first DSH\'s CLI session in the first DSH\'s terminal', async t => {
  const box = new Machine(), a = await dsh(t, { box }), b = await dsh(t, { box }, { ids: () => OTHER });
  await a.start(SESSION);
  await a.sharing.run(); await b.sharing.run();
  assert.deepEqual(b.tui.list(), [OTHER]);
  const here = b.details(OTHER);
  assert.equal(here?.key, SESSION);
  assert.equal(tuiClaudeSession(tuiKey(OTHER, here)), tuiClaudeSession(tuiKey(SESSION, a.details(SESSION))));
  assert.equal(tuiHolder(tuiKey(OTHER, here)), tuiHolder(SESSION));
  await b.sharing.run(); await a.sharing.run(); await b.sharing.run();
  assert.equal(b.rows.size, 1, 'and it is not taken for a conversation that is missing here');
  assert.equal(box.files.size, 1);
});

test('a Codex conversation brings its thread', async t => {
  const box = new Machine(), a = await dsh(t, { box }), b = await dsh(t, { box });
  await a.start(SESSION, '/srv/app', 'box', { cli: 'codex', model: 'box/codex/gpt-6.1-sol' });
  await a.sharing.run(); await b.sharing.run();
  assert.deepEqual(b.tui.codex(), [SESSION]);
  assert.equal(b.details(SESSION)?.thread, '01a1a960-0696-7481-b86c-ea7a878c6479');
  assert.equal(b.rows.get(SESSION)?.model, 'box/codex/gpt-6.1-sol');
  assert.equal(b.rows.get(SESSION)?.title, 'Codex');
});

test('conversations archived before they were ever listed stay where they are, until one is restored', async t => {
  const box = new Machine(), a = await dsh(t, { box }), b = await dsh(t, { box });
  await a.start(SESSION); await a.start(OTHER);
  a.archived.push(OTHER);
  await a.sharing.run(); await b.sharing.run();
  assert.deepEqual([...box.files.keys()], [sharedTuiName(SESSION)]);
  assert.deepEqual(b.tui.list(), [SESSION]);
  a.archived.length = 0;
  await a.sharing.run(); await b.sharing.run();
  assert.deepEqual(b.tui.list().sort(), [SESSION, OTHER].sort());
});

test('archiving in one DSH archives it in the others, and restoring it anywhere restores it everywhere', async t => {
  const box = new Machine(), a = await dsh(t, { box }), b = await dsh(t, { box }), c = await dsh(t, { box });
  await a.start(SESSION);
  await a.sharing.run(); await b.sharing.run();
  a.archived.push(SESSION);
  await b.sharing.run();
  assert.deepEqual(b.archived, [], 'not before the first DSH has said so');
  await a.sharing.run();
  assert.equal(box.record(SESSION).archived, true);
  await b.sharing.run();
  assert.deepEqual(b.archived, [SESSION]);
  await c.sharing.run();
  assert.equal(c.rows.size, 0, 'a DSH that never had it does not get an archived conversation');
  await a.sharing.run(); await b.sharing.run();
  assert.deepEqual([a.archived, b.archived], [[SESSION], [SESSION]], 'and it stays archived');
  // Restored in the second DSH.
  b.archived.length = 0;
  await a.sharing.run();
  assert.deepEqual(a.archived, [SESSION]);
  await b.sharing.run();
  assert.equal(box.record(SESSION).archived, undefined);
  await a.sharing.run(); await c.sharing.run();
  assert.deepEqual(a.archived, []);
  assert.deepEqual(c.tui.list(), [SESSION], 'now the third one shows it too');
  assert.deepEqual([a.warnings, b.warnings, c.warnings], [[], [], []]);
});

test('the title its CLI gives a conversation reaches the other DSHes, except where it was renamed in DSH', async t => {
  const box = new Machine(), a = await dsh(t, { box }), b = await dsh(t, { box }), c = await dsh(t, { box });
  await a.start(SESSION);
  await a.sharing.run(); await b.sharing.run(); await c.sharing.run();
  c.rows.get(SESSION)!.title = 'My own name';
  // The first DSH has the conversation in view and reads the CLI's title.
  await a.tui.retitle(SESSION, 'Fix the login page');
  await a.sharing.run();
  assert.equal(box.record(SESSION).title, 'Fix the login page');
  await b.sharing.run(); await c.sharing.run();
  assert.equal(b.rows.get(SESSION)?.title, 'Fix the login page');
  assert.equal(b.details(SESSION)?.title, 'Fix the login page');
  assert.equal(c.rows.get(SESSION)?.title, 'My own name');
  assert.equal(c.details(SESSION)?.title, 'Fix the login page', 'where the CLI\'s title is noted, so that it is not taken for a change made there');
  const puts = box.puts;
  await a.sharing.run(); await b.sharing.run(); await c.sharing.run(); await a.sharing.run();
  assert.equal(box.puts, puts, 'and nothing goes back and forth');
  assert.equal(a.rows.get(SESSION)?.title, 'Fix the login page');
  assert.equal(box.record(SESSION).title, 'Fix the login page');
});

test('a conversation from a version that kept no title is not given the placeholder of the DSH that shows it', async t => {
  const box = new Machine(), a = await dsh(t, { box }), b = await dsh(t, { box });
  await a.start(SESSION);
  // As 0.2.81 left it: listed among the TUI conversations with nothing else kept, and named by that version.
  await a.f.store.update(state => { delete state.tuiDetails; });
  a.rows.get(SESSION)!.title = 'Claude TUI 03:04';
  await a.sharing.run(); await b.sharing.run(); await a.sharing.run(); await b.sharing.run(); await a.sharing.run();
  assert.equal(box.record(SESSION).title, undefined);
  assert.equal(a.rows.get(SESSION)?.title, 'Claude TUI 03:04');
  assert.equal(b.rows.get(SESSION)?.title, 'Claude Code');
});

test('a machine that cannot be reached loses nothing and is asked again later, less and less often', async t => {
  const box = new Machine(), other = new Machine(), a = await dsh(t, { box, other }), b = await dsh(t, { box, other });
  await a.start(SESSION);
  box.down = true;
  await a.sharing.run();
  assert.equal(other.files.size, 0, 'a conversation is listed on its own machine only');
  assert.equal(a.warnings.length, 1);
  await a.sharing.run(); await a.sharing.run();
  assert.equal(a.warnings.length, 1, 'said once');
  box.down = false;
  await a.sharing.run();
  assert.equal(box.files.size, 0, 'not asked again straight away');
  a.clock.now += 61_000;
  await a.sharing.run(); await b.sharing.run();
  assert.equal(box.files.size, 1);
  assert.deepEqual(b.tui.list(), [SESSION]);
  // Once listed, an unreachable machine makes no DSH forget or list the conversation again.
  box.down = true; b.clock.now += 3600_000; a.clock.now += 3600_000;
  await a.sharing.run(); await b.sharing.run();
  assert.deepEqual(b.tui.list(), [SESSION]); assert.equal(b.rows.size, 1);
});

test('a conversation whose directory is gone here is left out and tried again later; the others still come', async t => {
  const box = new Machine(), a = await dsh(t, { box }), b = await dsh(t, { box });
  await a.start(SESSION, '/gone'); await a.start(OTHER);
  await a.sharing.run(); await b.sharing.run();
  assert.deepEqual(b.tui.list(), [OTHER]);
  assert.equal(b.warnings.length, 1); assert.match(b.warnings[0], /Not a readable directory/);
  await b.sharing.run();
  assert.equal(b.warnings.length, 1);
});

test('an adoption cut short finds its conversation again instead of making a second one', async t => {
  const box = new Machine(), a = await dsh(t, { box }), b = await dsh(t, { box });
  await a.start(SESSION);
  await a.sharing.run();
  // DSH made the conversation, but it is not open yet when the plugin goes to record its first turn.
  const create = b.rows.set.bind(b.rows);
  b.rows.set = (id, row) => create(id, { ...row, live: false });
  await b.sharing.run();
  assert.deepEqual(b.tui.list(), []); assert.equal(b.rows.size, 1); assert.equal(b.warnings.length, 1);
  b.rows.set = create; b.rows.get(SESSION)!.live = true;
  b.clock.now += 61_000;
  await b.sharing.run();
  assert.deepEqual(b.tui.list(), [SESSION]);
  assert.deepEqual([...b.rows.keys()], [SESSION]);
  assert.deepEqual(b.rows.get(SESSION)?.events, ['turn/start', 'turn/end']);
});

test('a DSH that does not tell which conversations are archived shares nothing, rather than listing every old one', async t => {
  const box = new Machine(), a = await dsh(t, { box }, { archive: false }), b = await dsh(t, { box });
  await a.start(SESSION);
  await a.sharing.run(); await a.sharing.run();
  assert.equal(box.files.size, 0); assert.equal(box.reads, 0);
  assert.equal(a.warnings.length, 1);
  await b.start(OTHER);
  await b.sharing.run(); await a.sharing.run();
  assert.deepEqual(a.tui.list(), [SESSION], 'and takes none either');
});

test('a record is taken only if it is one: its model and effort reach a command line on the machine', () => {
  const good = { v: 1, key: SESSION, cli: 'claude', cwd: '/srv/app', at: '2026-11-13T10:00:00.000Z' };
  assert.deepEqual(sharedTui(good), good);
  assert.deepEqual(sharedTui({ ...good, model: 'opus"; rm -rf ~', effort: 'high', title: 'ok', extra: 1 }), { ...good, effort: 'high', title: 'ok' });
  for (const bad of [null, [], { ...good, v: 2 }, { ...good, cwd: 'relative' }, { ...good, cwd: '/a\nb' }, { ...good, key: '' }, { ...good, key: 'x'.repeat(300) }, { ...good, cli: 'bash' }, { ...good, cli: 'codex' }, { ...good, cli: 'codex', thread: '$(id)' }])
    assert.equal(sharedTui(bad), undefined, JSON.stringify(bad));
  assert.deepEqual(sharedTuis(`${JSON.stringify(good)}\n\n{"v":1,"key":\nnot json\n${JSON.stringify({ ...good, title: 'again' })}\n`), [good], 'a file cut short is passed over, and a conversation counts once');
});
