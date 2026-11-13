import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { build } from 'esbuild';
import { attachExitCode, ATTACH_EXIT, claimsScreen, endHolderScript, HOLDERS_FOLDER, tabHolder, tuiHolder } from '../src/holder-protocol.js';
import { attachCommand, holdTerminal } from '../src/terminal-hold.js';

let python = false;
try { execFileSync('python3', ['-c', 'import pty']); python = true; } catch { /* the holder's tests need it */ }
const options = { skip: python ? false : 'needs Python 3' };

let home: string, script: string, base: string;
before(async () => {
  home = await mkdtemp(join(tmpdir(), 'holder-'));
  script = join(home, 'terminal-holder.mjs'); base = join(home, 'holders');
  await build({ entryPoints: [new URL('../src/terminal-holder.ts', import.meta.url).pathname], outfile: script, bundle: true, format: 'esm', platform: 'node', target: 'node22', logLevel: 'error',
    banner: { js: 'import{createRequire as __dshRequire}from"node:module";const require=__dshRequire(import.meta.url);' } });
});
after(() => rm(home, { recursive: true, force: true }));

let counter = 0;
const newId = () => `tab-${(++counter).toString(16).padStart(32, '0')}`;
const until = async (check: () => boolean, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (check()) return true; await new Promise(r => setTimeout(r, 20)); } return check(); };
interface Client { child: ChildProcess; output(): string; exited: Promise<number | null>; send(text: string): void }
function attach(id: string, command: string, env: NodeJS.ProcessEnv = {}): Client {
  const child = spawn(process.execPath, [script, 'attach', base, id, Buffer.from(command).toString('base64')], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  let text = '';
  child.stdout!.on('data', data => { text += data; });
  child.stderr!.on('data', data => { text += data; });
  return { child, output: () => text, exited: new Promise(resolve => child.on('close', resolve)), send: value => child.stdin!.write(value) };
}
const SHELL = 'PS1="> " exec /bin/sh';

test('a terminal outlives its client, and the next client gets its screen and modes', options, async () => {
  const id = newId();
  const first = attach(id, `printf '\\033[?25l\\033[?2004h\\033[?1006h\\033]0;a title\\007\\033]7501;state=working:app=codex\\007'; echo 中文-first; ${SHELL}`);
  assert.ok(await until(() => first.output().includes('> ')), first.output());
  first.send('echo pid=$$\n');
  assert.ok(await until(() => /pid=\d+/.test(first.output())), first.output());
  const pid = /pid=(\d+)/.exec(first.output())![1]!;
  first.child.kill('SIGKILL'); await first.exited;
  process.kill(Number(pid), 0);

  const second = attach(id, 'exit 99');
  assert.ok(await until(() => second.output().includes(`pid=${pid}`)), second.output());
  const shown = second.output();
  assert.ok(shown.startsWith('\x1bc'), 'starts from a clean terminal');
  assert.ok(shown.includes('中文-first'));
  for (const mode of ['\x1b[?25l', '\x1b[?2004h', '\x1b[?1006h', '\x1b]0;a title\x07', '\x1b]7501;state=working:app=codex\x07']) assert.ok(shown.includes(mode), JSON.stringify(mode));
  second.send('echo still=$$\n');
  assert.ok(await until(() => second.output().includes(`still=${pid}`)), second.output());
  second.send('exit 7\n');
  assert.equal(await second.exited, 7);
  assert.equal(existsSync(join(base, id)), false, 'an ended terminal leaves nothing behind');
});

test('a command is only ever started once when two clients arrive together', options, async () => {
  const id = newId(), marker = join(home, `started-${id}`);
  const command = `echo x >> ${marker}; ${SHELL}`;
  const clients = [attach(id, command), attach(id, command), attach(id, command)];
  assert.ok(await until(() => existsSync(marker)));
  await new Promise(r => setTimeout(r, 500));
  assert.equal(readFileSync(marker, 'utf8'), 'x\n');
  clients[0]!.send('echo shared\n');
  assert.ok(await until(() => clients.every(c => c.output().includes('shared'))), clients.map(c => c.output()).join('|'));
  clients[0]!.send('exit\n');
  await Promise.all(clients.map(c => c.exited));
});

test('with nobody attached the holder answers what the CLI asks the terminal', options, async () => {
  const id = newId(), answer = join(home, `answer-${id}`);
  const client = attach(id, `${SHELL}`);
  assert.ok(await until(() => client.output().includes('> ')));
  // Runs on after the client is gone: asks for the cursor position and records the reply.
  client.send(`(sleep 1; stty raw -echo; printf '\\033[6n'; dd bs=1 count=6 2>/dev/null > ${answer}; stty sane; echo done) \n`);
  await new Promise(r => setTimeout(r, 300));
  client.child.kill('SIGKILL'); await client.exited;
  assert.ok(await until(() => existsSync(answer) && statSync(answer).size >= 6), 'no answer');
  assert.match(readFileSync(answer, 'utf8'), /^\x1b\[\d+;\d/);
  process.kill(Number(readFileSync(join(base, id, 'pid'), 'utf8')), 'SIGTERM');
  assert.ok(await until(() => !existsSync(join(base, id))));
});

test('SIGTERM ends what runs in the holder', options, async () => {
  const id = newId();
  const client = attach(id, SHELL);
  client.send('echo pid=$$\n');
  assert.ok(await until(() => /pid=\d+/.test(client.output())), client.output());
  const shell = Number(/pid=(\d+)/.exec(client.output())![1]);
  const holder = Number(readFileSync(join(base, id, 'pid'), 'utf8'));
  process.kill(holder, 'SIGTERM');
  await client.exited;
  assert.ok(await until(() => { try { process.kill(shell, 0); return false; } catch { return true; } }), 'the shell is gone');
  assert.equal(existsSync(join(base, id)), false);
});

test('a holder that died, as in a restart of the machine, is replaced', options, async () => {
  const id = newId();
  const first = attach(id, `echo one; ${SHELL}`);
  assert.ok(await until(() => first.output().includes('one')));
  const holder = Number(readFileSync(join(base, id, 'pid'), 'utf8'));
  process.kill(holder, 'SIGKILL');
  assert.equal(await first.exited, ATTACH_EXIT.lost, 'the client reports the loss rather than an exit');
  const second = attach(id, `echo two; ${SHELL}`);
  assert.ok(await until(() => second.output().includes('two')), second.output());
  second.send('exit\n');
  assert.equal(await second.exited, 0);
});

test('other holders that died are cleared when a new one starts', options, async () => {
  const stale = join(base, newId()), starting = join(base, newId());
  mkdirSync(stale, { recursive: true }); writeFileSync(join(stale, 'pid'), '999999');
  mkdirSync(starting, { recursive: true });
  const client = attach(newId(), SHELL);
  assert.ok(await until(() => client.output().includes('> ')));
  assert.equal(existsSync(stale), false);
  assert.equal(existsSync(starting), true, 'may be starting at this moment');
  client.send('exit\n'); await client.exited;
});

test('a host with no usable Python says so with its own code', options, async () => {
  const id = newId();
  const client = attach(id, SHELL, { DSH_TERMINAL_PYTHON_PLACES: join(home, 'nowhere') });
  assert.equal(await client.exited, ATTACH_EXIT.noPty);
  assert.equal(existsSync(join(base, id)), false);
});

test('a terminal nobody came back to ends in the end', options, async () => {
  const id = newId();
  const client = attach(id, SHELL, { DSH_TERMINAL_KEEP_MS: '400' });
  assert.ok(await until(() => client.output().includes('> ')));
  client.child.kill('SIGKILL'); await client.exited;
  assert.ok(await until(() => !existsSync(join(base, id)), 5000), 'it has expired');
});

test('a client that stopped reading is dropped rather than holding up the CLI, and others carry on', options, async () => {
  const id = newId(), env = { DSH_TERMINAL_STALLED_MS: '300' };
  const stuck = attach(id, `i=0; while :; do i=$((i+1)); echo "line $i of something long enough to fill the pipes quickly"; done`, env);
  assert.ok(await until(() => stuck.output().includes('line 5')), stuck.output());
  stuck.child.stdout!.pause();
  const second = attach(id, 'unused');
  assert.ok(await until(() => second.output().length > 300_000, 20_000), 'output keeps coming');
  const holder = Number(readFileSync(join(base, id, 'pid'), 'utf8'));
  process.kill(holder, 'SIGTERM');
  await second.exited;
  stuck.child.kill('SIGKILL'); await stuck.exited;
});

test('two clients of different sizes: the screen is the size of whoever came last, then of whoever types', options, async () => {
  const id = newId();
  const wide = attach(id, SHELL, { COLUMNS: '120', LINES: '40' });
  assert.ok(await until(() => wide.output().includes('> ')), wide.output());
  const sizes = (client: Client) => [...client.output().matchAll(/size=(\d+) (\d+)/g)].map(match => `${match[1]}x${match[2]}`);
  const ask = async (client: Client, expected: string, count: number) => {
    client.send('echo size=$(stty size)\n');
    assert.ok(await until(() => sizes(client).length >= count), client.output());
    assert.equal(sizes(client).at(-1), expected);
  };
  await ask(wide, '40x120', 1);
  // As a phone opening the conversation its computer has open.
  const narrow = attach(id, 'exit 99', { COLUMNS: '50', LINES: '20' });
  assert.ok(await until(() => narrow.output().includes('size=40 120')), narrow.output());
  await ask(narrow, '20x50', 2);
  // Back at the computer: typing there makes the screen its size again, without resizing its window.
  await ask(wide, '40x120', 3);
  await ask(narrow, '20x50', 4);
  // What a terminal sends by itself, here a focus report, takes nothing: the screen stays the other client's.
  wide.send('\x1b[I');
  await new Promise(resolve => setTimeout(resolve, 300));
  await ask(narrow, '20x50', 5);
  // The narrow one leaves, and the screen goes back to the one that is left.
  narrow.child.kill('SIGKILL'); await narrow.exited;
  await new Promise(resolve => setTimeout(resolve, 300));
  wide.send('\x15echo size=$(stty size)\n');
  assert.ok(await until(() => sizes(wide).at(-1) === '40x120'), wide.output());
  wide.send('exit 0\n');
  assert.equal(await wide.exited, 0);
});

test('typing takes the screen back, and what a terminal sends by itself does not', () => {
  for (const typed of ['a', '\r', '\x7f', '\x03', '中', 'ls -la\r']) assert.equal(claimsScreen(Buffer.from(typed)), true, JSON.stringify(typed));
  // Cursor position, device attributes, focus in and out, a mouse report, an arrow key, a bracketed paste.
  for (const sent of ['\x1b[12;40R', '\x1b[?62;4c', '\x1b[I', '\x1b[O', '\x1b[<0;10;5M', '\x1b[A', '\x1b[200~pasted\x1b[201~', '']) assert.equal(claimsScreen(Buffer.from(sent)), false, JSON.stringify(sent));
});

test('holder IDs are stable, distinct and fit what the holder accepts', () => {
  assert.equal(tuiHolder('session-a'), tuiHolder('session-a'));
  assert.notEqual(tuiHolder('session-a'), tuiHolder('session-b'));
  assert.notEqual(tabHolder('session-a', 'one'), tabHolder('session-a', 'two'));
  assert.notEqual(tabHolder('a', 'b:c'), tabHolder('a:b', 'c'));
  for (const id of [tuiHolder('x'), tabHolder('x', 'y')]) assert.match(id, /^[a-z]+-[0-9a-f]{16,64}$/);
});

test('exit codes the launcher reads as the holder cannot come from a terminal', () => {
  for (const code of Object.values(ATTACH_EXIT)) assert.equal(attachExitCode(code), 1);
  assert.equal(attachExitCode(0), 0); assert.equal(attachExitCode(7), 7); assert.equal(attachExitCode(null), 1);
});

test('ending a holder only signals the process recorded for it', () => {
  const script = endHolderScript('tab-abc');
  assert.ok(script.includes(`$HOME/${HOLDERS_FOLDER}/tab-abc/pid`));
  assert.ok(script.includes('*" daemon "*"tab-abc"*'), 'a reused process ID is left alone');
});

/** A stand-in ssh: each run does what the next line of its script says and records its arguments. */
function fakeSsh(steps: string[]) {
  const bin = join(home, `bin-${++counter}`); mkdirSync(bin, { recursive: true });
  const log = join(bin, 'log'), input = join(bin, 'input');
  writeFileSync(join(bin, 'steps'), `${steps.join('\n')}\n`);
  writeFileSync(join(bin, 'ssh'), `#!/bin/sh
printf '%s\\n' "$*" >> ${log}
step=$(head -n 1 ${join(bin, 'steps')}); sed -i.bak 1d ${join(bin, 'steps')}
case "$step" in
  install) cat > ${input}; exit 0 ;;
  *) exit "$step" ;;
esac
`);
  chmodSync(join(bin, 'ssh'), 0o755);
  return { bin, log, input };
}
const withPath = async <T>(bin: string, work: () => Promise<T>) => { const saved = process.env.PATH; process.env.PATH = `${bin}:${saved}`; try { return await work(); } finally { process.env.PATH = saved; } };
const silent = () => { let text = ''; return { write: (value: string) => { text += value; return true; }, text: () => text } as unknown as NodeJS.WritableStream & { text(): string }; };
const hold = (fake: { input: string }, output = silent()) => {
  const file = join(home, 'script.mjs'); writeFileSync(file, 'the script');
  return { output, run: () => holdTerminal({ ssh: ['-tt', '-o', 'A=b', '--', 'box'], holder: 'tab-abc', command: 'cd /x', script: { path: file, version: 'v1' }, output, input: process.stdin }) };
};

test('the launcher reports the terminal exit code', async () => {
  const fake = fakeSsh(['5']), { run } = hold(fake);
  assert.equal(await withPath(fake.bin, run), 5);
});

test('the launcher installs the script once and tries again', async () => {
  const fake = fakeSsh([String(ATTACH_EXIT.noScript), 'install', '0']), { run } = hold(fake);
  assert.equal(await withPath(fake.bin, run), 0);
  assert.equal(readFileSync(fake.input, 'utf8'), 'the script');
  assert.match(readFileSync(fake.log, 'utf8'), /^-T -o A=b -- box /m, 'the script goes over a plain connection, not a terminal');
});

test('the launcher reconnects after a lost connection or holder, and says so once', async () => {
  const fake = fakeSsh([String(ATTACH_EXIT.ssh), String(ATTACH_EXIT.lost), '0']), { run, output } = hold(fake);
  assert.equal(await withPath(fake.bin, run), 0);
  assert.equal((output as unknown as { text(): string }).text().match(/reconnecting/g)?.length, 1);
  process.stdin.pause();
});

for (const [name, code] of [['Node.js', ATTACH_EXIT.noRuntime], ['Python', ATTACH_EXIT.noPty]] as const) {
  test(`a host without ${name} gets a plain connection, and a word about it`, async () => {
    const fake = fakeSsh([String(code)]), { run, output } = hold(fake);
    assert.equal(await withPath(fake.bin, run), 'direct');
    assert.match((output as unknown as { text(): string }).text(), /ends with its connection/);
  });
}

test('the command for the host runs in sh whatever the login shell, and carries the start command safely', () => {
  const command = attachCommand({ holder: 'tab-abc', command: `cd '/a b' && exec "$SHELL" -l`, script: { path: '', version: 'v1' } });
  assert.ok(command.startsWith('exec /bin/sh -c '));
  assert.ok(command.includes('terminal-v1.mjs'));
  assert.ok(command.includes(Buffer.from(`cd '/a b' && exec "$SHELL" -l`).toString('base64')));
});
