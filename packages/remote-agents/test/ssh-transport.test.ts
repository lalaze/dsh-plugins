import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenSshTransport, type SshTransport } from '../src/core/ssh.js';
import { WorkspaceFiles } from '../src/workspace/files.js';
import type { GitBatch } from '../src/workspace/domain.js';

const supported = process.platform !== 'win32';

/** A stand-in for ssh that records its arguments and runs the remote command with a local shell. */
async function fakeSsh(t: TestContext) {
  // Short: control socket paths must fit the platform's Unix socket limit.
  const root = await mkdtemp('/tmp/dsh-ssh-'); t.after(() => rm(root, { recursive: true, force: true }));
  const ssh = join(root, 'ssh'), log = join(root, 'argv.jsonl');
  await writeFile(ssh, `#!${process.execPath}
const { appendFileSync } = require('node:fs'), { spawn } = require('node:child_process');
appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');
const child = spawn('/bin/sh', ['-c', process.argv.at(-1)], { stdio: 'inherit', env: { ...process.env, SHELL: '/bin/sh' } });
child.on('exit', code => process.exit(code ?? 1));
`, { mode: 0o755 });
  const calls = async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[]);
  return { root, ssh, calls };
}
/** The value of each `-o name=value` option before the destination. */
function options(argv: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < argv.length && argv[i] !== '--'; i++) if (argv[i] === '-o') { const [name, ...value] = argv[++i].split('='); result[name] = value.join('='); }
  return result;
}

test('every SSH connection notices a dead network and shares one connection per host', { skip: !supported }, async t => {
  const { root, ssh, calls } = await fakeSsh(t), directory = join(root, 'state', 'ssh');
  const transport = new OpenSshTransport('ssh://builder@example.test:2222', ssh, { controlDirectory: directory });
  assert.equal(await transport.exec('printf ok', 20_000, { login: false }), 'ok');
  assert.equal(await transport.exec('printf again'), 'again');
  const [first, second] = await calls();
  const set = options(first);
  assert.equal(set.ServerAliveInterval, '15'); assert.equal(set.ServerAliveCountMax, '3');
  assert.equal(set.ControlMaster, 'auto'); assert.equal(set.ControlPersist, '60');
  assert.ok(set.ControlPath.startsWith(`${directory}/`), 'the socket lives in the private directory');
  assert.deepEqual(options(second), set, 'login and non-login commands share the connection');
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.deepEqual(first.slice(first.indexOf('--') + 1, -1), ['builder@example.test']);

  // Another host has a socket of its own.
  const other = new OpenSshTransport('ssh://builder@other.test', ssh, { controlDirectory: directory });
  await other.exec('true', 20_000, { login: false });
  assert.notEqual(options((await calls())[2]).ControlPath, set.ControlPath);
});

test('connection sharing is left off where ssh could not use the socket safely', { skip: !supported }, async t => {
  const { root, ssh, calls } = await fakeSsh(t);
  // Without a directory: keepalive only.
  await new OpenSshTransport('ssh://host.test', ssh).exec('true', 20_000, { login: false });
  // Too long for a Unix socket path once ssh adds its temporary suffix.
  await new OpenSshTransport('ssh://host.test', ssh, { controlDirectory: join(root, 'x'.repeat(80)) }).exec('true', 20_000, { login: false });
  // A path ssh would expand or split.
  await new OpenSshTransport('ssh://host.test', ssh, { controlDirectory: join(root, 'with space') }).exec('true', 20_000, { login: false });
  for (const argv of await calls()) {
    const set = options(argv);
    assert.equal(set.ServerAliveInterval, '15');
    assert.equal(set.ControlMaster, undefined); assert.equal(set.ControlPath, undefined);
  }
  // A directory others can read is made private before its socket is used.
  const open = join(root, 'open'); await mkdir(open); await chmod(open, 0o755);
  await new OpenSshTransport('ssh://host.test', ssh, { controlDirectory: open }).exec('true', 20_000, { login: false });
  assert.equal((await stat(open)).mode & 0o777, 0o700);
  assert.ok(options((await calls()).at(-1)!).ControlPath?.startsWith(`${open}/`));
});

test('command output split inside a character is decoded intact', { skip: !supported }, async t => {
  const { ssh } = await fakeSsh(t), transport = new OpenSshTransport('ssh://host.test', ssh);
  // 中 is E4 B8 AD: the pause makes ssh deliver its bytes in two reads.
  assert.equal(await transport.exec(`printf '\\344\\270'; sleep 0.2; printf '\\255文\\n'`, 20_000, { login: false }), '中文\n');
  await assert.rejects(transport.exec(`printf '\\344\\270' >&2; sleep 0.2; printf '\\255错误' >&2; exit 3`, 20_000, { login: false }), /^Error: 中错误$/);
});

/** Records whether each workspace request loads the login shell, answering as an empty success. */
function recorder() {
  const requests: { op: string; login: boolean | undefined; script: string }[] = [];
  const transport: SshTransport = {
    exec: async () => '', start: () => { throw new Error('unused'); },
    async transfer(script, options) {
      const op = /^dsh_op='([^']*)'$/m.exec(script)?.[1] ?? '', count = Number(/^dsh_count='(\d+)'$/m.exec(script)?.[1] ?? 0);
      requests.push({ op, login: options.login, script });
      if (op === 'command') return Buffer.from('ok\n0 0 0 0\n');
      if (op === 'git') return Buffer.from(`ok\n${'0 0 0 0\n'.repeat(count)}`);
      if (op === 'stat') return Buffer.from(`ok\n${'a'.repeat(64)} 0`);
      return Buffer.from('ok\n');
    },
  };
  return { requests, files: new WorkspaceFiles(transport) };
}
const batch = (optionalLocks: boolean, ...commands: string[][]): GitBatch => ({ id: crypto.randomUUID(), commands: commands.map(argv => ({ argv, timeoutMs: 10_000 })), maxBytes: 1000, optionalLocks });

test('file requests and Git reads skip the login shell; commands and other Git requests keep it', async () => {
  const { requests, files } = recorder(), cwd = '/srv/app';
  await files.operate(cwd, { op: 'list', path: '' });
  await files.operate(cwd, { op: 'read', path: 'a.txt' });
  await files.operate(cwd, { op: 'stat', path: 'a.txt' });
  await files.operate(cwd, { op: 'mkdir', path: 'new' });
  await files.operate(cwd, { op: 'search', path: '', query: 'needle' });
  await files.operate(cwd, { op: 'command', path: '', command: 'make test' });
  await files.git(cwd, batch(false, ['rev-parse', '--show-toplevel'], ['-c', 'core.quotepath=false', 'status', '--porcelain=v1', '-z']));
  await files.git(cwd, batch(false, ['ls-remote', '--get-url']));
  await files.git(cwd, batch(false, ['fetch', '--prune']));
  await files.git(cwd, batch(false, ['ls-remote', 'origin']));
  await files.git(cwd, batch(true, ['status']));
  await files.git(cwd, batch(true, ['commit', '-m', 'x']));
  await files.cancelGit(cwd, crypto.randomUUID());
  assert.deepEqual(requests.map(r => `${r.op}:${r.login}`), [
    'list:false', 'read:false', 'stat:false', 'mkdir:false', 'search:false', 'command:true',
    'git:false', 'git:false', 'git:true', 'git:true', 'git:true', 'git:true', 'gitCancel:false',
  ]);
  // Without the login shell, the usual tool directories are still searched.
  for (const request of requests) assert.equal(request.script.includes('\nPATH="$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"; export PATH\n'), !request.login, request.op);
});
