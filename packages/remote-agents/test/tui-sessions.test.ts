import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RemoteError } from '../src/core/domain.js';
import { claudeTitle, CODEX_THREAD_NAME, codexTitle, TuiSessions, tuiClaudeSession } from '../src/workspace/tui.js';
import { fixture } from './fakes.js';

const THREAD = '01a1a960-0696-7481-b86c-ea7a878c6479';
const signal = new AbortController().signal, record = (type: string, field: string, value: string) => JSON.stringify({ type, [field]: value, sessionId: 'x' });
async function setup(t: Parameters<typeof fixture>[0], blank: boolean | undefined = true) {
  const f = await fixture(t), events: [string, unknown][] = [], titles: string[] = [], remote = { records: '', reads: [] as string[], selections: [] as Record<string, unknown>[], selectFails: false, codexRecords: '', codexReads: [] as string[], threads: 0, threadFails: false, agent: undefined as { phase?: { kind: string; lastTurn?: number } } | undefined };
  const tui = new TuiSessions(f.store, {
    verify: async id => { if (id === 'local') throw new RemoteError('Not a remote workspace', 409); return { hostId: 'host-1' }; },
    session: id => (id === 'closed' ? undefined : { append: (type, data) => { events.push([type, data]); } }),
    agent: () => remote.agent,
    list: async () => (blank === undefined ? [] : [{ sessionId: 'remote', blank }]),
    rename: async (_id, title) => { titles.push(title); },
    selectModel: async selection => { if (remote.selectFails) throw new Error('catalog not ready'); remote.selections.push(selection); },
    titleRecords: async (_id, claudeSession) => { remote.reads.push(claudeSession); return remote.records; },
    codexThread: async () => { remote.threads += 1; if (remote.threadFails) throw new RemoteError('Codex is not installed on this SSH host', 409); return THREAD; },
    codexTitleRecords: async (_id, thread) => { remote.codexReads.push(thread); return remote.codexRecords; },
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
  assert.deepEqual(f.store.snapshot().tuiDetails?.remote, { title: 'Claude Code', model: 'opus[1m]', effort: 'high', modelRecorded: true });
});

test('starting a TUI tells DSH its model, which is what the workspace list shows an icon from', async t => {
  const { tui, events, remote } = await setup(t);
  await tui.start('remote', { model: 'project-1/claude/haiku', effort: 'high' }, signal);
  assert.deepEqual(remote.selections, [{ sessionId: 'remote', provider: 'remote-cli-claude', model: 'project-1/claude/haiku', reasoningEffort: 'high' }]);
  assert.equal(events.length, 2);
  await tui.syncTitle('remote', 'Claude Code', signal);
  assert.equal(remote.selections.length, 1, 'once');
});

test('a TUI starts even if DSH will not take the model yet, and the next title check tries again', async t => {
  const { tui, events, remote } = await setup(t);
  remote.selectFails = true;
  await tui.start('remote', { model: 'project-1/claude/haiku' }, signal);
  assert.equal(events.length, 2, 'started');
  await tui.syncTitle('remote', 'Claude Code', signal);
  assert.deepEqual(remote.selections, []);
  remote.selectFails = false;
  await tui.syncTitle('remote', 'Claude Code', signal);
  assert.deepEqual(remote.selections, [{ sessionId: 'remote', provider: 'remote-cli-claude', model: 'host-1/claude/haiku' }]);
});

test('a conversation started by an earlier version gets its model when it is next in view, even if renamed', async t => {
  const { f, tui, remote } = await setup(t);
  await f.store.update(state => { state.tuiSessions = ['old', 'renamed']; state.tuiDetails = { renamed: { title: 'Claude Code', model: 'opus[1m]', effort: 'xhigh' } }; });
  await tui.syncTitle('old', 'Claude TUI 03:04', signal);
  await tui.syncTitle('renamed', 'My name', signal);
  assert.deepEqual(remote.selections, [
    { sessionId: 'old', provider: 'remote-cli-claude', model: 'host-1/claude/default' },
    { sessionId: 'renamed', provider: 'remote-cli-claude', model: 'host-1/claude/opus%5B1m%5D', reasoningEffort: 'xhigh' },
  ]);
  assert.deepEqual(remote.reads.includes(tuiClaudeSession('renamed')), false, 'a renamed conversation\'s title is still left alone');
  const reads = remote.reads.length;
  await tui.syncTitle('renamed', 'My name', signal);
  assert.equal(remote.selections.length, 2); assert.equal(remote.reads.length, reads);
});

test('a value that could break out of the remote command line, or another CLI\'s model, is left out', async t => {
  const { f, tui } = await setup(t);
  await tui.start('remote', { model: 'project-1/claude/a%22%3Brm', effort: 'high; rm' }, signal);
  assert.deepEqual(f.store.snapshot().tuiDetails?.remote, { title: 'Claude Code', modelRecorded: true });
  const other = await setup(t, undefined);
  await other.tui.start('remote', { model: 'project-1/codex/gpt-5', effort: 'high' }, signal);
  assert.deepEqual(other.f.store.snapshot().tuiDetails?.remote, { title: 'Claude Code', effort: 'high', modelRecorded: true });
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

const codexMessage = (...text: string[]) => JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: text.map(value => ({ type: 'text', text: value })) } } });
const codexName = (name: string) => JSON.stringify({ id: THREAD, thread_name: name, updated_at: '2026-11-05T01:39:19Z' });

