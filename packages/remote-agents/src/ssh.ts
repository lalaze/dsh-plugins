import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { field, RemoteError } from './domain.js';

export const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
/** Keep a compatible configured Node; otherwise use the newest installed runtime >=22. */
export const REMOTE_PATH = `
dsh_initial_node="$(command -v node 2>/dev/null || true)"
PATH="$HOME/.local/bin:$HOME/.gemini/bin:$HOME/.grok/bin:$HOME/.codebuddy/bin:$HOME/.npm-global/bin:$HOME/.bun/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"
dsh_nvm_root="\${NVM_DIR:-$HOME/.nvm}"
for dsh_node_bin in "$dsh_nvm_root"/versions/node/*/bin; do
  if [ -d "$dsh_node_bin" ]; then PATH="$PATH:$dsh_node_bin"; fi
done
dsh_best_node=; dsh_best_major=0; dsh_best_minor=0; dsh_best_patch=0
dsh_consider_node() {
  [ -x "$1" ] && [ ! -d "$1" ] || return 0
  dsh_version="$("$1" --version 2>/dev/null)" || return 0
  dsh_version="\${dsh_version#v}"
  dsh_major="\${dsh_version%%.*}"; dsh_remainder="\${dsh_version#*.}"
  dsh_minor="\${dsh_remainder%%.*}"; dsh_patch="\${dsh_remainder#*.}"; dsh_patch="\${dsh_patch%%-*}"
  case "$dsh_major:$dsh_minor:$dsh_patch" in *[!0-9:]*|*::*|:*|*:) return 0;; esac
  [ "$dsh_major" -ge 22 ] || return 0
  if [ "$dsh_major" -gt "$dsh_best_major" ] ||
    { [ "$dsh_major" -eq "$dsh_best_major" ] && [ "$dsh_minor" -gt "$dsh_best_minor" ]; } ||
    { [ "$dsh_major" -eq "$dsh_best_major" ] && [ "$dsh_minor" -eq "$dsh_best_minor" ] && [ "$dsh_patch" -gt "$dsh_best_patch" ]; }; then
    dsh_best_node="$1"; dsh_best_major="$dsh_major"; dsh_best_minor="$dsh_minor"; dsh_best_patch="$dsh_patch"
  fi
}
dsh_consider_node "$dsh_initial_node"
if [ -z "$dsh_best_node" ]; then
  for dsh_node_candidate in "$(command -v node 2>/dev/null || true)" /opt/homebrew/bin/node /usr/local/bin/node /opt/homebrew/opt/node@22/bin/node /opt/homebrew/opt/node@24/bin/node /usr/local/opt/node@22/bin/node /usr/local/opt/node@24/bin/node "$dsh_nvm_root"/versions/node/*/bin/node; do
    dsh_consider_node "$dsh_node_candidate"
  done
fi
if [ -n "$dsh_best_node" ]; then PATH="\${dsh_best_node%/*}:$PATH"; fi
export PATH
`;
export function connectionInput(value: unknown): string {
  let connection = field(value, 'SSH connection', 2048);
  if (!connection.includes('://')) connection = `ssh://${connection}`;
  let url: URL;
  try { url = new URL(connection); } catch { throw new RemoteError('Invalid SSH connection'); }
  if (url.protocol !== 'ssh:' || !url.hostname || url.hostname.startsWith('-') || url.password || url.search || url.hash || (url.pathname && url.pathname !== '/')) throw new RemoteError('Enter an SSH host or ssh://user@host:port');
  const username = decodeURIComponent(url.username);
  if (username && !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(username)) throw new RemoteError('Invalid SSH username');
  if (!/^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*|\[[a-fA-F0-9:]+\])$/.test(url.hostname)) throw new RemoteError('Invalid SSH hostname');
  if (url.port && (Number(url.port) < 1 || Number(url.port) > 65535)) throw new RemoteError('Invalid SSH port');
  return `ssh://${username ? `${username}@` : ''}${url.hostname}${url.port ? `:${url.port}` : ''}`;
}
export interface Child {
  write(value: string): void;
  stop(): void;
  onData(callback: (data: Buffer) => void): void;
  onExit(callback: (error: Error) => void): void;
}
export interface SshTransport {
  exec(script: string, timeout?: number): Promise<string>;
  start(cwd: string, argv: string[]): Child;
}
export class OpenSshTransport implements SshTransport {
  private readonly args: string[];
  constructor(connection: string, private readonly binary = 'ssh') {
    const url = new URL(connectionInput(connection));
    this.args = ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10', ...(url.port ? ['-p', url.port] : []), '--', `${decodeURIComponent(url.username) ? `${decodeURIComponent(url.username)}@` : ''}${url.hostname}`];
  }
  private spawn(script: string): ChildProcessWithoutNullStreams {
    // SSH may use zsh/fish; execute our POSIX bootstrap in sh (unmatched nvm globs are harmless).
    return spawn(this.binary, [...this.args, `sh -c ${quote(REMOTE_PATH + script)}`], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  }
  exec(script: string, timeout = 20_000): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = this.spawn(script); let stdout = '', stderr = '', bytes = 0;
      const timer = setTimeout(() => { child.kill(); reject(new Error('SSH probe timed out')); }, timeout);
      child.stdout.on('data', data => { bytes += data.length; if (bytes > 2_000_000) { child.kill(); reject(new Error('SSH probe exceeded output limit')); } else stdout += data.toString(); });
      child.stderr.on('data', data => { stderr = (stderr + data).slice(-4000); });
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', code => { clearTimeout(timer); if (code === 0) resolve(stdout); else reject(new Error(stderr.trim() || `SSH exited (${code})`)); });
      child.stdin.on('error', () => {}); child.stdin.end();
    });
  }
  start(cwd: string, argv: string[]): Child {
    const process = this.spawn(`cd ${quote(cwd)} && exec ${argv.map(quote).join(' ')}`);
    let stderr = '', exited: Error | undefined;
    const data = new Set<(data: Buffer) => void>(), exits = new Set<(error: Error) => void>();
    const end = (error: Error) => { if (exited) return; exited = error; for (const listener of exits) listener(error); };
    process.stdout.on('data', chunk => { for (const listener of data) listener(chunk); });
    process.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    process.stdin.on('error', error => end(error)); process.on('error', end);
    process.on('close', code => end(new Error(stderr.trim() || `Remote CLI exited (${code})`)));
    return {
      write(value) { if (exited || process.stdin.destroyed) throw exited ?? new Error('Remote CLI input closed'); process.stdin.write(value); },
      stop() { process.stdin.end(); process.kill('SIGTERM'); },
      onData(listener) { data.add(listener); },
      onExit(listener) { exits.add(listener); if (exited) listener(exited); },
    };
  }
}
export type WireMessage = Record<string, any>;
/** JSONL supports native Codex, ACP JSON-RPC and Claude's control frames. */
export class JsonlPeer {
  private nextId = 0;
  private pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer?: ReturnType<typeof setTimeout> }>();
  private listeners = new Set<(message: WireMessage) => void>();
  private exits = new Set<(error: Error) => void>();
  private ended?: Error;
  constructor(private readonly child: Child) {
    const decoder = new StringDecoder('utf8'); let buffer = '';
    child.onData(data => {
      buffer += decoder.write(data);
      if (buffer.length > 8_000_000) { this.finish(new Error('Remote CLI frame exceeded output limit')); child.stop(); return; }
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        let message: WireMessage;
        try { message = JSON.parse(line); } catch { continue; }
        if (!message || typeof message !== 'object' || Array.isArray(message)) continue;
        const key = message.type === 'control_response' ? String(message.response?.request_id) : message.id !== undefined && !message.method ? String(message.id) : undefined;
        const request = key ? this.pending.get(key) : undefined;
        if (request && key) {
          this.pending.delete(key); clearTimeout(request.timer);
          const error = message.error ?? (message.response?.subtype === 'error' ? { message: message.response.error } : null);
          if (error) request.reject(new Error(typeof error.message === 'string' ? error.message : JSON.stringify(error)));
          else request.resolve(message.type === 'control_response' ? message.response?.response : message.result);
        } else for (const listener of this.listeners) {
          try { listener(message); } catch (error) { this.finish(error instanceof Error ? error : new Error(String(error))); child.stop(); return; }
        }
      }
    });
    child.onExit(error => this.finish(error));
  }
  get alive(): boolean { return !this.ended; }
  onMessage(listener: (message: WireMessage) => void): void { this.listeners.add(listener); }
  onExit(listener: (error: Error) => void): void { this.exits.add(listener); if (this.ended) listener(this.ended); }
  waitForMessage(predicate: (message: WireMessage) => boolean, timeout = 20_000): Promise<WireMessage> {
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); this.listeners.delete(message); this.exits.delete(failed); };
      const message = (value: WireMessage) => { if (predicate(value)) { cleanup(); resolve(value); } };
      const failed = (error: Error) => { cleanup(); reject(error); };
      const timer = setTimeout(() => failed(new Error('Remote CLI initialization timed out')), timeout);
      this.listeners.add(message); this.exits.add(failed);
      if (this.ended) failed(this.ended);
    });
  }
  send(message: WireMessage): void { if (this.ended) throw this.ended; this.child.write(`${JSON.stringify(message)}\n`); }
  request(method: string, params: Record<string, unknown> = {}, timeout = 20_000): Promise<any> {
    const id = `dsh-${++this.nextId}`;
    return this.wait(id, { jsonrpc: '2.0', id, method, params }, timeout);
  }
  control(request: Record<string, unknown>, timeout = 20_000): Promise<any> {
    const request_id = `dsh-${++this.nextId}`;
    return this.wait(request_id, { type: 'control_request', request_id, request }, timeout);
  }
  private wait(id: string, message: WireMessage, timeout: number): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = timeout > 0 ? setTimeout(() => { this.pending.delete(id); reject(new Error(`Remote CLI request timed out: ${message.method ?? message.request?.subtype}`)); }, timeout) : undefined;
      this.pending.set(id, { resolve, reject, timer });
      try { this.send(message); } catch (error) { this.pending.delete(id); clearTimeout(timer); reject(error); }
    });
  }
  close(): void { this.finish(new Error('Remote CLI connection closed')); this.child.stop(); }
  private finish(error: Error): void {
    if (this.ended) return; this.ended = error;
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear(); for (const listener of this.exits) listener(error);
  }
}
