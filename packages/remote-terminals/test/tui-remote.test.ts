import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenSshTransport, type SshTransport } from '@dsh-plugins/remote-core/ssh.js';
import { antigravityTitle, codexTitle, CODEX_THREAD_NAME } from '../src/tui.js';
import { ANTIGRAVITY_SIGN_IN, ANTIGRAVITY_SIGN_IN_HERE, TuiRemote } from '../src/tui-remote.js';

/** A machine's TUI commands, over its connection. */
const tui = (files: { transport: SshTransport }) => new TuiRemote(files.transport);

class LocalTransport extends OpenSshTransport {
  constructor(private readonly home: string, private readonly path = process.env.PATH) { super('ssh://test.invalid'); }
  protected override spawnRemote(command: string): ChildProcessWithoutNullStreams {
    return spawn('/bin/sh', ['-c', command], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, SHELL: '/bin/sh', HOME: this.home, PATH: this.path } });
  }
}
/** A home folder that the commands run in as if it were the machine's. */
async function directory(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-remote-terminals-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, files: { transport: new LocalTransport(root) as SshTransport } };
}

function codexServer(answers: Record<string, unknown>, path = '/usr/bin/codex') {
  const sent: { id?: unknown; method?: string; params?: unknown; error?: unknown }[] = [], state = { stopped: 0, started: undefined as { cwd: string; argv: string[] } | undefined };
  let deliver: (data: Buffer) => void = () => {};
  const line = (value: unknown) => setImmediate(() => deliver(Buffer.from(`${JSON.stringify(value)}\n`)));
  const transport: SshTransport = {
    exec: async () => path,
    start: (cwd, argv) => {
      state.started = { cwd, argv };
      return {
        write(value) {
          const message = JSON.parse(value) as { id?: string; method?: string }; sent.push(message);
          if (message.method === 'thread/start') line({ id: 'server-1', method: 'item/tool/requestUserInput', params: {} });
          if (message.id !== undefined && message.method && message.method in answers) line({ id: message.id, result: answers[message.method] });
        },
        stop() { state.stopped += 1; }, onData(callback) { deliver = callback; }, onExit() {},
      };
    },
  };
  return { files: { transport }, sent, state };
}

const THREAD = '01a1a960-0696-7481-b86c-ea7a878c6479';

test('a Codex thread is started on the app server and saved by naming it, as nothing else saves one without a message', async () => {
  const { files, sent, state } = codexServer({ initialize: {}, 'thread/start': { thread: { id: THREAD } }, 'thread/name/set': {} });
  assert.equal(await tui(files).codexThread('/srv/app', 'DSH TUI', new AbortController().signal), THREAD);
  assert.deepEqual(state.started, { cwd: '/srv/app', argv: ['/usr/bin/codex', 'app-server'] });
  assert.deepEqual(sent.map(message => message.method ?? `reply ${message.id}`), ['initialize', 'initialized', 'thread/start', 'reply server-1', 'thread/name/set']);
  assert.deepEqual(sent.find(message => message.method === 'thread/start')?.params, { cwd: '/srv/app' });
  assert.deepEqual(sent.find(message => message.method === 'thread/name/set')?.params, { threadId: THREAD, name: 'DSH TUI' });
  assert.ok(sent.find(message => message.id === 'server-1')?.error, 'whatever it asks is refused, as this connection runs nothing');
  assert.equal(state.stopped, 1, 'the app server goes away afterwards');
});

test('starting a Codex thread reports a missing CLI or a bad answer, and leaves no app server behind', async () => {
  const signal = new AbortController().signal;
  const missing = codexServer({}, '');
  await assert.rejects(tui(missing.files).codexThread('/srv/app', 'x', signal), /Codex is not installed/);
  assert.equal(missing.state.started, undefined);
  const odd = codexServer({ initialize: {}, 'thread/start': { thread: { id: '$(touch x)' } } });
  await assert.rejects(tui(odd.files).codexThread('/srv/app', 'x', signal), /did not start a thread/);
  assert.equal(odd.sent.some(message => message.method === 'thread/name/set'), false, 'an odd ID goes no further');
  assert.equal(odd.state.stopped, 1);
  const controller = new AbortController(), silent = codexServer({ initialize: {} });
  const started = tui(silent.files).codexThread('/srv/app', 'x', controller.signal);
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(started, /closed/);
  assert.ok(silent.state.stopped >= 1, 'giving up closes it');
});

