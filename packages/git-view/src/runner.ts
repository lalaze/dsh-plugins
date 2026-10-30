import { homedir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';

/** Only this DSH home's anchor tree is remote; ordinary projects may be named remote-workspaces. */
export function isRemoteAnchor(cwd: string, home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')): boolean {
  const path = relative(join(home, 'remote-workspaces'), cwd);
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

export interface GitCommand { argv: string[]; timeoutMs: number }
/** As Remote Agents' Git batch: commands run in order; `maxBytes` limits each command's standard output. */
export interface GitBatch { id: string; commands: GitCommand[]; maxBytes: number; stopOnError?: boolean; optionalLocks?: boolean }
export interface GitRun { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; truncated: boolean; skipped: boolean }
/** Where Git runs for one workspace. `cancel` stops the request with that batch ID and skips its remaining commands. */
export interface GitRunner { run(batch: GitBatch, signal: AbortSignal): Promise<GitRun[]>; cancel(id: string): Promise<void> }
export class GitError extends Error {
  constructor(message: string, readonly status = 400, readonly detail: { code?: string; auth?: 'https' | 'ssh' } = {}) { super(message); }
}

/** The part of DSH's subprocess service this plugin uses. */
export interface Subprocess {
  resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string>;
  spawn(spec: {
    argv: readonly string[]; cwd: string; graceMs: number; signal?: AbortSignal; env?: Record<string, string | undefined>;
    stdio: { stdin: 'ignore'; stdout: { maxBytes: number }; stderr: { maxBytes: number } };
  }): { done: Promise<{ exitCode: number | null }>; collected: { stdout?: { readFrom(offset: number): { text: string; lossy: boolean } }; stderr?: { readFrom(offset: number): { text: string } } } };
}
/** The service Remote Agents provides as `remoteAgentsWorkspaces`; every call rechecks the conversation's machine and folder. */
export interface RemoteTarget { hostId: string; label: string; cwd: string }
export interface RemoteWorkspaces {
  readonly gitWorkspaceVersion?: number;
  target(sessionId: string, signal?: AbortSignal): Promise<RemoteTarget>;
  git(sessionId: string, batch: GitBatch, signal?: AbortSignal, expected?: RemoteTarget): Promise<GitRun[]>;
  cancelGit(sessionId: string, id: string, signal?: AbortSignal, expected?: RemoteTarget): Promise<void>;
  stat(sessionId: string, path: string, signal?: AbortSignal, expected?: RemoteTarget): Promise<{ path: string; revision: string; size: number }>;
  download(sessionId: string, path: string, revision: string, signal?: AbortSignal, expected?: RemoteTarget): Promise<Buffer>;
  upload(sessionId: string, path: string, revision: string | null, data: Uint8Array, signal?: AbortSignal, expected?: RemoteTarget): Promise<{ path: string; revision: string; size: number }>;
}

/**
 * Git never waits for a password, an editor or a pager, and reports in English so its messages can be recognized; the
 * same environment as Remote Agents gives Git on an SSH host. Credential helpers and SSH keys keep working.
 */
export const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', GCM_INTERACTIVE: 'never', GIT_EDITOR: ':', GIT_PAGER: 'cat', PAGER: 'cat', LC_ALL: 'C' };
const STDERR_LIMIT = 64 * 1024;

/** Finds Git once; on macOS the `/usr/bin/git` stub counts only with the Command Line Tools installed. */
export function gitExecutable(subprocess: Subprocess): () => Promise<string> {
  let found: Promise<string> | undefined;
  return () => found ??= (async () => {
    const executable = await subprocess.resolveExecutable('git').catch(() => { throw new GitError('Git is not installed on this machine', 501); });
    if (process.platform !== 'darwin' || executable !== '/usr/bin/git') return executable;
    const tools = await subprocess.spawn({ argv: ['/usr/bin/xcode-select', '-p'], cwd: homedir(), graceMs: 1000,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } } }).done.catch(() => ({ exitCode: null }));
    if (tools.exitCode !== 0) throw new GitError('Git needs the Xcode Command Line Tools. Run xcode-select --install in a terminal.', 501);
    return executable;
  })().catch(error => { found = undefined; throw error; });
}

