import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { savedHosts } from '@dsh-plugins/remote-core/saved-hosts.js';
import { TerminalsState } from '../src/state.js';

async function folder(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-remote-terminals-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
/** Remote Agents' state as 0.2.129 saved it, with its own entries beside the TUI conversations. */
const theirs = { version: 1, hosts: [{ id: 'host-box-1', label: 'Box', connection: 'ssh://builder@box' }], tasks: [{ id: 'task-1' }],
  tuiSessions: ['claude-1', 'codex-1'], tuiDetails: { 'claude-1': { title: 'Fix login', model: 'opus', modelRecorded: true }, 'codex-1': { cli: 'codex', thread: 'thread-1' } }, tuiLocalScroll: false };

test('the TUI conversations Remote Agents kept are taken over once, and left where they were', async t => {
  const directory = await folder(t), source = join(directory, 'remote-agents.json'), file = join(directory, 'own', 'state.json');
  await writeFile(source, JSON.stringify(theirs));
  const state = new TerminalsState(file); await state.open();
  assert.deepEqual(state.snapshot(), {}, 'nothing saved yet');
  await state.adopt(source);
  assert.deepEqual(state.snapshot(), { tuiSessions: ['claude-1', 'codex-1'], tuiDetails: theirs.tuiDetails, tuiLocalScroll: false });
  assert.deepEqual(JSON.parse(await readFile(source, 'utf8')), theirs, 'their file is only read');
  // A terminal's launcher reads the same file, by these names.
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual([saved.version, saved.adopted, saved.tuiSessions, saved.tuiLocalScroll], [1, true, ['claude-1', 'codex-1'], false]);
  assert.equal('hosts' in saved || 'tasks' in saved, false, 'nothing else of theirs is copied');

  // What changes here afterwards is not overwritten by their old copy, on this start or a later one.
  await state.update(next => { next.tuiSessions = ['codex-1']; next.tuiLocalScroll = true; });
  await state.adopt(source);
  const reopened = new TerminalsState(file); await reopened.open(); await reopened.adopt(source);
  assert.deepEqual([reopened.snapshot().tuiSessions, reopened.snapshot().tuiLocalScroll], [['codex-1'], true]);
});

test('a conversation started here before the first look at theirs is kept with them', async t => {
  const directory = await folder(t), source = join(directory, 'remote-agents.json');
  await writeFile(source, JSON.stringify(theirs));
  const state = new TerminalsState(join(directory, 'state.json')); await state.open();
  await state.update(next => { next.tuiSessions = ['new-1']; next.tuiDetails = { 'new-1': { title: 'Claude Code' }, 'claude-1': { title: 'Renamed here' } }; });
  await state.adopt(source);
  assert.deepEqual(state.snapshot().tuiSessions, ['claude-1', 'codex-1', 'new-1']);
  assert.equal(state.snapshot().tuiDetails?.['claude-1']?.title, 'Renamed here', 'what was saved here wins');
  assert.equal(state.snapshot().tuiLocalScroll, false);
});

test('Remote Agents without a saved state, or with none of these, leaves nothing to take over', async t => {
  const directory = await folder(t), state = new TerminalsState(join(directory, 'state.json')); await state.open();
  await state.adopt(join(directory, 'missing.json'));
  assert.deepEqual(state.snapshot(), {});
  // Asked once: a state that appears later belongs to a Remote Agents that no longer keeps TUI conversations.
  await writeFile(join(directory, 'missing.json'), JSON.stringify(theirs));
  await state.adopt(join(directory, 'missing.json'));
  assert.deepEqual(state.snapshot(), {});
});

test('a damaged state is refused rather than replaced, and what does not fit is dropped', async t => {
  const directory = await folder(t), file = join(directory, 'state.json');
  await writeFile(file, '{"version":2}');
  await assert.rejects(new TerminalsState(file).open(), /Invalid remote terminals state/);
  await writeFile(file, JSON.stringify({ version: 1, tuiSessions: ['a', 7], tuiDetails: { a: { title: 'A' }, b: 'odd' }, tuiLocalScroll: 'yes' }));
  const state = new TerminalsState(file); await state.open();
  assert.deepEqual(state.snapshot(), { tuiSessions: ['a'], tuiDetails: { a: { title: 'A' } } });
  // A change that throws saves nothing, and later changes still go through.
  await assert.rejects(state.update(() => { throw new Error('no'); }), /no/);
  await state.update(next => { next.tuiLocalScroll = false; });
  assert.equal(JSON.parse(await readFile(file, 'utf8')).tuiLocalScroll, false);
});

test('a launcher reads the saved machines from Remote Agents\' state without loading that plugin', async t => {
  const directory = await folder(t), source = join(directory, 'remote-agents.json');
  assert.deepEqual(await savedHosts(source), [], 'nothing saved yet');
  await writeFile(source, JSON.stringify({ ...theirs, hosts: [...theirs.hosts, { id: 'odd' }, null] }));
  assert.deepEqual(await savedHosts(source), theirs.hosts, 'an entry without a connection is passed over');
  await writeFile(source, '{"version":1}');
  await assert.rejects(savedHosts(source), /Invalid remote agent registry/);
});
