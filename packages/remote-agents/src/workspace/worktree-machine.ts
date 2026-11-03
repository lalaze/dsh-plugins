import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path, { posix } from 'node:path';
import { RemoteError } from '../core/domain.js';
import { quote } from '../core/ssh.js';
import { GIT_LIMITS } from './domain.js';
import type { WorkspaceFiles } from './files.js';
import type { WorkspaceHosts } from './hosts.js';

/** One Git command's outcome; `code` is null for a command that was stopped or timed out. */
export interface GitResult { code: number | null; stdout: string; stderr: string }
export interface GitStep { argv: string[]; timeoutMs?: number }
type PathModule = Pick<typeof posix, 'join' | 'relative' | 'resolve' | 'dirname' | 'basename' | 'isAbsolute' | 'sep'>;

/**
 * Where a worktree's Git, files and setup commands run: this computer, or a saved SSH machine. Paths are the machine's
 * own absolute paths.
 */
export interface WorktreeMachine {
  readonly kind: 'local' | 'remote';
  readonly path: PathModule;
  /** The user's home directory on the machine. */
  home(signal?: AbortSignal): Promise<string>;
  /** Git commands in order in `cwd`. A failing command does not stop the others. `reads` marks commands that only read. */
  git(cwd: string, steps: GitStep[], options?: { reads?: boolean; signal?: AbortSignal }): Promise<GitResult[]>;
  /** A shell command for as long as it takes; both output streams go to `output`. Resolves the exit code, null when stopped. */
  shell(cwd: string, command: string, env: Record<string, string>, output: (text: string) => void, signal: AbortSignal): Promise<number | null>;
  /** A text file, or undefined when it is missing or larger than `limit` bytes. */
  read(file: string, limit: number, signal?: AbortSignal): Promise<string | undefined>;
  exists(target: string, signal?: AbortSignal): Promise<boolean>;
  /** Removes a directory and everything in it. */
  removeTree(target: string, signal?: AbortSignal): Promise<void>;
}

/** Git never waits for a password, an editor or a pager, and reports in English so its messages can be recognized. */
const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', GCM_INTERACTIVE: 'never', GIT_EDITOR: ':', GIT_PAGER: 'cat', PAGER: 'cat', LC_ALL: 'C' };
const DEFAULT_TIMEOUT = 60_000;
const OUTPUT_LIMIT = 8 * 1024 * 1024;

