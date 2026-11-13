/**
 * Runs on the SSH host and keeps one terminal's process running without DSH, so that closing DSH, its machine sleeping or the
 * network dropping does not end it. tmux would do that too, but as a terminal between the CLI and DSH's: the wheel and text
 * selection would become tmux's, and it drops the status reports DSH reads from Codex (see tui-activity.ts). This passes the
 * CLI's bytes through unchanged. Node.js has no way to open a pseudo-terminal, and macOS's `script` refuses a stdin that is
 * not a terminal, so a few lines of Python hold it.
 *
 * - `daemon` is the holder: it owns the Python process, keeps the screen in a headless xterm and accepts clients on a private socket.
 * - `attach` is run by the launcher inside `ssh -tt` and connects that terminal to the holder, starting one if there is none.
 *   A client that joins gets the screen and its scrollback, then the same bytes as everyone else. The screen has the size
 *   of the client that came or resized last, or that typed last if it was another's meanwhile; see `claimsScreen`.
 *
 * The launcher is in terminal-hold.ts.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { createConnection, createServer, type Socket } from 'node:net';
import { delimiter, join } from 'node:path';
import type { Terminal as HeadlessTerminal } from '@xterm/headless';
import { ATTACH_EXIT, attachExitCode, claimsScreen, FRAME } from './holder-protocol.js';
import { HolderOutput } from './holder-output.js';

const ID = /^[a-z]+-[0-9a-f]{16,64}$/;
const number = (name: string, fallback: number) => (Number(process.env[name]) > 0 ? Number(process.env[name]) : fallback);
/** Only a machine's restart or this ends a terminal nobody came back to, so a forgotten one does not run for ever. A TUI conversation resumes its CLI afterwards. */
const KEEP_MS = number('DSH_TERMINAL_KEEP_MS', 7 * 24 * 3600_000);
/** Lines given to a client that joins. DSH's terminals keep 1000 unless configured otherwise. */
const SCROLLBACK = 2000;
/** The CLI waits for a client this long at most: a client that stopped reading is dropped, and comes back through a new connection. */
const STALLED_MS = number('DSH_TERMINAL_STALLED_MS', 5000);
const PARSE_HIGH = 2 * 1024 * 1024, PARSE_LOW = 256 * 1024;