test('a Codex thread\'s title records come from the name index and its own record file, on the real shell', async t => {
  const d = await directory(t), other = '01a1a95c-463c-7df3-8065-26d0933aeb53', sessions = join(d.root, '.codex/sessions/2026/11/04');
  await mkdir(sessions, { recursive: true });
  const message = (text: string) => JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text }] } } });
  await writeFile(join(sessions, `rollout-2026-11-04T20-39-19-${THREAD}.jsonl`), [JSON.stringify({ type: 'session_meta', payload: { id: THREAD } }), message('Fix the login'), message('Second')].join('\n'));
  await writeFile(join(sessions, `rollout-2026-11-04T20-40-00-${other}.jsonl`), message('Another thread'));
  assert.equal(codexTitle(await tui(d.files).codexTitleRecords(THREAD)), 'Fix the login', 'no index yet');
  const index = (id: string, name: string) => JSON.stringify({ id, thread_name: name, updated_at: 'now' });
  await writeFile(join(d.root, '.codex/session_index.jsonl'), [index(THREAD, CODEX_THREAD_NAME), index(other, 'Theirs')].join('\n'));
  assert.equal(codexTitle(await tui(d.files).codexTitleRecords(THREAD)), 'Fix the login');
  await writeFile(join(d.root, '.codex/session_index.jsonl'), [index(THREAD, CODEX_THREAD_NAME), index(other, 'Theirs'), index(THREAD, 'Login work')].join('\n'));
  assert.equal(codexTitle(await tui(d.files).codexTitleRecords(THREAD)), 'Login work', 'the newest name wins');
  assert.equal(codexTitle(await tui(d.files).codexTitleRecords('01a1a95c-0000-7df3-8065-26d0933aeb53')), undefined, 'a thread that is gone has none');
  assert.throws(() => tui(d.files).codexTitleRecords('$(touch x)'), /Invalid Codex thread/);
});

/** Antigravity's ACP server, answering each method from `answers`, or with the error in `errors`. */
function acpServer(answers: Record<string, unknown>, errors: Record<string, string> = {}, path = '/usr/local/bin/agy') {
  const sent: { id?: unknown; method?: string; params?: unknown; error?: unknown }[] = [], state = { stopped: 0, started: undefined as { cwd: string; argv: string[] } | undefined };
  let deliver: (data: Buffer) => void = () => {};
  const line = (value: unknown) => setImmediate(() => deliver(Buffer.from(`${JSON.stringify(value)}\n`)));
  const transport: SshTransport = {
    exec: async () => path,
    start: (cwd, argv) => {
      state.started = { cwd, argv };
      return {
        write(value) {
          const message = JSON.parse(value) as { id?: string; method?: string }; sent.push(message);
          if (message.method === 'session/new') line({ id: 'agent-1', method: 'session/request_permission', params: {} });
          if (message.id === undefined || !message.method) return;
          if (message.method in errors) line({ id: message.id, error: { code: -32000, message: errors[message.method] } });
          else if (message.method in answers) line({ id: message.id, result: answers[message.method] });
        },
        stop() { state.stopped += 1; }, onData(callback) { deliver = callback; }, onExit() {},
      };
    },
  };
  return { files: { transport }, sent, state };
}
const CONVERSATION = 'f07744bd-6fff-40a9-9b40-d1ff3c5ccb69';

test('an Antigravity conversation is made on its ACP server and closed there, which lets the interactive CLI run turns in it', async () => {
  const { files, sent, state } = acpServer({ initialize: { protocolVersion: 1 }, 'session/new': { sessionId: CONVERSATION }, 'session/close': {} });
  assert.equal(await tui(files).antigravityConversation('/srv/app', new AbortController().signal), CONVERSATION);
  assert.deepEqual(state.started, { cwd: '/srv/app', argv: ['/usr/local/bin/agy', 'acp'] });
  assert.deepEqual(sent.map(message => message.method ?? `reply ${message.id}`), ['initialize', 'session/new', 'reply agent-1', 'session/close']);
  assert.deepEqual(sent.find(message => message.method === 'session/new')?.params, { cwd: '/srv/app', mcpServers: [] });
  assert.deepEqual(sent.find(message => message.method === 'session/close')?.params, { sessionId: CONVERSATION });
  assert.ok(sent.find(message => message.id === 'agent-1')?.error, 'whatever it asks is refused, as this connection runs nothing');
  assert.equal(state.stopped, 1, 'the ACP server goes away afterwards');
});