/** This computer, where DSH runs. */
export class LocalMachine implements WorktreeMachine {
  readonly kind = 'local' as const;
  readonly path: PathModule = path;
  constructor(private readonly options: { git?: string } = {}) {}
  async home(): Promise<string> { return homedir(); }
  async git(cwd: string, steps: GitStep[], options: { reads?: boolean; signal?: AbortSignal } = {}): Promise<GitResult[]> {
    const results: GitResult[] = [];
    for (const step of steps) {
      options.signal?.throwIfAborted();
      results.push(await new Promise<GitResult>((resolve, reject) => {
        execFile(this.options.git ?? 'git', step.argv, {
          cwd, timeout: step.timeoutMs ?? DEFAULT_TIMEOUT, maxBuffer: OUTPUT_LIMIT, signal: options.signal, windowsHide: true,
          env: { ...process.env, ...GIT_ENV, ...(options.reads ? { GIT_OPTIONAL_LOCKS: '0' } : {}) },
        }, (error, stdout, stderr) => {
          const code = (error as NodeJS.ErrnoException | null)?.code;
          if (code === 'ENOENT') {
            // A missing working directory reads the same as a missing executable; tell them apart.
            stat(cwd).then(() => reject(new RemoteError('Git is not installed on this computer', 501)), () => reject(new RemoteError('No such file or directory', 404)));
            return;
          }
          if (options.signal?.aborted) { reject(options.signal.reason); return; }
          const killed = !!error && ((error as { killed?: boolean }).killed || (error as { signal?: string }).signal);
          resolve({ code: !error ? 0 : killed ? null : typeof code === 'number' ? code : 1, stdout: String(stdout), stderr: String(stderr) });
        });
      }));
    }
    return results;
  }
  shell(cwd: string, command: string, env: Record<string, string>, output: (text: string) => void, signal: AbortSignal): Promise<number | null> {
    signal.throwIfAborted();
    // A process group of its own, so a stop reaches everything the command started.
    const detached = process.platform !== 'win32';
    const child = spawn(command, { cwd, env: { ...process.env, ...env }, shell: true, detached, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const decode = new TextDecoder(), forward = (data: Buffer) => output(decode.decode(data, { stream: true }));
    child.stdout.on('data', forward); child.stderr.on('data', forward);
    const stop = () => {
      try { if (detached && child.pid) process.kill(-child.pid, 'SIGTERM'); else child.kill('SIGTERM'); } catch { /* already gone */ }
    };
    signal.addEventListener('abort', stop, { once: true });
    return new Promise((resolve, reject) => {
      child.on('error', error => { signal.removeEventListener('abort', stop); reject(error); });
      child.on('close', code => { signal.removeEventListener('abort', stop); output(decode.decode()); resolve(signal.aborted ? null : code); });
    });
  }
  async read(file: string, limit: number): Promise<string | undefined> {
    try {
      if ((await stat(file)).size > limit) return undefined;
      return await readFile(file, 'utf8');
    } catch (error) { if (['ENOENT', 'ENOTDIR'].includes(String((error as NodeJS.ErrnoException).code))) return undefined; throw error; }
  }
  async exists(target: string): Promise<boolean> {
    try { await stat(target); return true; } catch { return false; }
  }
  async removeTree(target: string): Promise<void> {
    // A file still open on another process can make one attempt fail; a few short retries cover it.
    for (const delay of [0, 100, 400, 1000]) {
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      try { await rm(target, { recursive: true, force: true }); if (!await this.exists(target)) return; } catch { /* retried */ }
    }
    throw new RemoteError(`Could not remove ${target}`, 500);
  }
}

/** A saved SSH machine, through its verified connection: only `sh`, standard utilities and Git are needed there. */
export class RemoteMachine implements WorktreeMachine {
  readonly kind = 'remote' as const;
  readonly path: PathModule = posix;
  private homePath?: string;
  constructor(private readonly machines: WorkspaceHosts, readonly hostId: string) {}
  private files<T>(action: (files: WorkspaceFiles) => Promise<T>): Promise<T> {
    return this.machines.withWorkspace(this.hostId, async () => {}, action);
  }
  async home(): Promise<string> {
    this.homePath ??= (await this.machines.browse(this.hostId, '~', { entries: false })).path;
    return this.homePath;
  }
  async git(cwd: string, steps: GitStep[], options: { reads?: boolean; signal?: AbortSignal } = {}): Promise<GitResult[]> {
    const results: GitResult[] = [];
    // One SSH round trip per batch that fits the runner's limits.
    for (let start = 0; start < steps.length;) {
      let end = start, total = 0;
      while (end < steps.length && end - start < GIT_LIMITS.commands) {
        const timeout = Math.min(GIT_LIMITS.timeoutMs, Math.max(1000, steps[end].timeoutMs ?? DEFAULT_TIMEOUT));
        if (end > start && total + timeout > GIT_LIMITS.totalMs) break;
        total += timeout; end++;
      }
      const batch = steps.slice(start, end);
      const runs = await this.files(files => files.git(cwd, {
        id: randomUUID(), maxBytes: OUTPUT_LIMIT, optionalLocks: options.reads ? false : true,
        commands: batch.map(step => ({ argv: step.argv, timeoutMs: Math.min(GIT_LIMITS.timeoutMs, Math.max(1000, step.timeoutMs ?? DEFAULT_TIMEOUT)) })),
      }, options.signal));
      results.push(...runs.map(run => ({ code: run.exitCode, stdout: run.stdout, stderr: run.stderr })));
      start = end;
    }
    return results;
  }
  shell(cwd: string, command: string, env: Record<string, string>, output: (text: string) => void, signal: AbortSignal): Promise<number | null> {
    const decode = new TextDecoder();
    return this.files(async files => {
      const code = await files.stream(cwd, command, env, data => output(decode.decode(data, { stream: true })), signal);
      output(decode.decode());
      return code;
    });
  }
  async read(file: string, limit: number, signal?: AbortSignal): Promise<string | undefined> {
    try {
      const data = await this.files(files => files.readAbsolute(file, limit, signal));
      return data?.toString('utf8');
    } catch (error) { if (error instanceof RemoteError && (error.status === 404 || error.status === 403)) return undefined; throw error; }
  }
  async exists(target: string, signal?: AbortSignal): Promise<boolean> {
    const parent = posix.dirname(target), name = posix.basename(target);
    try {
      const listing = await this.files(files => files.operate(parent, { op: 'list', path: '' }, signal)) as { entries: { name: string }[] };
      return listing.entries.some(entry => entry.name === name);
    } catch (error) { if (error instanceof RemoteError && (error.status === 404 || error.status === 403)) return false; throw error; }
  }
  async removeTree(target: string, signal?: AbortSignal): Promise<void> {
    const parent = posix.dirname(target), name = posix.basename(target);
    if (!name || name === '.' || name === '..') throw new RemoteError('Invalid folder');
    const result = await this.files(files => files.operate(parent, { op: 'command', path: '', command: `rm -rf -- ${quote(name)}`, timeoutMs: 120_000 }, signal)) as { exitCode: number | null; stderr: string };
    if (result.exitCode !== 0) throw new RemoteError(result.stderr.trim() || `Could not remove ${target}`, 500);
  }
}
