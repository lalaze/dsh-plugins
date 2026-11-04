import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RemoteError } from '../src/core/domain.js';
import { claudeTitle, TuiSessions, tuiClaudeSession } from '../src/workspace/tui.js';
import { fixture } from './fakes.js';

const signal = new AbortController().signal, record = (type: string, field: string, value: string) => JSON.stringify({ type, [field]: value, sessionId: 'x' });
async function setup(t: Parameters<typeof fixture>[0], blank: boolean | undefined = true) {
  const f = await fixture(t), events: [string, unknown][] = [], titles: string[] = [], remote = { records: '', reads: [] as string[] };
  const tui = new TuiSessions(f.store, {
    verify: async id => { if (id === 'local') throw new RemoteError('Not a remote workspace', 409); },
    session: id => (id === 'closed' ? undefined : { append: (type, data) => { events.push([type, data]); } }),
    list: async () => (blank === undefined ? [] : [{ sessionId: 'remote', blank }]),
    rename: async (_id, title) => { titles.push(title); },
    titleRecords: async (_id, claudeSession) => { remote.reads.push(claudeSession); return remote.records; },
  });
  return { f, tui, events, titles, remote };
}

test('starting a TUI records it and gives DSH the turn it needs to show the conversation', async t => {
  const { tui, events, titles } = await setup(t);
  await tui.start('remote', {}, signal);
  assert.deepEqual(tui.list(), ['remote']);
  assert.deepEqual(events, [['turn/start', { turn: 1 }], ['turn/end', { turn: 1, reason: { kind: 'completed' } }]]);
  assert.deepEqual(titles, ['Claude Code']);
  await tui.start('remote', {}, signal);
  assert.equal(events.length, 2, 'starting it again changes nothing');
});

test('a TUI remembers the Claude model and effort chosen in the composer', async t => {
  const { f, tui } = await setup(t);
  await tui.start('remote', { model: 'project-1/claude/opus%5B1m%5D', effort: 'high' }, signal);
  assert.deepEqual(f.store.snapshot().tuiDetails?.remote, { title: 'Claude Code', model: 'opus[1m]', effort: 'high' });
});

test('a value that could break out of the remote command line, or another CLI\'s model, is left out', async t => {
  const { f, tui } = await setup(t);
  await tui.start('remote', { model: 'project-1/claude/a%22%3Brm', effort: 'high; rm' }, signal);
  assert.deepEqual(f.store.snapshot().tuiDetails?.remote, { title: 'Claude Code' });
  const other = await setup(t, undefined);
  await other.tui.start('remote', { model: 'project-1/codex/gpt-5', effort: 'high' }, signal);
  assert.deepEqual(other.f.store.snapshot().tuiDetails?.remote, { title: 'Claude Code', effort: 'high' });
});

test('a new DSH session not listed yet can start too', async t => {
  const { tui } = await setup(t, undefined);
  await tui.start('remote', {}, signal);
  assert.deepEqual(tui.list(), ['remote']);
});

test('a TUI starts only in a new, open conversation of a verified remote workspace', async t => {
  const { tui, events } = await setup(t, false);
  await assert.rejects(tui.start('local', {}, signal), /Not a remote workspace/);
  await assert.rejects(tui.start('closed', {}, signal), /not open/);
  await assert.rejects(tui.start('remote', {}, signal), /Only a new conversation/);
  assert.deepEqual(tui.list(), []); assert.deepEqual(events, []);
});

test('the Claude session of a conversation does not change between versions', () => {
  // Released in 0.2.81: changing it would start existing TUI conversations over.
  assert.equal(tuiClaudeSession('session-918c1aab-81fd-4ec5-8851-a72e800696e7'), '007afdc5-8160-4f78-8ee2-5d53316859eb');
});

