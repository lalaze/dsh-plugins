import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import nodePath from 'node:path';
import { StatusError } from './store.js';

export interface GitStep { argv: string[]; timeoutMs?: number }
export interface GitResult { code: number | null; stdout: string; stderr: string }
/** Runs the commands in order in one folder. A command that fails is an answer, not an error. */
export type Git = (steps: GitStep[], signal?: AbortSignal) => Promise<GitResult[]>;

/** The folder a conversation works in, and how to ask Git about it there. */
export interface Workplace {
  folder: string;
  git: Git;
  /** The machine's path rules: this computer's, or POSIX on a machine reached over SSH. */
  path: Pick<typeof nodePath, 'resolve' | 'basename' | 'dirname' | 'sep'>;
  /** Present when the folder is on another machine. */
  remote?: { hostId: string; label: string };
}

/** Git never waits for a password, an editor or a pager, reports in English, and takes no lock for a read. */
const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', GCM_INTERACTIVE: 'never', GIT_EDITOR: ':', GIT_PAGER: 'cat', PAGER: 'cat', LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' };
const TIMEOUT = 15_000, OUTPUT_LIMIT = 8 * 1024 * 1024;

/** Git on this computer. */
export function localGit(folder: string): Git {
  return async (steps, signal) => {
    const results: GitResult[] = [];
    for (const step of steps) {
      signal?.throwIfAborted();
      results.push(await new Promise<GitResult>((resolve, reject) => {
        execFile('git', step.argv, { cwd: folder, timeout: step.timeoutMs ?? TIMEOUT, maxBuffer: OUTPUT_LIMIT, signal, windowsHide: true, env: { ...process.env, ...GIT_ENV } }, (error, stdout, stderr) => {
          const code = (error as NodeJS.ErrnoException | null)?.code;
          if (code === 'ENOENT') {
            // A missing folder reads the same as a missing executable; tell them apart.
            stat(folder).then(() => reject(new StatusError('Git is not installed on this computer', 501)), () => reject(new StatusError('This conversation\'s folder is gone', 404)));
            return;
          }
          if (signal?.aborted) { reject(signal.reason); return; }
          const killed = !!error && ((error as { killed?: boolean }).killed || (error as { signal?: string }).signal);
          resolve({ code: !error ? 0 : killed ? null : typeof code === 'number' ? code : 1, stdout: String(stdout), stderr: String(stderr) });
        });
      }));
    }
    return results;
  };
}

/** The part of dsh-remote-terminals' `remoteAgentsWorktrees` service used here: Git in a workspace on a saved machine. */
export interface RemoteWorktrees {
  machine(path: string, signal?: AbortSignal): Promise<{
    location: { kind: 'local' } | { kind: 'remote'; hostId: string; host: string };
    folder: string;
    git(steps: GitStep[], options?: { reads?: boolean; signal?: AbortSignal }): Promise<GitResult[]>;
  }>;
}

/**
 * Where a workspace's files are. A local folder is asked directly, so a conversation that moved into a worktree DSH does
 * not list as a workspace still works; an anchor of a remote workspace goes through the plugin that holds the connection.
 */
export async function workplace(folder: string, remoteAnchor: boolean, worktrees: RemoteWorktrees | undefined, signal?: AbortSignal): Promise<Workplace> {
  if (!remoteAnchor) return { folder, git: localGit(folder), path: nodePath };
  if (typeof worktrees?.machine !== 'function') throw new StatusError('A workspace on another machine needs the Remote terminals plugin', 501);
  let machine: Awaited<ReturnType<RemoteWorktrees['machine']>>;
  try { machine = await worktrees.machine(folder, signal); }
  catch (error) {
    signal?.throwIfAborted();
    // The other plugin's error class is its own copy; its `status` is what carries over.
    const status = (error as { status?: unknown }).status;
    throw new StatusError(error instanceof Error ? error.message : 'The machine could not be reached', typeof status === 'number' ? status : 502);
  }
  const git: Git = (steps, stop) => machine.git(steps, { reads: true, signal: stop });
  if (machine.location.kind === 'local') return { folder: machine.folder, git, path: nodePath };
  return { folder: machine.folder, git, path: nodePath.posix, remote: { hostId: machine.location.hostId, label: machine.location.host } };
}
