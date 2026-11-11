/** Where a task's files are: a worktree of the repository, on this computer or a saved machine, through dsh-remote-agents. */
import { setTimeout as delay } from 'node:timers/promises';

export interface GitStep { argv: string[]; timeoutMs?: number }
export interface GitResult { code: number | null; stdout: string; stderr: string }
export type Location = { kind: 'local' } | { kind: 'remote'; hostId: string; host: string };
/** A workspace's folder on its machine. */
export interface Machine {
  location: Location; folder: string;
  git(steps: GitStep[], options?: { reads?: boolean; signal?: AbortSignal }): Promise<GitResult[]>;
  shell(command: string, env: Record<string, string>, output: (text: string) => void, signal: AbortSignal): Promise<number | null>;
  read(file: string, limit: number, signal?: AbortSignal): Promise<string | undefined>;
}
export interface Project { path: string; title: string; location: Location; folder: string }
/** `repository` is the repository's main folder on its machine: the same for every workspace and worktree of it. */
export interface ProjectDetail { name: string; defaultBase: string | null; branches: { name: string; local: boolean; remote?: string }[]; setup: string[]; repository?: string; location?: Location }
interface JobMessage { key: string; values?: Record<string, string>; detail?: string }
interface Job {
  id: string; state: 'running' | 'failed' | 'done' | 'discarded'; log: string; error?: JobMessage; actions: string[];
  result?: { path?: string; branch: string | null; worktree: string; warnings: JobMessage[] };
}
/** dsh-remote-agents' service `remoteAgentsWorktrees`. */
interface Worktrees {
  readonly version: number;
  projects(signal?: AbortSignal): Promise<Project[]>;
  inspect(path: string, signal?: AbortSignal): Promise<ProjectDetail>;
  create(request: { path: string; mode: 'new' | 'existing'; base?: string; branch?: string; setup?: readonly string[] }): Job;
  job(id: string): Job;
  act(id: string, action: string): Promise<Job>;
  machine(path: string, signal?: AbortSignal): Promise<Machine>;
}
export interface Created { path: string; worktree: string; branch: string; warnings: string[] }

const said = (message: JobMessage) => message.key.replace(/\{(\w+)\}/gu, (whole, name: string) => message.values?.[name] ?? whole) + (message.detail ? `\n${message.detail.trim()}` : '');

export class Workplaces {
  constructor(private readonly service: (name: string) => unknown, private readonly pollMs = 300) {}
  private worktrees(): Worktrees {
    const value = this.service('remoteAgentsWorktrees') as Worktrees | undefined;
    if (!value) throw new Error('Worktree workspaces are not available: install or update dsh-remote-agents (0.2.129 or newer)');
    return value;
  }
  projects(signal?: AbortSignal): Promise<Project[]> { return this.worktrees().projects(signal); }
  inspect(project: string, signal?: AbortSignal): Promise<ProjectDetail> { return this.worktrees().inspect(project, signal); }
  machine(path: string, signal?: AbortSignal): Promise<Machine> { return this.worktrees().machine(path, signal); }

  /**
   * A worktree on a new branch from `base`, added to DSH as a workspace. The repository's own setup commands run without
   * asking: nobody is there, and the models that follow run commands from the same repository anyway.
   */
  async create(input: { project: string; base: string; branch: string }, signal: AbortSignal): Promise<Created> {
    const worktrees = this.worktrees(), detail = await worktrees.inspect(input.project, signal);
    if (!detail.branches.some(branch => branch.name === input.base)) throw new Error(`Branch ${input.base} is not in ${detail.name}`);
    let branch = input.branch;
    for (let index = 2; detail.branches.some(entry => entry.name === branch && entry.local); index++) branch = `${input.branch}-${index}`;
    let job = worktrees.create({ path: input.project, mode: 'new', base: input.base, branch, setup: detail.setup });
    const stop = () => { void worktrees.act(job.id, 'cancel').catch(() => undefined); };
    signal.addEventListener('abort', stop, { once: true });
    try {
      for (;;) {
        job = worktrees.job(job.id);
        if (job.state === 'running') { await delay(this.pollMs); continue; }
        if (job.state === 'failed' && job.actions.includes('confirm') && !signal.aborted) { job = await worktrees.act(job.id, 'confirm'); continue; }
        break;
      }
    } finally { signal.removeEventListener('abort', stop); }
    signal.throwIfAborted();
    // A worktree whose setup failed is still a worktree; without one there is nothing to work in.
    if (job.state !== 'done' && job.result?.path && job.actions.includes('skip')) {
      const failure = job.error ? said(job.error) : 'Setup failed';
      job = await worktrees.act(job.id, 'skip');
      for (; job.state === 'running'; job = worktrees.job(job.id)) await delay(this.pollMs);
      if (job.state === 'done' && job.result?.path) return { path: job.result.path, worktree: job.result.worktree, branch: job.result.branch ?? branch, warnings: [...job.result.warnings.map(said), `Setup did not finish: ${failure}`] };
    }
    if (job.state !== 'done' || !job.result?.path) throw new Error(job.error ? said(job.error) : 'The worktree could not be created');
    return { path: job.result.path, worktree: job.result.worktree, branch: job.result.branch ?? branch, warnings: job.result.warnings.map(said) };
  }
}