test('Claude Code\'s title is read from its records, and /rename wins', () => {
  assert.equal(claudeTitle(''), undefined);
  assert.equal(claudeTitle('not json\n{"type":"user"}'), undefined);
  assert.equal(claudeTitle(record('ai-title', 'aiTitle', 'Fix login')), 'Fix login');
  assert.equal(claudeTitle(`${record('ai-title', 'aiTitle', 'Fix login')}\n${record('custom-title', 'customTitle', 'Mine')}`), 'Mine');
  assert.equal(claudeTitle(record('ai-title', 'aiTitle', 'x'.repeat(200)))?.length, 120);
});

test('without a title from Claude Code, the first prompt titles the conversation, as in DSH\'s other conversations', () => {
  const prompt = (text: string | null) => JSON.stringify({ type: 'last-prompt', lastPrompt: text, sessionId: 'x' });
  assert.equal(claudeTitle(`${prompt('hello')}\n${prompt('你在什么目录？')}`), 'hello', 'the first one, not the latest');
  assert.equal(claudeTitle(`${prompt(null)}\n${prompt('  fix\n the   login ')}`), 'fix the login', 'a record without text is skipped');
  assert.equal(claudeTitle(`${prompt('/model')}\n${prompt('hello')}`), 'hello', 'a slash command says nothing about the conversation');
  assert.equal(claudeTitle(prompt('x'.repeat(200)))?.length, 80);
  assert.equal(claudeTitle(`${prompt('hello')}\n${record('ai-title', 'aiTitle', 'Greeting')}`), 'Greeting', 'Claude\'s own title wins once it writes one');
  assert.equal(claudeTitle(`${prompt('hello')}\n${record('ai-title', 'aiTitle', 'Greeting')}\n${record('custom-title', 'customTitle', 'Mine')}`), 'Mine');
});

test('a conversation follows Claude Code\'s title until it is renamed in DSH', async t => {
  const { tui, titles, remote } = await setup(t);
  await tui.start('remote', {}, signal); titles.length = 0;
  assert.equal(await tui.syncTitle('remote', 'Claude Code', signal), undefined, 'no title yet');
  remote.records = record('ai-title', 'aiTitle', 'Fix login');
  assert.equal(await tui.syncTitle('remote', 'Claude Code', signal), 'Fix login');
  assert.deepEqual(remote.reads.at(-1), tuiClaudeSession('remote'));
  assert.equal(await tui.syncTitle('remote', 'Fix login', signal), undefined, 'unchanged');
  remote.records = record('ai-title', 'aiTitle', 'Fix login timeout');
  assert.equal(await tui.syncTitle('remote', 'Fix login', signal), 'Fix login timeout');
  assert.deepEqual(titles, ['Fix login', 'Fix login timeout']);
  const reads = remote.reads.length;
  assert.equal(await tui.syncTitle('remote', 'My name', signal), undefined, 'renamed in DSH');
  assert.equal(remote.reads.length, reads, 'and nothing is read from the machine');
  assert.equal(await tui.syncTitle('unknown', undefined, signal), undefined, 'not a TUI conversation');
});

test('a prompt title gives way to Claude Code\'s own when it arrives', async t => {
  const { tui, titles, remote } = await setup(t);
  await tui.start('remote', {}, signal); titles.length = 0;
  const prompt = JSON.stringify({ type: 'last-prompt', lastPrompt: 'hello', sessionId: 'x' });
  remote.records = prompt;
  assert.equal(await tui.syncTitle('remote', 'Claude Code', signal), 'hello');
  remote.records = `${prompt}\n${record('ai-title', 'aiTitle', 'Greeting')}`;
  assert.equal(await tui.syncTitle('remote', 'hello', signal), 'Greeting');
  assert.deepEqual(titles, ['hello', 'Greeting']);
});

test('the title 0.2.81 gave a conversation is replaced', async t => {
  const { tui, titles, remote } = await setup(t);
  await tui.start('remote', {}, signal); titles.length = 0;
  remote.records = record('ai-title', 'aiTitle', 'Fix login');
  assert.equal(await tui.syncTitle('remote', 'Claude TUI 03:04', signal), 'Fix login');
  assert.deepEqual(titles, ['Fix login']);
});