test('making an Antigravity conversation reports a missing CLI, a missing sign-in or a bad answer, and leaves no server behind', async () => {
  const signal = new AbortController().signal;
  const missing = acpServer({}, {}, '');
  await assert.rejects(tui(missing.files).antigravityConversation('/srv/app', signal), /Antigravity is not installed/);
  assert.equal(missing.state.started, undefined);
  const out = acpServer({ initialize: { protocolVersion: 1 } }, { 'session/new': 'Authentication required' });
  await assert.rejects(tui(out.files).antigravityConversation('/srv/app', signal), (error: Error) => error.message === ANTIGRAVITY_SIGN_IN);
  assert.equal(out.state.stopped, 1);
  // On this computer Antigravity reads the keychain, so the sign-in to repeat is a local one, not the SSH one.
  const here = acpServer({ initialize: { protocolVersion: 1 } }, { 'session/new': 'Authentication required' });
  await assert.rejects(tui(here.files).antigravityConversation('/srv/app', signal, true), (error: Error) => error.message === ANTIGRAVITY_SIGN_IN_HERE && !/Over SSH/.test(error.message));
  const odd = acpServer({ initialize: { protocolVersion: 1 }, 'session/new': { sessionId: '$(touch x)' } });
  await assert.rejects(tui(odd.files).antigravityConversation('/srv/app', signal), /did not start a conversation/);
  assert.equal(odd.sent.some(message => message.method === 'session/close'), false, 'an odd ID goes no further');
  assert.equal(odd.state.stopped, 1);
  const other = acpServer({ initialize: { protocolVersion: 1 } }, { 'session/new': 'Workspace is not trusted' });
  await assert.rejects(tui(other.files).antigravityConversation('/srv/app', signal), /Workspace is not trusted/, 'other errors are passed on as they are');
});

const commandPath = (name: string) => { try { return execFileSync('/bin/sh', ['-c', `command -v ${name}`]).toString().trim(); } catch { return ''; } };
/** An Antigravity summary database in a home folder, as Antigravity 1.5.9 lays it out, with only the columns read. */
async function antigravityHome(t: TestContext, rows: [string, string, string][]) {
  const d = await directory(t), folder = join(d.root, '.gemini/antigravity-cli');
  await mkdir(folder, { recursive: true });
  const sql = (value: string) => `'${value.replaceAll("'", "''")}'`;
  execFileSync(commandPath('sqlite3'), [join(folder, 'conversation_summaries.db'), ['create table conversation_summaries (conversation_id text primary key, title text not null default "", preview text not null default "")',
    ...rows.map(([id, title, preview]) => `insert into conversation_summaries values (${sql(id)}, ${sql(title)}, ${sql(preview)})`)].join('; ')]);
  return d;
}

test('an Antigravity conversation\'s title comes from its summary database through sqlite3, on the real shell', { skip: !commandPath('sqlite3') && 'no sqlite3 here' }, async t => {
  const d = await antigravityHome(t, [[CONVERSATION, 'Say Ping Request', 'Say Ping Request'], ['01a1a95c-0000-4df3-8065-26d0933aeb53', '', 'Reply with\nexactly hello'], ['01a1a95c-1111-4df3-8065-26d0933aeb53', "It's 'quoted'", '']]);
  assert.equal(antigravityTitle(await tui(d.files).antigravityTitleRecords(CONVERSATION)), 'Say Ping Request');
  assert.equal(await tui(d.files).antigravityTitleRecords('01a1a95c-0000-4df3-8065-26d0933aeb53'), '\nReply with exactly hello\n', 'a line break stays inside its line');
  assert.equal(antigravityTitle(await tui(d.files).antigravityTitleRecords('01a1a95c-1111-4df3-8065-26d0933aeb53')), "It's 'quoted'");
  assert.equal(await tui(d.files).antigravityTitleRecords('01a1a95c-2222-4df3-8065-26d0933aeb53'), '', 'one not summarized yet has none');
  const empty = await directory(t);
  assert.equal(await tui(empty.files).antigravityTitleRecords(CONVERSATION), '', 'nor a machine without Antigravity');
  assert.throws(() => tui(d.files).antigravityTitleRecords("' or 1=1 --"), /Invalid Antigravity conversation/);
});

test('without the sqlite3 command the title is read through Python', { skip: (!commandPath('sqlite3') || !commandPath('python3')) && 'needs sqlite3 to build the database and python3 to read it' }, async t => {
  const d = await antigravityHome(t, [[CONVERSATION, '测试 agy 行', '测试 agy 行']]);
  const bin = join(d.root, 'bin'); await mkdir(bin);
  await symlink(commandPath('python3'), join(bin, 'python3'));
  const pythonOnly = { transport: new LocalTransport(d.root, bin) as SshTransport };
  assert.equal(antigravityTitle(await tui(pythonOnly).antigravityTitleRecords(CONVERSATION)), '测试 agy 行');
});
