import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { quote, REMOTE_PATH } from '../core/ssh.js';
import { ATTACH_EXIT, HOLDER_FOLDER, HOLDERS_FOLDER } from './holder-protocol.js';

/**
 * A connection this notices has gone inside 15 seconds; the usual keepalive, 45 seconds of a frozen terminal, is for
 * connections nobody is looking at.
 */
export const TERMINAL_KEEPALIVE = ['-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=3'];
/**
 * OpenSSH 9.5 and later hide typing rhythm by sending keystrokes on a 20 ms clock, followed by fake ones. Measured on 9.9:
 * 327 bytes a key instead of 36, and an echo p95 of 27.6 ms instead of 1.6 ms on loopback. TCP delivers in order, so on a link that drops
 * packets each extra one is another chance for typing to stall until a retransmission. Older versions do not know the option.
 */
export const TERMINAL_TYPING = ['-o', 'IgnoreUnknown=ObscureKeystrokeTiming', '-o', 'ObscureKeystrokeTiming=no'];
const RETRY_MS = [500, 1000, 2000, 4000, 8000, 15_000];
/** A clock that jumped this far means the computer slept, and the connection is as good as gone. */
const WAKE_MS = 10_000;
const NOTICE = 'Connection lost, reconnecting… 连接中断，正在重连…';
const DIRECT_NOTICE = 'This host has no Python 3 or Node.js 22, so this terminal ends with its connection. 这台机器缺 Python 3 或 Node.js 22，此终端断线后不会保留。';
const dim = (text: string) => `\r\n\x1b[2m${text}\x1b[0m\r\n`;

export interface HoldOptions {
  /** Arguments to ssh up to the host, whatever the command. */
  ssh: string[];
  /** This terminal's holder on the host. See holder-protocol.ts. */
  holder: string;
  /** Run by a new holder. Unused if it is already running. */
  command: string;
  /** The holder's script on this machine and its version, which names it on the host. */
  script: { path: string; version: string };
  output?: NodeJS.WritableStream;
  input?: NodeJS.ReadStream;
}

/** Into `sh -c`: the login shell of the account, which runs what ssh is given, need not be a POSIX one. */
const posix = (script: string) => `exec /bin/sh -c ${quote(script)}`;
const remoteScript = (version: string) => `"$HOME/${HOLDER_FOLDER}/terminal-${version}.mjs"`;
export const attachCommand = ({ holder, command, script }: Pick<HoldOptions, 'holder' | 'command' | 'script'>) => posix(`${REMOTE_PATH}
[ -f ${remoteScript(script.version)} ] || exit ${ATTACH_EXIT.noScript}
[ -n "$dsh_best_node" ] || exit ${ATTACH_EXIT.noRuntime}
exec "$dsh_best_node" ${remoteScript(script.version)} attach "$HOME/${HOLDERS_FOLDER}" ${holder} ${Buffer.from(command).toString('base64')}`);
const installCommand = (version: string) => posix(`umask 077
mkdir -p "$HOME/${HOLDER_FOLDER}" "$HOME/${HOLDERS_FOLDER}" || exit 1
dsh_file="$(mktemp "$HOME/${HOLDER_FOLDER}/.terminal.XXXXXXXXXX")" || exit 1
cat > "$dsh_file" && mv -f "$dsh_file" ${remoteScript(version)}`);

/** The script travels over stdin: Linux limits one argument to 128 KB. */
function install({ ssh, script }: HoldOptions): Promise<boolean> {
  return new Promise(resolve => {
    const child = spawn('ssh', [...ssh.map(arg => (arg === '-tt' ? '-T' : arg)), installCommand(script.version)], { stdio: ['pipe', 'ignore', 'inherit'] });
    child.stdin.on('error', () => {});
    createReadStream(script.path).on('error', () => child.kill()).pipe(child.stdin);
    child.on('error', () => resolve(false));
    child.on('close', code => resolve(code === 0));
  });
}

/** One connection to the holder, which ends with the terminal or the connection. */
function connection({ ssh }: HoldOptions, command: string): Promise<number | null> {
  return new Promise(resolve => {
    const child = spawn('ssh', [...ssh, command], { stdio: 'inherit' });
    let last = Date.now();
    // ssh would wait out its keepalive with a screen that does not respond. Starting over costs a redraw.
    const watch = setInterval(() => { const now = Date.now(); if (now - last > WAKE_MS) child.kill('SIGTERM'); last = now; }, 1000);
    child.on('error', () => { clearInterval(watch); resolve(null); });
    child.on('close', code => { clearInterval(watch); resolve(code); });
  });
}

/** Until the time is up or a key is pressed. What is typed here is dropped: it was meant for a screen the user can no longer see. */
function waitForRetry(ms: number, input: NodeJS.ReadStream): Promise<void> {
  return new Promise(resolve => {
    const done = () => {
      clearTimeout(timer);
      input.off('data', done);
      input.pause();
      resolve();
    };
    const timer = setTimeout(done, ms);
    try { input.setRawMode?.(true); } catch { /* not a terminal */ }
    input.on('data', done);
    input.resume();
  });
}

/**
 * Keep this terminal connected to its holder on the host until it ends, reconnecting whenever the connection is lost.
 * @returns the terminal's exit code, or `direct` if the host cannot hold a terminal.
 */
export async function holdTerminal(options: HoldOptions): Promise<number | 'direct'> {
  const output = options.output ?? process.stdout, input = options.input ?? process.stdin;
  const command = attachCommand(options);
  let failures = 0, installed = false, noticed = false;
  for (;;) {
    const started = Date.now();
    const code = await connection(options, command);
    if (code === ATTACH_EXIT.noScript && !installed) {
      installed = true;
      if (await install(options)) continue;
      output.write(dim(DIRECT_NOTICE));
      return 'direct';
    }
    if (code === ATTACH_EXIT.noRuntime || code === ATTACH_EXIT.noPty) {
      output.write(dim(DIRECT_NOTICE));
      return 'direct';
    }
    if (code !== null && code !== ATTACH_EXIT.ssh && code !== ATTACH_EXIT.lost) return code;
    // Lasted a while, so this is a new loss rather than the same one still going on.
    if (Date.now() - started > 30_000) { failures = 0; noticed = false; }
    if (!noticed) { output.write(dim(NOTICE)); noticed = true; }
    await waitForRetry(RETRY_MS[Math.min(failures++, RETRY_MS.length - 1)]!, input);
  }
}
