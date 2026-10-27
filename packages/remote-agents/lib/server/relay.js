import { createHash, randomUUID } from 'node:crypto';
import { quote } from './ssh.js';
/**
 * Runs on the SSH host and owns one CLI process, so the CLI outlives DSH and its SSH connection.
 *
 * `start` launches a detached daemon (its own session, immune to SIGHUP) that appends the CLI's
 * stdout to `out.log` and accepts input lines `<inputId> <json>` over a private Unix socket. Each
 * input ID is delivered once, so a client can resend unacknowledged input after reconnecting.
 * Partial lines from a dropped connection are discarded. `attach` streams `out.log` from a byte
 * offset on stdout and reports `attached`, `ack`, `exit`, `missing` and `evicted` on stderr.
 * Only `exit` means the CLI ended; any other end of an attachment is a lost connection.
 */
export const RELAY_SCRIPT = String.raw `
import { execFileSync, spawn } from 'node:child_process';
import { createConnection, createServer } from 'node:net';
import fs from 'node:fs';
import { join } from 'node:path';

const MB = 1024 * 1024, NL = Buffer.from('\n');
const number = name => Number(process.env[name]) > 0 ? Number(process.env[name]) : undefined;
const LIMITS = { output: number('DSH_RELAY_MAX_OUTPUT') ?? 512 * MB, line: 128 * MB, stderr: MB, relays: 32,
  idle: number('DSH_RELAY_IDLE_MS') ?? 24 * 3600_000, keep: number('DSH_RELAY_KEEP_MS') ?? 14 * 24 * 3600_000 };
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,99}$/, INPUT = /^[A-Za-z0-9_.:-]{1,200}$/;
const [command, base, ...rest] = process.argv.slice(2);
const print = value => process.stdout.write(JSON.stringify(value) + '\n');
const control = value => process.stderr.write('\u001eDSH-RELAY ' + JSON.stringify(value) + '\n');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const dirOf = id => { if (!ID.test(id ?? '')) throw new Error('Invalid relay ID'); return join(base, id); };
const writeJson = (path, value) => { const temporary = path + '.' + process.pid + '.tmp'; fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 }); fs.renameSync(temporary, path); };
const readJson = path => { try { return JSON.parse(fs.readFileSync(path, 'utf8')); } catch { return undefined; } };
function lines(onLine, limit, onOverflow) {
  let parts = [], size = 0;
  return data => {
    let index = 0;
    while (index < data.length) {
      const newline = data.indexOf(10, index);
      if (newline < 0) { parts.push(data.subarray(index)); size += data.length - index; if (size > limit) { parts = []; size = 0; onOverflow(); } return; }
      const line = Buffer.concat([...parts, data.subarray(index, newline)]); parts = []; size = 0; index = newline + 1;
      onLine(line);
    }
  };
}
/** Unix socket paths are limited to about 104 bytes, so always connect relative to the relay directory. */
function connect(dir) { process.chdir(dir); return createConnection('sock'); }
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
function commandOf(pid) {
  try { return fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\0').join(' '); }
  catch { try { return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }); } catch { return ''; } }
}
/** The daemon recorded for a relay is running; its command line rules out a reused process ID. */
const daemonRunning = (meta, id) => Number.isSafeInteger(meta?.pid) && alive(meta.pid) && commandOf(meta.pid).includes(' daemon ') && commandOf(meta.pid).includes(id);
/** Any process remains in the CLI's process group. The CLI leads its group, so its PID is the group ID. */
const groupRunning = meta => { if (!Number.isSafeInteger(meta?.cli) || meta.cli <= 1) return false; try { process.kill(-meta.cli, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
async function until(check, ms) { for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (check()) return true; return check(); }
/** Probe the daemon's socket. */
function reachable(dir) {
  return new Promise(resolve => {
    const socket = connect(dir);
    const timer = setTimeout(() => done(false), 2000);
    const done = value => { clearTimeout(timer); socket.destroy(); resolve(value); };
    socket.on('connect', () => done(true)); socket.on('error', () => done(false));
  });
}
async function collect() {
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  let live = 0;
  for (const id of fs.readdirSync(base)) {
    if (!ID.test(id)) continue;
    const dir = join(base, id); let stat;
    try { stat = fs.statSync(dir); } catch { continue; }
    const age = Date.now() - stat.mtimeMs, exit = join(dir, 'exit.json');
    if (fs.existsSync(exit)) { if (Date.now() - fs.statSync(exit).mtimeMs > LIMITS.keep) fs.rmSync(dir, { recursive: true, force: true }); continue; }
    if (!fs.existsSync(join(dir, 'meta.json'))) { if (age > 3600_000) fs.rmSync(dir, { recursive: true, force: true }); continue; }
    if (await reachable(dir) || daemonRunning(readJson(join(dir, 'meta.json')), id)) live++;
    else if (age > 60_000) writeJson(exit, { code: null, signal: null, reason: 'relay-stopped', error: 'The remote relay stopped unexpectedly', at: new Date().toISOString() });
  }
  return live;
}
async function start(id, cwd, argv) {
  if (!argv.length) throw new Error('Missing CLI command');
  if (await collect() >= LIMITS.relays) throw new Error('This SSH account already runs ' + LIMITS.relays + ' DSH relays. Stop or delete agents first.');
  const dir = dirOf(id);
  fs.mkdirSync(dir, { mode: 0o700 });
  const log = fs.openSync(join(dir, 'relay.log'), 'a', 0o600);
  const daemon = spawn(process.execPath, [process.argv[1], 'daemon', base, id, cwd, ...argv], { detached: true, stdio: ['ignore', 'ignore', log] });
  let ended = false; daemon.on('exit', () => { ended = true; });
  daemon.unref();
  for (let i = 0; i < 500 && !ended; i++) {
    if (fs.existsSync(join(dir, 'meta.json'))) { print({ ok: true }); return; }
    await sleep(20);
  }
  throw new Error(fs.readFileSync(join(dir, 'relay.log'), 'utf8').trim().slice(-2000) || 'The remote relay did not start');
}
function daemon(id, cwd, argv) {
  const dir = dirOf(id); process.chdir(dir);
  for (const signal of ['SIGHUP', 'SIGINT', 'SIGPIPE']) process.on(signal, () => {});
  const out = fs.openSync('out.log', 'a', 0o600), err = fs.openSync('stderr.log', 'a', 0o600);
  let size = fs.fstatSync(out).size, errors = 0, client, idleSince = Date.now(), reason, ended = false, kill;
  const seen = new Set(), sockets = new Set(), errorTail = [];
  const child = spawn(argv[0], argv.slice(1), { cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  const signal = name => { try { process.kill(-child.pid, name); } catch { try { child.kill(name); } catch {} } };
  const stop = why => { reason ??= why; if (ended) return; signal('SIGTERM'); kill ??= setTimeout(() => signal('SIGKILL'), 5000); };
  process.on('SIGTERM', () => stop('terminated'));
  child.stdin.on('error', () => {});
  child.stdout.on('data', chunk => {
    if (reason === 'output-limit') return;
    if (size + chunk.length > LIMITS.output) { stop('output-limit'); return; }
    fs.writeSync(out, chunk); size += chunk.length; idleSince = Date.now();
  });
  child.stderr.on('data', chunk => {
    errorTail.push(chunk); while (errorTail.length > 8) errorTail.shift();
    if (errors < LIMITS.stderr) { fs.writeSync(err, chunk); errors += chunk.length; }
  });
  const finish = info => {
    if (ended) return; ended = true; clearTimeout(kill);
    // A requested stop also ends processes the CLI left in its group.
    if (reason) signal('SIGKILL');
    const stderr = Buffer.concat(errorTail).toString('utf8').trim().slice(-4000);
    const exit = { code: info.code ?? null, signal: info.signal ?? null, ...(reason ? { reason } : {}), ...(info.error ? { error: info.error } : {}), ...(stderr ? { stderr } : {}), at: new Date().toISOString() };
    writeJson('exit.json', exit);
    for (const socket of sockets) socket.end(JSON.stringify({ exit }) + '\n');
    server.close(); setTimeout(() => process.exit(0), 200);
  };
  child.on('error', error => finish({ error: error.message }));
  child.on('close', (code, name) => finish({ code, signal: name }));
  // Grandchildren may keep stdout open after the CLI itself has exited.
  child.on('exit', () => setTimeout(() => finish({ code: child.exitCode, signal: child.signalCode }), 5000));
  const send = (socket, value) => { if (!socket.destroyed) socket.write(JSON.stringify(value) + '\n'); };
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => { sockets.delete(socket); if (client === socket) { client = undefined; idleSince = Date.now(); } });
    socket.on('data', lines(line => {
      if (line[0] === 0x21) {
        let op; try { op = JSON.parse(line.subarray(1).toString('utf8')).op; } catch { return; }
        if (op === 'attach') { if (client && client !== socket) { send(client, { evicted: true }); client.end(); } client = socket; send(socket, { attached: true, size }); }
        if (op === 'kill') stop('killed');
        return;
      }
      // Only the current attachment may write; an evicted client could duplicate a prompt.
      if (socket !== client) return;
      const space = line.indexOf(32), inputId = space > 0 ? line.subarray(0, space).toString('utf8') : '';
      if (!INPUT.test(inputId)) return;
      if (!seen.has(inputId)) {
        seen.add(inputId); if (seen.size > 10000) seen.delete(seen.values().next().value);
        if (!ended && !child.stdin.destroyed) child.stdin.write(Buffer.concat([line.subarray(space + 1), NL]));
      }
      idleSince = Date.now(); send(socket, { ack: inputId });
    }, LIMITS.line, () => socket.destroy()));
  });
  // Without a client, an idle CLI is stopped eventually; its output is kept for the next attachment.
  setInterval(() => { if (!client && !ended && Date.now() - idleSince > LIMITS.idle) stop('idle-timeout'); }, Math.min(60_000, LIMITS.idle / 4));
  server.listen('sock', () => writeJson('meta.json', { pid: process.pid, cli: child.pid ?? null, command: argv[0], cwd, startedAt: new Date().toISOString() }));
}
async function attach(id, from) {
  const dir = dirOf(id);
  if (!fs.existsSync(join(dir, 'meta.json'))) { control({ missing: true }); return; }
  process.chdir(dir);
  const fd = fs.openSync('out.log', 'r');
  let position = Number(from);
  if (!Number.isSafeInteger(position) || position < 0 || position > fs.fstatSync(fd).size) { control({ missing: true, error: 'The relay output is shorter than the saved position' }); return; }
  let gone = false, exit;
  const socket = createConnection('sock');
  socket.write('!' + JSON.stringify({ op: 'attach' }) + '\n');
  socket.on('error', () => { gone = true; }); socket.on('close', () => { gone = true; });
  socket.on('data', lines(line => {
    let value; try { value = JSON.parse(line.toString('utf8')); } catch { return; }
    if (value.evicted) { control({ evicted: true }); process.exit(0); }
    if (value.exit) exit = value.exit; else control(value);
  }, MB, () => {}));
  process.stdin.on('data', chunk => { if (!gone) socket.write(chunk); });
  for (const stream of [process.stdin, process.stdout]) { stream.on('end', () => process.exit(0)); stream.on('error', () => process.exit(0)); }
  const buffer = Buffer.allocUnsafe(MB);
  for (;;) {
    const finished = gone, read = fs.readSync(fd, buffer, 0, buffer.length, position);
    if (read > 0) {
      position += read;
      if (!process.stdout.write(Buffer.from(buffer.subarray(0, read)))) await new Promise(resolve => process.stdout.once('drain', resolve));
      continue;
    }
    // The daemon writes exit.json after the last output and before closing its socket.
    if (finished) break;
    await sleep(50);
  }
  exit ??= readJson('exit.json') ?? { code: null, signal: null, reason: 'relay-stopped', error: 'The remote relay stopped unexpectedly' };
  control({ exit });
  process.stdout.end(() => process.exit(0));
}
/**
 * Stop each relay's CLI, then delete its files. Files are kept, and the ID reported as failed,
 * unless the daemon and the CLI's process group are confirmed to have stopped.
 */
async function remove(ids) {
  const removed = [], failed = [];
  for (const id of ids) {
    const dir = dirOf(id);
    if (!fs.existsSync(dir)) { removed.push(id); continue; }
    const meta = readJson(join(dir, 'meta.json')), owned = daemonRunning(meta, id);
    if (await reachable(dir)) {
      // The daemon closes the socket once the CLI has exited, or after its SIGKILL fallback.
      await new Promise(resolve => {
        const socket = connect(dir);
        const timer = setTimeout(() => socket.destroy(), 10_000);
        socket.on('connect', () => socket.write('!' + JSON.stringify({ op: 'kill' }) + '\n'));
        socket.on('data', () => {}); socket.on('error', () => {}); socket.on('close', () => { clearTimeout(timer); resolve(); });
      });
    } else if (owned) process.kill(meta.pid, 'SIGTERM'); // The daemon stops its CLI on SIGTERM.
    if (!await until(() => !daemonRunning(meta, id), 10_000)) { try { process.kill(meta.pid, 'SIGKILL'); } catch {} }
    // Only signal a CLI group known to belong to this relay: its daemon was verified, or its leader runs the recorded command.
    const ours = owned || (Number.isSafeInteger(meta?.cli) && alive(meta.cli) && typeof meta?.command === 'string' && commandOf(meta.cli).includes(meta.command));
    if (ours && groupRunning(meta) && !await until(() => !groupRunning(meta), 2000)) {
      for (const signal of ['SIGTERM', 'SIGKILL']) { try { process.kill(-meta.cli, signal); } catch {} if (await until(() => !groupRunning(meta), 5000)) break; }
    }
    if (daemonRunning(meta, id) || (ours && groupRunning(meta))) { failed.push({ id, error: 'The remote CLI could not be stopped' }); continue; }
    process.chdir(base);
    fs.rmSync(dir, { recursive: true, force: true });
    removed.push(id);
  }
  print({ ok: true, removed, failed });
}
try {
  if (command === 'start') await start(rest[0], rest[1], rest.slice(2));
  else if (command === 'daemon') daemon(rest[0], rest[1], rest.slice(2));
  else if (command === 'attach') await attach(rest[0], rest[1]);
  else if (command === 'remove') await remove(rest);
  else throw new Error('Unknown relay command');
} catch (error) {
  if (command === 'attach') { control({ error: String(error?.message ?? error) }); process.exit(1); }
  // Exit successfully so the client receives the reason on stdout.
  print({ error: String(error?.message ?? error) }); process.exit(0);
}
`;
export const RELAY_VERSION = createHash('sha256').update(RELAY_SCRIPT).digest('hex').slice(0, 16);
const HOME = '"$HOME/.dsh-remote-agents"';
const SCRIPT = `${HOME}/relay/relay-${RELAY_VERSION}.mjs`, RELAYS = `${HOME}/relays-v1`;
/** The relay reported that its CLI ended, or that it can no longer be reached. */
export class RelayExit extends Error {
    exit;
    constructor(message, exit = {}) {
        super(message);
        this.exit = exit;
    }
}
export class RelayReleased extends Error {
    constructor(message = 'Remote CLI connection released') { super(message); }
}
export function relayExitMessage(exit) {
    if (exit.reason === 'idle-timeout')
        return 'The remote CLI was stopped after a long idle period without DSH attached.';
    if (exit.reason === 'output-limit')
        return 'The remote CLI was stopped because its output exceeded the relay limit.';
    if (exit.reason === 'killed' || exit.reason === 'terminated')
        return 'The remote CLI was stopped.';
    return exit.error || exit.stderr || `Remote CLI exited (${exit.code ?? exit.signal ?? 'unknown'})`;
}
/**
 * A reconnecting attachment to one relay. Output continues from the exact byte offset, and input
 * that was not acknowledged is resent after reconnecting; the relay drops already delivered IDs.
 */