const SHIM = String.raw`
import fcntl, os, pty, select, signal, struct, sys, termios, time
rows, cols, command = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
winsize = lambda r, c: struct.pack('HHHH', r, c, 0, 0)
pid, master = pty.fork()
if pid == 0:
    try:
        os.close(3)
        # Python ignores these itself, and a process keeps that through exec: pipelines would print errors instead of ending.
        for name in ('SIGPIPE', 'SIGXFSZ'):
            if hasattr(signal, name): signal.signal(getattr(signal, name), signal.SIG_DFL)
        fcntl.ioctl(0, termios.TIOCSWINSZ, winsize(rows, cols))
        modes = termios.tcgetattr(0)
        modes[0] |= getattr(termios, 'IUTF8', 0x4000 if sys.platform == 'darwin' else 0)
        termios.tcsetattr(0, termios.TCSANOW, modes)
        if 'SSH_TTY' in os.environ: os.environ['SSH_TTY'] = os.ttyname(0)
        os.execv('/bin/sh', ['/bin/sh', '-c', command])
    finally:
        os._exit(127)
os.set_blocking(master, False)
wake_read, wake_write = os.pipe()
os.set_blocking(wake_write, False)
signal.set_wakeup_fd(wake_write)
stopping = []
signal.signal(signal.SIGCHLD, lambda *_: None)
signal.signal(signal.SIGTERM, lambda *_: stopping.append(1))
signal.signal(signal.SIGHUP, signal.SIG_IGN)
signal.signal(signal.SIGINT, signal.SIG_IGN)
def status_code(status):
    return os.WEXITSTATUS(status) if os.WIFEXITED(status) else 128 + os.WTERMSIG(status)
def reap(flags=os.WNOHANG):
    try:
        done, status = os.waitpid(pid, flags)
    except ChildProcessError:
        return 1
    return status_code(status) if done else None
def end(code):
    sys.stdout.flush()
    os._exit(code)
def hang_up():
    os.close(master)
    try: os.killpg(pid, signal.SIGHUP)
    except OSError: pass
    until = time.time() + 2
    while time.time() < until:
        code = reap()
        if code is not None: end(code)
        time.sleep(0.05)
    try: os.killpg(pid, signal.SIGKILL)
    except OSError: pass
    end(137)
def drain():
    while True:
        try: data = os.read(master, 65536)
        except OSError: return
        if not data: return
        send(data)
def send(data):
    view = memoryview(data)
    while view: view = view[os.write(1, view):]
pending, control, sources = b'', b'', {0, 3}
try:
    while True:
        ready, writable, _ = select.select([master, wake_read, *sources], [master] if pending else [], [])
        if wake_read in ready: os.read(wake_read, 512)
        if stopping: hang_up()
        if master in ready:
            try: data = os.read(master, 65536)
            except BlockingIOError: data = None
            except OSError: data = b''
            if data == b'':
                code = reap(0)
                end(code if code is not None else 1)
            if data: send(data)
        if 0 in ready:
            data = os.read(0, 65536)
            # The holder is gone, and nobody can reach this terminal any more.
            if not data: hang_up()
            pending += data
        if 3 in ready:
            data = os.read(3, 4096)
            if not data: sources.discard(3)
            control += data
            while b'\n' in control:
                line, control = control.split(b'\n', 1)
                r, c = line.split()
                fcntl.ioctl(master, termios.TIOCSWINSZ, winsize(int(r), int(c)))
        if pending and (master in writable or master in ready):
            try: pending = pending[os.write(master, pending[:4096]):]
            except BlockingIOError: pass
        code = reap()
        if code is not None:
            drain()
            end(code)
except BrokenPipeError:
    hang_up()
`;

const frame = (type: number, payload: Buffer | string = Buffer.alloc(0)) => {
  const body = typeof payload === 'string' ? Buffer.from(payload) : payload;
  const head = Buffer.allocUnsafe(5);
  head.writeUInt8(type, 0); head.writeUInt32BE(body.length, 1);
  return Buffer.concat([head, body]);
};
/** Unknown frames are skipped, as a holder may be older or newer than the client. */
function frames(onFrame: (type: number, payload: Buffer) => void): (data: Buffer) => void {
  let rest: Buffer = Buffer.alloc(0);
  return data => {
    rest = rest.length ? Buffer.concat([rest, data]) : data;
    let at = 0;
    while (rest.length - at >= 5) {
      const size = rest.readUInt32BE(at + 1);
      if (rest.length - at - 5 < size) break;
      onFrame(rest.readUInt8(at), rest.subarray(at + 5, at + 5 + size));
      at += 5 + size;
    }
    rest = rest.subarray(at);
  };
}
const dimension = (value: unknown, fallback: number) => (Number.isSafeInteger(value) && (value as number) > 0 && (value as number) < 10_000 ? value as number : fallback);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** On a Mac without the developer tools, /usr/bin/python3 opens a dialog on a screen nobody may be watching, and the command waits for it. */
function python3(): string | undefined {
  const places = process.env.DSH_TERMINAL_PYTHON_PLACES?.split(delimiter) ?? [...(process.env.PATH ?? '').split(delimiter), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];
  for (const place of new Set(places)) {
    const path = join(place, 'python3');
    if (!fs.existsSync(path)) continue;
    if (process.platform === 'darwin' && path === '/usr/bin/python3') {
      try { execFileSync('/usr/bin/xcode-select', ['-p'], { stdio: 'ignore', timeout: 5000 }); } catch { continue; }
    }
    try { execFileSync(path, ['-IS', '-c', 'import fcntl, pty, select, termios'], { stdio: 'ignore', timeout: 10_000 }); return path; } catch { /* try the next */ }
  }
  return undefined;
}