/** Git on the DSH machine through DSH's subprocess service. `config` comes before every command, such as saved credentials. */
export class LocalRunner implements GitRunner {
  private readonly cancels = new Map<string, AbortController>();
  constructor(private readonly subprocess: Subprocess, private readonly git: () => Promise<string>, private readonly cwd: string, private readonly config: () => Promise<string[]> = async () => []) {}
  async run(batch: GitBatch, signal: AbortSignal): Promise<GitRun[]> {
    const cancel = new AbortController(), runs: GitRun[] = [];
    this.cancels.set(batch.id, cancel);
    try {
      const [git, config] = await Promise.all([this.git(), this.config()]);
      for (const command of batch.commands) {
        if (cancel.signal.aborted || (batch.stopOnError && runs.some(run => run.exitCode !== 0))) {
          runs.push({ exitCode: null, stdout: '', stderr: '', timedOut: false, truncated: false, skipped: true });
          continue;
        }
        signal.throwIfAborted();
        const timeout = AbortSignal.timeout(command.timeoutMs);
        const handle = this.subprocess.spawn({ argv: [git, ...config, ...command.argv], cwd: this.cwd, graceMs: 2000, signal: AbortSignal.any([signal, cancel.signal, timeout]),
          env: { ...GIT_ENV, ...batch.optionalLocks === false ? { GIT_OPTIONAL_LOCKS: '0' } : {} },
          stdio: { stdin: 'ignore', stdout: { maxBytes: batch.maxBytes }, stderr: { maxBytes: STDERR_LIMIT } } });
        const outcome = await handle.done.catch((error: unknown) => { throw new GitError(`Git could not start: ${error instanceof Error ? error.message : String(error)}`, 500); });
        const stdout = handle.collected.stdout?.readFrom(0) ?? { text: '', lossy: false };
        const stopped = timeout.aborted || cancel.signal.aborted;
        runs.push({ exitCode: stopped || stdout.lossy ? null : outcome.exitCode, stdout: stdout.text, stderr: handle.collected.stderr?.readFrom(0).text ?? '',
          timedOut: timeout.aborted, truncated: stdout.lossy, skipped: false });
      }
      signal.throwIfAborted();
      return runs;
    } finally { this.cancels.delete(batch.id); }
  }
  async cancel(id: string): Promise<void> { this.cancels.get(id)?.abort(); }
}

/** Git in a Remote Agents remote workspace, over the machine's SSH connection. */
export class RemoteRunner implements GitRunner {
  constructor(private readonly service: RemoteWorkspaces, private readonly sessionId: string, private readonly target?: RemoteTarget) {
    // Older Remote Agents exposes workspace files but not Git batches. Never silently run on the local anchor.
    if (service.gitWorkspaceVersion !== 1 || ['git', 'cancelGit', 'stat', 'download', 'upload'].some(key => typeof service[key as keyof RemoteWorkspaces] !== 'function')) {
      throw new GitError('Update Remote Agents to a version with Git workspace support', 409);
    }
  }
  run(batch: GitBatch, signal: AbortSignal): Promise<GitRun[]> { return remoteCall(() => this.service.git(this.sessionId, batch, signal, this.target)); }
  cancel(id: string): Promise<void> { return remoteCall(() => this.service.cancelGit(this.sessionId, id, undefined, this.target)); }
}
/** Remote Agents reports failures with an HTTP status; keep it. */
export async function remoteCall<T>(call: () => Promise<T>): Promise<T> {
  try { return await call(); }
  catch (error) {
    const status = (error as { status?: unknown } | undefined)?.status;
    if (error instanceof Error && typeof status === 'number' && !(error instanceof GitError)) throw new GitError(error.message, status);
    throw error;
  }
}