test('a Codex conversation starts its thread first and remembers it, with its model and effort', async t => {
  const { f, tui, events, titles, remote } = await setup(t);
  await tui.start('remote', { cli: 'codex', model: 'project-1/codex/gpt-6.1-sol', effort: 'xhigh' }, signal);
  assert.equal(remote.threads, 1);
  assert.deepEqual(f.store.snapshot().tuiDetails?.remote, { title: 'Codex', cli: 'codex', thread: THREAD, model: 'gpt-6.1-sol', effort: 'xhigh', modelRecorded: true });
  assert.deepEqual(tui.list(), ['remote']);
  assert.deepEqual(tui.codex(), ['remote']);
  assert.equal(events.length, 2);
  assert.deepEqual(titles, ['Codex']);
  assert.deepEqual(remote.selections, [{ sessionId: 'remote', provider: 'remote-cli-codex', model: 'project-1/codex/gpt-6.1-sol', reasoningEffort: 'xhigh' }], 'the row gets Codex\'s icon');
  await tui.start('remote', { cli: 'codex' }, signal);
  assert.equal(remote.threads, 1, 'starting it again makes no second thread');
});

test('a Codex conversation that cannot get a thread records nothing, so it can be started again', async t => {
  const { f, tui, events, titles, remote } = await setup(t);
  remote.threadFails = true;
  await assert.rejects(tui.start('remote', { cli: 'codex' }, signal), /not installed/);
  assert.deepEqual(tui.list(), []);
  assert.equal(f.store.snapshot().tuiDetails?.remote, undefined);
  assert.deepEqual([events, titles], [[], []]);
  remote.threadFails = false;
  await tui.start('remote', { cli: 'codex' }, signal);
  assert.deepEqual(tui.codex(), ['remote']);
});

test('each CLI takes only its own model, and anything but Codex is Claude Code', async t => {
  const { f, tui, remote } = await setup(t);
  await tui.start('remote', { cli: 'codex', model: 'project-1/claude/opus' }, signal);
  assert.equal(f.store.snapshot().tuiDetails?.remote?.model, undefined);
  const other = await setup(t);
  await other.tui.start('remote', { cli: 'grok', model: 'project-1/claude/opus' }, signal);
  assert.equal(other.f.store.snapshot().tuiDetails?.remote?.model, 'opus');
  assert.equal(other.f.store.snapshot().tuiDetails?.remote?.cli, undefined);
  assert.deepEqual(other.tui.codex(), []);
  assert.equal(other.remote.threads, 0);
  assert.equal(remote.threads, 1);
});

test('a Codex thread titles the conversation by its /rename, then its first prompt', () => {
  assert.equal(codexTitle(''), undefined);
  assert.equal(codexTitle(codexName(CODEX_THREAD_NAME)), undefined, 'the name it started with says nothing');
  assert.equal(codexTitle([codexName(CODEX_THREAD_NAME), codexMessage('Fix  the\nlogin'), codexMessage('later')].join('\n')), 'Fix the login');
  assert.equal(codexTitle([codexName('Login work'), codexMessage('Fix the login')].join('\n')), 'Login work');
  assert.equal(codexTitle(codexMessage('/srv/app/a.png what is this')), undefined, 'a dropped path says nothing');
  assert.equal(codexTitle([codexMessage('/srv/app/a.png'), codexMessage('Second message')].join('\n')), 'Second message');
  assert.equal(codexTitle(codexMessage('x'.repeat(200)))?.length, 80);
  assert.equal(codexTitle(['not json', JSON.stringify({ payload: { item: { type: 'UserMessage', content: 'odd' } } }), codexMessage('Fine')].join('\n')), 'Fine');
});

test('a Codex conversation follows its thread and leaves a DSH rename alone, and never reads Claude Code', async t => {
  const { tui, titles, remote } = await setup(t);
  await tui.start('remote', { cli: 'codex' }, signal);
  remote.codexRecords = [codexName(CODEX_THREAD_NAME), codexMessage('Fix the login')].join('\n');
  assert.equal(await tui.syncTitle('remote', 'Codex', signal), 'Fix the login');
  assert.deepEqual(remote.codexReads, [THREAD]);
  assert.deepEqual(remote.reads, []);
  assert.deepEqual(titles, ['Codex', 'Fix the login']);
  assert.equal(await tui.syncTitle('remote', 'Fix the login', signal), undefined, 'unchanged');
  remote.codexRecords = [codexName('Login work'), codexMessage('Fix the login')].join('\n');
  assert.equal(await tui.syncTitle('remote', 'Fix the login', signal), 'Login work');
  assert.equal(await tui.syncTitle('remote', 'My own title', signal), undefined, 'renamed in DSH');
  assert.deepEqual(titles.at(-1), 'Login work');
});

test('starting a TUI tells a live agent about its turn, as a real one numbered the same would corrupt the log', async t => {
  const { tui, remote } = await setup(t);
  remote.agent = { phase: { kind: 'idle', lastTurn: 0 } };
  await tui.start('remote', {}, signal);
  assert.equal(remote.agent.phase?.lastTurn, 1);
  const busy = await setup(t);
  busy.remote.agent = { phase: { kind: 'running' } };
  await busy.tui.start('remote', {}, signal);
  assert.equal(busy.remote.agent.phase?.lastTurn, undefined, 'a running phase is left alone');
  const none = await setup(t);
  await none.tui.start('remote', {}, signal);
  assert.equal(none.events.length, 2, 'and no agent is no problem');
});

test('a title cut from a prompt ends in no space', () => {
  assert.equal(codexTitle(codexMessage(`${'x'.repeat(79)} and more`))?.length, 79, 'DSH trims titles, and a difference would read as a rename');
});