async function daemon(id: string, python: string): Promise<void> {
  for (const signal of ['SIGHUP', 'SIGINT', 'SIGPIPE'] as const) process.on(signal, () => {});
  const { Terminal } = await import('@xterm/headless');
  const { SerializeAddon } = await import('@xterm/addon-serialize');
  const command = Buffer.from(fs.readFileSync('command', 'utf8'), 'base64').toString('utf8');
  fs.rmSync('command', { force: true });
  let screen: HeadlessTerminal | undefined, serialize: (() => string) | undefined, shim: ChildProcess | undefined;
  let title = '', report = '', parsing = 0, detachedAt = Date.now(), ended = false;
  /** Modes the serializer does not restore. */
  const modes = new Map<number, boolean>();
  const clients = new Map<Socket, { cols: number; rows: number }>(), stalled = new Map<Socket, NodeJS.Timeout>();
  const resumeOutput = () => { if (!stalled.size && parsing < PARSE_LOW) shim?.stdout?.resume(); };
  const stall = (socket: Socket) => {
    if (stalled.has(socket)) return;
    shim?.stdout?.pause();
    stalled.set(socket, setTimeout(() => socket.destroy(), STALLED_MS));
    socket.once('drain', () => { clearTimeout(stalled.get(socket)); stalled.delete(socket); resumeOutput(); });
  };
  const sendFrame = (socket: Socket, data: Buffer) => { if (!socket.destroyed && !socket.write(data)) stall(socket); };
  const send = (socket: Socket, type: number, payload: Buffer | string) => sendFrame(socket, frame(type, payload));
  const output = new HolderOutput<Socket>(sendFrame);
  const resize = (cols: number, rows: number) => {
    if (!screen || (screen.cols === cols && screen.rows === rows)) return;
    screen.resize(cols, rows);
    (shim?.stdio[3] as NodeJS.WritableStream | undefined)?.write(`${rows} ${cols}\n`);
    // In the order of the output, so that a client still waiting for its snapshot hears of it after that.
    output.write(frame(FRAME.size, JSON.stringify({ cols, rows })));
  };
  /** Everything a terminal needs to look as this one does, starting from any state, as a client reconnecting has the old screen. */
  const snapshot = () => {
    let text = `\x1bc${serialize?.() ?? ''}`;
    for (const [mode, on] of modes) text += `\x1b[?${mode}${on ? 'h' : 'l'}`;
    if (title) text += `\x1b]0;${title}\x07`;
    if (report) text += `\x1b]7501;${report}\x07`;
    return text;
  };
  const finish = (code: number | null) => {
    if (ended) return; ended = true;
    const leave = () => {
      for (const socket of clients.keys()) send(socket, FRAME.exit, JSON.stringify({ code }));
      server.close();
      process.chdir('/');
      fs.rmSync(join(base, id), { recursive: true, force: true });
      setTimeout(() => process.exit(0), 200);
    };
    if (screen) screen.write('', leave); else leave();
  };
  const start = (cols: number, rows: number) => {
    const terminal = new Terminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true }), serializer = new SerializeAddon();
    terminal.loadAddon(serializer);
    screen = terminal; serialize = () => serializer.serialize({ scrollback: SCROLLBACK });
    // With nobody attached the CLI still asks the terminal things, such as where the cursor is, and Codex gives up if it hears nothing.
    terminal.onData(data => { if (!clients.size) shim?.stdin?.write(data); });
    terminal.onTitleChange(value => { title = value; });
    terminal.parser.registerOscHandler(7501, data => { if (data.includes('=')) report = data; return false; });
    const track = (on: boolean) => (params: (number | number[])[]) => {
      for (const mode of params) if (mode === 25 || mode === 1006 || mode === 1016) modes.set(mode, on);
      return false;
    };
    terminal.parser.registerCsiHandler({ prefix: '?', final: 'h' }, track(true));
    terminal.parser.registerCsiHandler({ prefix: '?', final: 'l' }, track(false));
    const child = spawn(python, ['-IS', '-c', SHIM, String(rows), String(cols), command], { stdio: ['pipe', 'pipe', 'inherit', 'pipe'] });
    shim = child;
    child.stdin!.on('error', () => {});
    (child.stdio[3] as NodeJS.WritableStream).on('error', () => {});
    child.stdout!.on('data', (chunk: Buffer) => {
      parsing += chunk.length;
      if (parsing > PARSE_HIGH) child.stdout!.pause();
      // Interactive output must not wait behind headless parsing. Joining clients alone wait for their snapshot.
      output.write(frame(FRAME.output, chunk));
      terminal.write(chunk, () => {
        parsing -= chunk.length;
        resumeOutput();
      });
    });
    child.on('error', () => finish(1));
    child.on('close', code => finish(code));
  };
  const server = createServer(socket => {
    socket.on('error', () => {});
    socket.on('close', () => {
      output.remove(socket);
      clearTimeout(stalled.get(socket));
      if (stalled.delete(socket)) resumeOutput();
      if (!clients.delete(socket)) return;
      const latest = [...clients.values()].at(-1);
      if (latest) resize(latest.cols, latest.rows); else detachedAt = Date.now();
    });
    socket.on('data', frames((type, payload) => {
      if (type === FRAME.input) { if (clients.has(socket)) shim?.stdin?.write(Buffer.from(payload)); return; }
      if (type !== FRAME.hello && type !== FRAME.resize) return;
      let size: { cols?: unknown; rows?: unknown };
      try { size = JSON.parse(payload.toString('utf8')) as typeof size; } catch { return; }
      const cols = dimension(size.cols, 80), rows = dimension(size.rows, 24);
      if (type === FRAME.resize) { if (clients.has(socket)) { clients.set(socket, { cols, rows }); resize(cols, rows); } return; }
      if (!screen) { clients.set(socket, { cols, rows }); output.add(socket); start(cols, rows); return; }
      // The snapshot covers everything before this barrier. Output arriving after it is held for this client only.
      output.replay(socket, ready => screen!.write('', () => {
        if (socket.destroyed || ended) { output.remove(socket); return; }
        ready();
      }), () => {
        resize(cols, rows);
        return frame(FRAME.output, snapshot());
      }, () => { clients.delete(socket); clients.set(socket, { cols, rows }); });
    }));
  });
  process.on('SIGTERM', () => { if (shim) shim.kill('SIGTERM'); else finish(0); });
  setInterval(() => {
    if (clients.size) return;
    if (!shim && Date.now() - detachedAt > 60_000) finish(0);
    if (shim && Date.now() - detachedAt > KEEP_MS) shim.kill('SIGTERM');
  }, Math.min(60_000, KEEP_MS / 4));
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen('sock', resolve); });
  fs.writeFileSync('pid', String(process.pid), { mode: 0o600 });
}

