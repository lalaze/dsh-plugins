import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, mkdtemp, mkdir, stat, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenSshTransport, type SshTransport } from '@dsh-plugins/remote-core/ssh.js';
import { codexTitle, CODEX_THREAD_NAME } from '../src/tui.js';
import { TuiRemote } from '../src/tui-remote.js';

/** A machine's TUI commands, over its connection. */
const tui = (files: { transport: SshTransport }) => new TuiRemote(files.transport);

class LocalTransport extends OpenSshTransport {
  constructor(private readonly home: string) { super('ssh://test.invalid'); }
  protected override spawnRemote(command: string): ChildProcessWithoutNullStreams {
    return spawn('/bin/sh', ['-c', command], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, SHELL: '/bin/sh', HOME: this.home } });
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

test('the TUI conversations listed on a machine are read back as written, newest first, and a name is only ever a holder\'s', async t => {
  const { root, files } = await directory(t), remote = tui(files);
  assert.equal(await remote.sharedTuis(), '', 'none before the first one is listed');
  const first = 'tui-' + '1'.repeat(32), second = 'tui-' + '2'.repeat(32);
  const record = (title: string) => JSON.stringify({ v: 1, key: 'k', cli: 'claude', cwd: "/srv/it's here", title });
  await remote.putSharedTui(first, record('one $(touch pwned) `id` \\n "quoted"'));
  await remote.putSharedTui(second, record('二号'));
  await remote.putSharedTui(first, record('one again'));
  // What something else left in the folder is not a record.
  await writeFile(join(root, '.dsh-remote-agents/tui-v1/notes.txt'), 'not a record\n');
  await writeFile(join(root, '.dsh-remote-agents/tui-v1/.put.left'), 'half written');
  assert.deepEqual((await remote.sharedTuis()).split('\n').filter(Boolean).sort(), [record('one again'), record('二号')].sort());
  assert.equal((await stat(join(root, '.dsh-remote-agents/tui-v1', `${first}.json`))).mode & 0o777, 0o600, 'for this account only');
  await assert.rejects(access(join(root, 'pwned')), 'nothing in a record runs');
  await assert.rejects(remote.putSharedTui('../../.ssh/authorized_keys', record('x')), /Invalid TUI conversation/);
  await assert.rejects(remote.putSharedTui(first, 'two\nlines'), /Invalid TUI conversation record/);
  await assert.rejects(remote.putSharedTui(first, 'x'.repeat(5000)), /Invalid TUI conversation record/);
});