export class RelayLink {
    transport;
    id;
    prepare;
    onState;
    proc;
    unacked = new Map();
    data = new Set();
    exits = new Set();
    prefix = `in-${randomUUID().slice(0, 8)}`;
    nextInput = 0;
    bytes;
    ended;
    attempt = 0;
    timer;
    state = { connected: false };
    prepared = false;
    installs = 0;
    /** `prepare(reinstall)` makes sure the current relay script is installed on the host. */
    constructor(transport, id, offset, prepare, onState = () => { }) {
        this.transport = transport;
        this.id = id;
        this.prepare = prepare;
        this.onState = onState;
        this.bytes = offset;
        this.offset = offset;
    }
    offset;
    get connected() { return this.state.connected; }
    get error() { return this.state.error; }
    get alive() { return !this.ended; }
    open() { if (!this.proc && !this.ended && !this.timer)
        this.connect(); }
    /** Resolves once attached; rejects when the relay ended or the timeout passed. */
    ready(timeout) {
        if (this.state.connected)
            return Promise.resolve();
        if (this.ended)
            return Promise.reject(this.ended);
        return new Promise((resolve, reject) => {
            const done = (error) => { clearTimeout(timer); this.waiters.delete(done); if (error)
                reject(error);
            else
                resolve(); };
            const timer = setTimeout(() => done(new Error('Timed out connecting to the remote relay')), timeout);
            this.waiters.add(done);
        });
    }
    waiters = new Set();
    setState(state) {
        this.state = state;
        this.onState(state);
        if (state.connected || this.ended)
            for (const done of [...this.waiters])
                done(state.connected ? undefined : this.ended);
    }
    connect() {
        this.timer = undefined;
        if (this.ended)
            return;
        if (!this.prepared) {
            // Install the current relay script first; reattaching never depends on a script from an earlier version.
            const reinstall = this.installs++ > 0;
            void this.prepare(reinstall).then(() => { this.prepared = true; this.connect(); }, error => this.retry(error instanceof Error ? error.message : String(error)));
            return;
        }
        let final = {}, errors = '';
        // A missing script (an upgrade, or a deleted ~/.dsh-remote-agents) is reported and installed before retrying.
        const proc = this.transport.start('/', ['sh', '-c', `[ -f ${SCRIPT} ] || { printf '\\036DSH-RELAY {"install":true}\\n' >&2; exit 0; }; exec node ${SCRIPT} attach ${RELAYS} "$1" "$2"`, 'dsh-relay', this.id, String(this.bytes)], {
            stderr: chunk => {
                errors += chunk.toString('utf8');
                let newline;
                while ((newline = errors.indexOf('\n')) >= 0) {
                    const line = errors.slice(0, newline);
                    errors = errors.slice(newline + 1);
                    const marker = line.indexOf('\u001eDSH-RELAY ');
                    if (marker < 0)
                        continue;
                    let value;
                    try {
                        value = JSON.parse(line.slice(marker + 11));
                    }
                    catch {
                        continue;
                    }
                    if (proc !== this.proc)
                        return;
                    if (value.attached) {
                        this.attempt = 0;
                        this.setState({ connected: true });
                        for (const [id, payload] of this.unacked)
                            proc.write(`${id} ${payload}\n`);
                    }
                    else if (typeof value.ack === 'string')
                        this.unacked.delete(value.ack);
                    else if (value.install)
                        this.prepared = false;
                    else
                        final = value;
                }
                if (errors.length > 64_000)
                    errors = errors.slice(-4000);
            },
        });
        this.proc = proc;
        proc.onData(chunk => { if (proc !== this.proc)
            return; this.bytes += chunk.length; for (const listener of this.data)
            listener(chunk); });
        proc.onExit(error => {
            if (proc !== this.proc)
                return;
            this.proc = undefined;
            if (final.exit)
                this.end(new RelayExit(relayExitMessage(final.exit), final.exit));
            else if (final.missing)
                this.end(new RelayExit(final.error ?? 'The remote relay no longer exists. Its unsaved output is unavailable.', { reason: 'missing' }));
            else if (final.evicted)
                this.end(new RelayReleased('This remote CLI was attached from another DSH instance'));
            // The SSH connection dropped; the relay and its CLI keep running.
            else if (!this.ended)
                this.retry(final.error ?? (this.prepared ? error.message || 'SSH connection lost' : 'Installing the current remote relay script'));
        });
    }
    retry(error) {
        if (this.ended)
            return;
        const delay = Math.min(30_000, 300 * 3 ** Math.min(this.attempt++, 5));
        this.setState({ connected: false, error });
        this.timer = setTimeout(() => this.connect(), delay);
    }
    write(value, inputId = `${this.prefix}-${++this.nextInput}`) {
        if (this.ended)
            throw this.ended;
        if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(inputId))
            throw new Error('Invalid relay input ID');
        const payload = value.endsWith('\n') ? value.slice(0, -1) : value;
        if (payload.includes('\n'))
            throw new Error('Relay input must be one line');
        if (this.unacked.has(inputId))
            return;
        this.unacked.set(inputId, payload);
        if (this.state.connected)
            this.proc?.write(`${inputId} ${payload}\n`);
    }
    /** Stop reading. The remote CLI keeps running. */
    stop() { this.end(new RelayReleased()); }
    end(error) {
        if (this.ended)
            return;
        this.ended = error;
        clearTimeout(this.timer);
        this.timer = undefined;
        const proc = this.proc;
        this.proc = undefined;
        proc?.stop();
        this.setState({ connected: false, ...(error instanceof RelayReleased ? {} : { error: error.message }) });
        for (const listener of this.exits)
            listener(error);
    }
    onData(callback) { this.data.add(callback); }
    onExit(callback) { this.exits.add(callback); if (this.ended)
        callback(this.ended); }
}
/** Relay commands on one SSH host. */
export class RelayClient {
    transport;
    constructor(transport) {
        this.transport = transport;
    }
    /** Install the relay script once per version; unavailable without Node.js 18 or newer on the host. */
    static async open(transport) {
        if (!transport.relays)
            return;
        const output = await transport.exec(`command -v node >/dev/null 2>&1 || { printf missing-node; exit 0; }
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' || { printf old-node; exit 0; }
umask 077
mkdir -p ${HOME}/relay ${RELAYS}
chmod 700 ${HOME} ${HOME}/relay ${RELAYS}
if [ ! -f ${SCRIPT} ]; then
  dsh_relay_tmp="$(mktemp ${HOME}/relay/.relay.XXXXXXXXXX)"
  cat > "$dsh_relay_tmp" <<'DSH_RELAY_SCRIPT_END'
${RELAY_SCRIPT}
DSH_RELAY_SCRIPT_END
  mv -f "$dsh_relay_tmp" ${SCRIPT}
fi
printf ready`);
        return output.trim().endsWith('ready') ? new RelayClient(transport) : undefined;
    }
    async command(name, args, timeout) {
        const output = await this.transport.exec(`node ${SCRIPT} ${name} ${RELAYS} ${args.map(quote).join(' ')}`, timeout);
        const result = output.trim().split('\n').map(line => { try {
            return JSON.parse(line);
        }
        catch {
            return undefined;
        } }).findLast(Boolean);
        if (result?.error)
            throw new Error(result.error);
        if (!result?.ok)
            throw new Error('The remote relay did not confirm the command');
        return { removed: Array.isArray(result.removed) ? result.removed.filter((id) => typeof id === 'string') : [] };
    }
    async launch(id, cwd, argv) { await this.command('start', [id, cwd, ...argv], 30_000); }
    /** Stop each CLI if it still runs and delete its saved output; returns the relays confirmed removed. */
    async remove(ids, timeout = 30_000) { return ids.length ? (await this.command('remove', ids, timeout)).removed : []; }
}