const running = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; } };
/** Unix socket paths are limited to about 104 bytes, so connect from the holder's directory. */
function connect(dir: string): Promise<Socket | undefined> {
  return new Promise(resolve => {
    process.chdir(dir);
    const socket = createConnection('sock');
    const timer = setTimeout(() => { socket.destroy(); resolve(undefined); }, 2000);
    socket.once('connect', () => { clearTimeout(timer); socket.removeAllListeners('error'); resolve(socket); });
    socket.once('error', () => { clearTimeout(timer); resolve(undefined); });
  });
}
/** Holders that ended without tidying up, as after a restart of the machine. */
function collect(): void {
  for (const id of fs.readdirSync(base)) {
    if (!ID.test(id)) continue;
    const dir = join(base, id);
    try {
      const pid = Number(fs.readFileSync(join(dir, 'pid'), 'utf8'));
      if (!running(pid)) fs.rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') continue;
      // Being started, unless it has been like this for a while.
      try { if (Date.now() - fs.statSync(dir).mtimeMs > 60_000) fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone already */ }
    }
  }
}
/** Connect to this terminal's holder, or start it. Several clients may do this at once: making the directory decides who starts it. */
async function holderSocket(id: string, encoded: string): Promise<Socket> {
  const dir = join(base, id);
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  process.chdir(base);
  const until = Date.now() + 15_000;
  while (Date.now() < until) {
    let pid: number | undefined;
    try { pid = Number(fs.readFileSync(join(dir, 'pid'), 'utf8')); } catch { /* not started yet */ }
    if (pid !== undefined) {
      const socket = await connect(dir).catch(() => undefined);
      if (socket) return socket;
      process.chdir(base);
      if (!running(pid)) fs.rmSync(dir, { recursive: true, force: true });
      await sleep(50);
      continue;
    }
    try { fs.mkdirSync(dir, { mode: 0o700 }); } catch { await sleep(50); continue; }
    collect();
    const python = python3();
    if (!python) { fs.rmSync(dir, { recursive: true, force: true }); process.exit(ATTACH_EXIT.noPty); }
    fs.writeFileSync(join(dir, 'command'), encoded, { mode: 0o600 });
    const log = fs.openSync(join(dir, 'holder.log'), 'a', 0o600);
    spawn(process.execPath, [process.argv[1]!, 'daemon', base, id, python], { cwd: dir, detached: true, stdio: ['ignore', 'ignore', log] }).unref();
    fs.closeSync(log);
  }
  throw new Error('The terminal holder did not start');
}
async function attach(id: string, encoded: string): Promise<void> {
  const socket = await holderSocket(id, encoded);
  // Bytes reach the terminal on the other end of SSH unchanged; setRawMode would leave \n turning into \r\n.
  if (process.stdin.isTTY) { try { execFileSync('stty', ['raw', '-echo'], { stdio: ['inherit', 'ignore', 'ignore'], timeout: 5000 }); } catch { /* the terminal will echo */ } }
  // A terminal knows its own size; the variables are for a client without one, as in the tests.
  const own = () => ({ cols: process.stdout.columns ?? (Number(process.env.COLUMNS) || undefined), rows: process.stdout.rows ?? (Number(process.env.LINES) || undefined) });
  const size = () => JSON.stringify(own());
  /** The screen's size when another client last changed it. A holder from an earlier version never says, and nothing is taken back. */
  let theirs: { cols?: unknown; rows?: unknown } | undefined;
  socket.write(frame(FRAME.hello, size()));
  process.stdout.on('resize', () => socket.write(frame(FRAME.resize, size())));
  process.stdin.on('data', (data: Buffer) => {
    if (theirs && claimsScreen(data)) {
      const { cols, rows } = own();
      if (theirs.cols !== cols || theirs.rows !== rows) socket.write(frame(FRAME.resize, size()));
      // Until the holder says what the size is now, this client has nothing more to ask for.
      theirs = undefined;
    }
    socket.write(frame(FRAME.input, data));
  });
  // The other end of SSH went away. The holder carries on.
  for (const stream of [process.stdin, process.stdout]) { stream.on('end', () => process.exit(0)); stream.on('error', () => process.exit(0)); }
  process.on('SIGHUP', () => process.exit(0));
  socket.on('error', () => {});
  socket.on('close', () => process.exit(ATTACH_EXIT.lost));
  socket.on('data', frames((type, payload) => {
    if (type === FRAME.output) { if (!process.stdout.write(Buffer.from(payload))) { socket.pause(); process.stdout.once('drain', () => socket.resume()); } return; }
    if (type === FRAME.size) { try { theirs = JSON.parse(payload.toString('utf8')) as typeof theirs; } catch { /* as if it had not said */ } return; }
    if (type !== FRAME.exit) return;
    let code: number | null | undefined;
    try { code = (JSON.parse(payload.toString('utf8')) as { code?: number | null }).code; } catch { /* reported as a failure */ }
    process.stdout.write('', () => process.exit(attachExitCode(code)));
  }));
}

const [command, base = '', id = '', argument = ''] = process.argv.slice(2);
if (!ID.test(id)) { process.stderr.write('Invalid terminal holder ID\n'); process.exit(2); }
if (command === 'daemon') { process.chdir(join(base, id)); await daemon(id, argument); }
else if (command === 'attach') await attach(id, argument);
else { process.stderr.write('Unknown terminal holder command\n'); process.exit(2); }
