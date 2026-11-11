import type { WorkspacePlacement } from './access.js';
import type { DirectoryListing, Host } from './domain.js';
import type { SshTransport } from './ssh.js';
import type { FileOperation, GitBatch, GitRun, WorkspaceTarget } from './workspace.js';

/** One saved machine over its shared, identity-checked SSH connection, for as long as the action given it runs. */
export interface MachineFiles {
  /** The connection itself, for a plugin's own remote commands. */
  readonly transport: SshTransport;
  operate(cwd: string, operation: FileOperation, signal?: AbortSignal): Promise<unknown>;
  git(cwd: string, batch: GitBatch, signal?: AbortSignal): Promise<GitRun[]>;
  /** Runs a shell command in `cwd`, passing on its output as it comes. @returns its exit code. */
  stream(cwd: string, command: string, env: Record<string, string>, output: (data: Buffer) => void, signal: AbortSignal): Promise<number | null>;
  /** A file by absolute path, or undefined when it is larger than `limit` bytes. */
  readAbsolute(path: string, limit: number, signal?: AbortSignal): Promise<Buffer | undefined>;
  /** Saves a file under `cwd`'s `.dsh-remote-agents/attachments/`, checked against its digest. @returns its absolute path. */
  attach(cwd: string, path: string, input: AsyncIterable<Uint8Array>, size: number, sha256: string, signal?: AbortSignal): Promise<string>;
}

/**
 * What another DSH plugin needs to work on the machines saved in Remote Agents, as that plugin's service
 * `remoteAgentsMachines`. Remote Agents keeps the machines, their connections and which conversation is on which; the
 * other plugin brings its own commands. dsh-remote-terminals runs terminals, TUI conversations and worktrees through it.
 */
export interface RemoteAgentsMachines {
  readonly version: 1;
  /** Remote Agents' saved state, for a process of its own to read the machines from; see `savedHosts`. */
  readonly stateFile: string;
  hosts(): Pick<Host, 'id' | 'label'>[];
  /** Canonicalize a remote directory, `~` included, and optionally list its subdirectories. */
  browse(hostId: string, path?: string, options?: { entries?: boolean }): Promise<DirectoryListing>;
  /** Run `action` on the machine's connection once `verify` confirms the caller's claim to it still holds. */
  withWorkspace<T>(hostId: string, verify: () => Promise<void>, action: (files: MachineFiles) => Promise<T>): Promise<T>;
  /** A conversation's verified machine and directory. With `expected`, a conversation that has moved is refused. */
  target(sessionId: string, signal?: AbortSignal, expected?: WorkspaceTarget): Promise<WorkspaceTarget>;
  /** Which saved machines and remote directory a local workspace path stands for. */
  resolve(path: string | undefined, signal?: AbortSignal): Promise<WorkspacePlacement>;
  /** Makes a remote directory a DSH workspace path on this computer. */
  createWorkspace(hostId: string, path: string, signal?: AbortSignal): Promise<{ path: string }>;
  /** Stops and archives the remote CLI sessions working in a folder on the machine. */
  archiveSessionsIn(hostId: string, folder: string): Promise<void>;
}
