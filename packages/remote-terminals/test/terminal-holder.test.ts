import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { build } from 'esbuild';
import xtermHeadless from '@xterm/headless';
import { attachExitCode, ATTACH_EXIT, endHolderScript, FocusReports, HOLDERS_FOLDER, onlyFocusReports, screenClaim, tabHolder, tuiHolder } from '../src/holder-protocol.js';
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
function attach(id: string, command: string, env: NodeJS.ProcessEnv = {}, history?: string): Client {
  const args = [script, 'attach', base, id, Buffer.from(command).toString('base64'), ...(history ? [Buffer.from(history).toString('base64')] : [])];
  const child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
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
  // The holder removes its folder as its last step, a moment after the shell is gone.
  assert.ok(await until(() => !existsSync(join(base, id))), 'its folder is removed');
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
  // What a terminal sends by itself, here a focus-out, takes nothing: the screen stays the other client's.
  wide.send('\x1b[O');
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

test('typing, pasting and focus take the screen back, and what a terminal answers by itself does not', () => {
  for (const typed of ['a', '\r', '\x7f', '\x03', '中', 'ls -la\r', '\x1b[200~pasted\x1b[201~']) assert.equal(screenClaim(Buffer.from(typed)), 'typed', JSON.stringify(typed));
  for (const focus of ['\x1b[I', '\x1b[I\x1b[O']) assert.equal(screenClaim(Buffer.from(focus)), 'focus', JSON.stringify(focus));
  // Cursor position, device attributes, focus out, a mouse report, an arrow key, a lone ESC prefix of a paste.
  for (const sent of ['\x1b[12;40R', '\x1b[?62;4c', '\x1b[O', '\x1b[<0;10;5M', '\x1b[A', '\x1b[200', '\x1b', '']) assert.equal(screenClaim(Buffer.from(sent)), undefined, JSON.stringify(sent));
});

test('a terminal that gains focus takes the screen back, unless the size has only just changed hands', options, async () => {
  const id = newId();
  // The command says the size whenever it changes, so reading it needs no typing, which would take the screen itself.
  const command = `trap 'echo winch=$(stty size)' WINCH; echo ready; while :; do sleep 0.05; done`;
  const wide = attach(id, command, { COLUMNS: '120', LINES: '40', DSH_TERMINAL_FOCUS_SETTLE_MS: '1500' });
  assert.ok(await until(() => wide.output().includes('ready')), wide.output());
  const changes = () => [...wide.output().matchAll(/winch=(\d+) (\d+)/g)].map(match => `${match[1]}x${match[2]}`);
  // A phone opens the conversation: the screen becomes its size, and the computer's terminal answers a focus report at once.
  const narrow = attach(id, 'exit 99', { COLUMNS: '50', LINES: '20' });
  assert.ok(await until(() => changes().length === 1), wide.output());
  wide.send('\x1b[I');
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.deepEqual(changes(), ['20x50'], 'a focus-in right after the change takes nothing');
  // Later, back at the computer: focus-out takes nothing, focus-in takes the screen back.
  await new Promise(resolve => setTimeout(resolve, 1200));
  wide.send('\x1b[O');
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.deepEqual(changes(), ['20x50']);
  wide.send('\x1b[I');
  assert.ok(await until(() => changes().length === 2), wide.output());
  assert.deepEqual(changes(), ['20x50', '40x120']);
  // A paste on the phone takes it again, settled or not.
  narrow.send('\x1b[200~x\x1b[201~');
  assert.ok(await until(() => changes().length === 3), wide.output());
  assert.equal(changes().at(-1), '20x50');
  const holder = Number(readFileSync(join(base, id, 'pid'), 'utf8'));
  process.kill(holder, 'SIGTERM');
  await Promise.all([wide.exited, narrow.exited]);
});

test('focus reports are followed through what the CLI prints, split or not', () => {
  const focus = new FocusReports();
  const read = (...chunks: string[]) => { for (const chunk of chunks) focus.read(Buffer.from(chunk, 'latin1')); return focus.on; };
  assert.equal(focus.on, false, 'a terminal starts without them');
  assert.equal(read('\x1b[?2004h\x1b[?25l'), false, 'other modes');
  assert.equal(read('text\x1b[?10', '04h more'), true, 'split between two outputs');
  assert.equal(read('x'.repeat(100)), true, 'output without modes changes nothing');
  assert.equal(read('\x1b[?1004l'), false);
  assert.equal(read('\x1b[?2004;1004h'), true, 'among other modes');
  assert.equal(read('\x1b[?10040h'), true, 'another mode that only starts the same');
  assert.equal(read('\x1bc\x1b[?25h'), false, 'a reset, as a joining client gets first');
  assert.equal(read('\x1bc\x1b[?1004h'), true, 'the snapshot of a CLI that asked');
  for (const reports of ['\x1b[I', '\x1b[O', '\x1b[I\x1b[O']) assert.equal(onlyFocusReports(Buffer.from(reports)), true, JSON.stringify(reports));
  for (const other of ['', 'I', '\x1b[Ix', '\x1b[A', '\x1b[200~\x1b[I\x1b[201~']) assert.equal(onlyFocusReports(Buffer.from(other)), false, JSON.stringify(other));
});

test('a page claims the screen for a CLI that never asked for focus reports, which hears nothing of it', options, async () => {
  const id = newId(), cli = join(home, `reader-${id}.py`);
  // Says each size it gets and what it reads, and asks for focus reports once it reads an f.
  writeFileSync(cli, `import os, signal, tty
tty.setraw(0)
signal.signal(signal.SIGWINCH, lambda *_: os.write(1, b'winch=%d %d\\r\\n' % os.get_terminal_size(0)[::-1]))
os.write(1, b'ready\\r\\n')
while True:
    data = os.read(0, 1024)
    if not data: break
    os.write(1, b'got=' + data.hex().encode() + b'\\r\\n' + (b'\\x1b[?1004h' if data == b'f' else b''))
`);
  const wide = attach(id, `exec python3 ${cli}`, { COLUMNS: '120', LINES: '40', DSH_TERMINAL_FOCUS_SETTLE_MS: '200' });
  assert.ok(await until(() => wide.output().includes('ready')), wide.output());
  const changes = () => [...wide.output().matchAll(/winch=(\d+) (\d+)/g)].map(match => `${match[1]}x${match[2]}`);
  const got = () => [...wide.output().matchAll(/got=([0-9a-f]*)/g)].map(match => match[1]);
  const narrow = attach(id, 'exit 99', { COLUMNS: '50', LINES: '20' });
  assert.ok(await until(() => changes().length === 1), wide.output());
  await new Promise(resolve => setTimeout(resolve, 400));
  // The computer's page comes back into view and claims the screen, as tui-screen.ts does.
  wide.send('\x1b[I\x1b[O');
  assert.ok(await until(() => changes().length === 2), wide.output());
  assert.deepEqual(changes(), ['20x50', '40x120']);
  wide.send('x');
  assert.ok(await until(() => got().length > 0), wide.output());
  assert.deepEqual(got(), ['78'], 'the reports never reached the CLI, and what was typed did');
  // Once the CLI asks for them, it hears them.
  wide.send('f');
  assert.ok(await until(() => got().length === 2), wide.output());
  await new Promise(resolve => setTimeout(resolve, 200));
  wide.send('\x1b[I');
  assert.ok(await until(() => got().length === 3), wide.output());
  assert.equal(got().at(-1), '1b5b49');
  const holder = Number(readFileSync(join(base, id, 'pid'), 'utf8'));
  process.kill(holder, 'SIGTERM');
  await Promise.all([wide.exited, narrow.exited]);
});

/**
 * Behaves as Claude Code's classic renderer: breaks its lines itself at the width, and when the width changes repaints the
 * screen only. With --history it is the copy that prints the conversation again.
 */
const CLASSIC_CLI = `const wrap = ${String(wrapped)};
const lines = () => wrap(process.stdout.columns);
process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on('data', () => {});
process.stdout.write(lines().join('\\r\\n') + '\\r\\n❯ ');
// CLASSIC_BUSY_MS: after its first resize it spins at the prompt that long without a pause, as Claude Code does while it works.
let spun = false;
if (!process.argv.includes('--history')) process.stdout.on('resize', () => {
  const rows = process.stdout.rows, tail = lines().slice(-(rows - 1));
  process.stdout.write('\\x1b[H' + '\\x1b[2K\\x1b[1B'.repeat(rows) + '\\x1b[H' + tail.join('\\r\\n') + '\\r\\n❯ ');
  const spin = Number(process.env.CLASSIC_BUSY_MS);
  if (!spin || spun) return;
  spun = true;
  const until = Date.now() + spin, busy = setInterval(() => { process.stdout.write('|/-\\\\'[Date.now() % 4] + '\\b'); if (Date.now() > until) clearInterval(busy); }, 20);
});
setInterval(() => {}, 1 << 30);
`;
function wrapped(width: number): string[] {
  return Array.from({ length: 40 }, (_, at) => `⏺ message ${at + 1}: ${'lorem ipsum dolor sit amet '.repeat(2 + at % 3).trim()}`).flatMap(text => {
    const lines: string[] = []; let line = '';
    for (const word of text.split(' ')) { if (line && line.length + 1 + word.length > width) { lines.push(line); line = `  ${word}`; } else line += line ? ` ${word}` : word; }
    return [...lines, line, ''];
  });
}
/** Every row of a terminal of this size that was sent `output`, scrollback included. */
async function shownRows(output: string, cols: number, rows: number): Promise<string[]> {
  const { Terminal } = xtermHeadless as unknown as typeof import('@xterm/headless');
  const terminal = new Terminal({ cols, rows, scrollback: 10_000, allowProposedApi: true });
  await new Promise<void>(resolve => terminal.write(output, resolve));
  const buffer = terminal.buffer.active, shown: string[] = [];
  for (let row = 0; row < buffer.length; row++) shown.push(buffer.getLine(row)!.translateToString(true));
  terminal.dispose();
  return shown;
}

/** Ends the holder when the test ends, passed or not, so that its clients exit too. */
const endHolder = (t: { after(fn: () => void): void }, id: string) => t.after(() => { try { process.kill(Number(readFileSync(join(base, id, 'pid'), 'utf8')), 'SIGTERM'); } catch { /* gone already */ } });

test('after a change of width the scrollback is printed again at the new width, once for each width', options, async t => {
  const id = newId(), cli = join(home, `classic-${id}.mjs`), runs = join(home, `copies-${id}`);
  endHolder(t, id);
  writeFileSync(cli, CLASSIC_CLI);
  const node = JSON.stringify(process.execPath), copies = () => (existsSync(runs) ? readFileSync(runs, 'utf8').split('\n').length - 1 : 0);
  const history = `echo copy >> ${runs}; exec ${node} ${cli} --history`;
  const wide = attach(id, `exec ${node} ${cli}`, { COLUMNS: '120', LINES: '30', DSH_TERMINAL_REFLOW_MS: '150' }, history);
  assert.ok(await until(() => wide.output().includes('❯')), wide.output());
  // As a phone opening the conversation: the screen becomes 50 columns, and everything above it is printed again.
  const narrow = attach(id, 'exit 99', { COLUMNS: '50', LINES: '20' });
  assert.ok(await until(() => copies() === 1 && narrow.output().includes('\x1b[3J')), narrow.output().slice(-500));
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.deepEqual(await shownRows(narrow.output(), 50, 20), [...wrapped(50), '❯ '], 'one copy of the conversation, all at 50 columns');
  // Back at the computer.
  const before = wide.output().length;
  wide.send('x');
  assert.ok(await until(() => copies() === 2 && wide.output().lastIndexOf('\x1b[3J') > before), wide.output().slice(-500));
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.deepEqual(await shownRows(wide.output(), 120, 30), [...wrapped(120), '❯ '], 'and all at 120 again');
  // A change of height alone leaves what is above the screen as it is.
  const shorter = attach(id, 'exit 99', { COLUMNS: '120', LINES: '25' });
  assert.ok(await until(() => shorter.output().includes('❯')));
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal(copies(), 2);
});

test('a CLI that never pauses gets its scrollback rebuilt once it is idle', options, async t => {
  const id = newId(), cli = join(home, `classic-${id}.mjs`), runs = join(home, `copies-${id}`);
  endHolder(t, id);
  writeFileSync(cli, CLASSIC_CLI);
  const node = JSON.stringify(process.execPath), copies = () => (existsSync(runs) ? readFileSync(runs, 'utf8').split('\n').length - 1 : 0);
  const wide = attach(id, `exec ${node} ${cli}`, { COLUMNS: '120', LINES: '30', DSH_TERMINAL_REFLOW_MS: '150', CLASSIC_BUSY_MS: '4500' }, `echo copy >> ${runs}; exec ${node} ${cli} --history`);
  assert.ok(await until(() => wide.output().includes('❯')), wide.output());
  const narrow = attach(id, 'exit 99', { COLUMNS: '50', LINES: '20' });
  assert.ok(await until(() => copies() >= 1), 'a copy is made at once');
  await new Promise(resolve => setTimeout(resolve, 2500));
  assert.ok(!narrow.output().includes('\x1b[3J'), 'nothing is put in while the CLI keeps writing');
  assert.ok(await until(() => narrow.output().includes('\x1b[3J'), 20_000), 'but once it is idle');
  assert.equal(copies(), 2);
  await new Promise(resolve => setTimeout(resolve, 200));
  const shown = await shownRows(narrow.output(), 50, 20);
  assert.deepEqual(shown.slice(0, -1), wrapped(50));
  assert.match(shown.at(-1)!, /^❯ /);
});

test('a copy slow to say anything is waited for, and one that printed nothing is tried again', options, async t => {
  const id = newId(), cli = join(home, `classic-${id}.mjs`), runs = join(home, `copies-${id}`);
  endHolder(t, id);
  writeFileSync(cli, CLASSIC_CLI);
  const node = JSON.stringify(process.execPath), copies = () => (existsSync(runs) ? readFileSync(runs, 'utf8').split('\n').length - 1 : 0);
  // The first copy ends without a word; the next takes 2.5 s to start, as a login shell and Claude Code did on the Mac mini.
  const history = `echo copy >> ${runs}; [ $(wc -l < ${runs}) -gt 1 ] || exit 0; sleep 2.5; exec ${node} ${cli} --history`;
  const wide = attach(id, `exec ${node} ${cli}`, { COLUMNS: '120', LINES: '30', DSH_TERMINAL_REFLOW_MS: '150' }, history);
  assert.ok(await until(() => wide.output().includes('❯')), wide.output());
  const narrow = attach(id, 'exit 99', { COLUMNS: '50', LINES: '20' });
  assert.ok(await until(() => narrow.output().includes('\x1b[3J'), 20_000), narrow.output().slice(-500));
  assert.equal(copies(), 2);
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.deepEqual(await shownRows(narrow.output(), 50, 20), [...wrapped(50), '❯ ']);
});

test('without a command that prints the conversation again, a change of width only resizes', options, async t => {
  const id = newId(), cli = join(home, `classic-${id}.mjs`);
  endHolder(t, id);
  writeFileSync(cli, CLASSIC_CLI);
  const wide = attach(id, `exec ${JSON.stringify(process.execPath)} ${cli}`, { COLUMNS: '120', LINES: '30', DSH_TERMINAL_REFLOW_MS: '150' });
  assert.ok(await until(() => wide.output().includes('❯')));
  const narrow = attach(id, 'exit 99', { COLUMNS: '50', LINES: '20' });
  assert.ok(await until(() => narrow.output().includes('❯')));
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.ok(!narrow.output().includes('\x1b[3J'));
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
