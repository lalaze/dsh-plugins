import { createHash, randomUUID } from 'node:crypto';
import { mkdir, realpath, rm } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { RemoteError } from '@dsh-plugins/remote-core/domain.js';
import { dshHome, under, type WorkspacePlacement } from '@dsh-plugins/remote-core/access.js';
import type { RemoteAgentsMachines } from '@dsh-plugins/remote-core/machines.js';
import { LocalMachine, RemoteMachine, type GitResult, type GitStep, type WorktreeMachine } from './worktree-machine.js';

/**
 * Workspaces that start from a project: a Git worktree on the project's machine, adopted as a DSH workspace of its own.
 * Worktrees live outside the repository, under `~/.dsh/worktrees` on this computer and `~/.dsh-remote-agents/worktrees`
 * on a saved SSH machine, one folder per repository; a path there is how this plugin knows a worktree is its own. A
 * repository's `.dsh/worktree.json` lists commands that set a new worktree up and tear it down before it is removed.
 */

/** The project setup file, relative to a checkout. */
export const WORKTREE_CONFIG = '.dsh/worktree.json';
const REMOTE_ROOT = ['.dsh-remote-agents', 'worktrees'];
const CONFIG_LIMIT = 64 * 1024;
const LOG_LIMIT = 256 * 1024;
const BRANCH_LIMIT = 1000;
const FETCH_TIMEOUT = 15_000;
const CHECKOUT_TIMEOUT = 170_000;

export type WorktreeLocation = { kind: 'local' } | { kind: 'remote'; hostId: string; host: string };
/** A DSH workspace one can start a worktree from, one per repository: `folder` is the project folder on its machine. */
export interface WorktreeProject { path: string; title: string; location: WorktreeLocation; folder: string; home?: string }
export interface WorktreeBranch {
  name: string;
  /** Present as a local branch. */
  local: boolean;
  /** The remote-tracking branch, as `origin/main`. */
  remote?: string;
  /** Commits the local branch has that its upstream lacks, and the reverse. */
  ahead?: number; behind?: number;
  /** Last commit time, in seconds. */
  date: number;
  /** The checkout that has this branch, when one does. */
  checkedOutAt?: string;
}
/** A worktree this plugin created for the project, and the DSH workspace that stands for it. */
export interface ManagedWorktree { path: string; branch: string | null; workspace?: { workspaceId: string; title: string; path: string } }
export interface WorktreeProjectDetail {
  path: string; location: WorktreeLocation;
  /** The machine's home folder, for showing paths as `~/…`. */
  home: string;
  /** Repository name, the main checkout, and the workspace folder inside a checkout ('' at its top). */
  name: string; repository: string; subdir: string;
  head: string | null;
  defaultBase: string | null;
  branches: WorktreeBranch[];
  /** Where a new worktree goes: the repository's folder of worktrees. */
  root: string;
  setup: string[];
  worktrees: ManagedWorktree[];
}
export interface ArchiveCheck {
  branch: string | null;
  /** Changed and untracked files. */
  dirty: number;
  /** Commits on no remote branch; null when the repository has no remote to compare with. */
  unpushed: number | null;
  /** The branch the worktree's branch is merged into, when it is. */
  mergedInto: string | null;
  teardown: string[];
  workspaces: { workspaceId: string; title: string; sessions: number }[];
}
export type StepState = 'pending' | 'running' | 'done' | 'failed' | 'skipped';
export type JobAction = 'cancel' | 'retry' | 'skip' | 'discard' | 'confirm';
/** A message for the client to translate: an English key with `{name}` values, and Git's own words when there are any. */
export interface JobMessage { key: string; values?: Record<string, string>; detail?: string }
export interface WorktreeJob {
  id: string; kind: 'create' | 'archive';
  state: 'running' | 'failed' | 'done' | 'discarded';
  steps: { id: string; state: StepState; detail?: string }[];
  log: string;
  error?: JobMessage;
  actions: JobAction[];
  result?: { path?: string; title?: string; branch: string | null; worktree: string; warnings: JobMessage[] };
}
export interface CreateRequest {
  path: string; mode: 'new' | 'existing'; base?: string; branch?: string;
  /** The setup commands the form showed. It reads the project's checkout, so a branch's own wait for a confirmation. */
  setup?: readonly string[];
}
export interface ArchiveRequest { path: string; worktree: string; deleteBranch?: boolean }
/**
 * The folder a DSH workspace stands for, on its machine, for another plugin to work in: Git, shell commands and text
 * files there. Commands run in that folder; `read` takes a path inside it.
 */
export interface WorkspaceMachine {
  location: WorktreeLocation; folder: string;
  git(steps: GitStep[], options?: { reads?: boolean; signal?: AbortSignal }): Promise<GitResult[]>;
  /** A shell command for as long as it takes; both output streams go to `output`. Resolves the exit code, null when stopped. */
  shell(command: string, env: Record<string, string>, output: (text: string) => void, signal: AbortSignal): Promise<number | null>;
  /** A text file, or undefined when it is missing or larger than `limit` bytes. */
  read(file: string, limit: number, signal?: AbortSignal): Promise<string | undefined>;
}

/** DSH's host workspace registry, as far as worktree workspaces use it. */
export interface DshWorkspace { workspaceId: string; path: string; title: string; sessionIds: readonly string[] }
export interface DshWorkspaceController {
  create(request: { path: string }): Promise<{ workspace: DshWorkspace; created: boolean }>;
  rename(request: { workspaceId: string; title: string }): Promise<unknown>;
  delete(request: { workspaceId: string }): Promise<unknown>;
  insertBefore(request: { workspaceId: string; beforeWorkspaceId?: string }): Promise<unknown>;
  archiveSession(request: { sessionId: string; stopActivity?: boolean }): Promise<unknown>;
  follow(signal: AbortSignal): AsyncIterable<{ type: string; value?: { items?: readonly DshWorkspace[] } }>;
}
/** The part of dsh-workspace-tags' service a new workspace takes its tags through. */
export interface WorkspaceTags {
  snapshot(): TagAssignments;
  replace(state: TagAssignments): Promise<unknown>;
}
interface TagAssignments { assignments: Record<string, string[]>; [other: string]: unknown }
export interface WorktreeHost {
  machines: Pick<RemoteAgentsMachines, 'hosts' | 'browse' | 'withWorkspace'>;
  access: { resolve: RemoteAgentsMachines['resolve'] };
  anchors: { create: RemoteAgentsMachines['createWorkspace'] };
  dsh(): DshWorkspaceController | undefined;
  tags?(): WorkspaceTags | undefined;
  /** Stops and archives remote CLI sessions working in a folder on a machine. */
  stopRemoteSessions?(hostId: string, folder: string): Promise<void>;
  /** DSH's home folder; holds this computer's worktrees and the remote workspace anchors. */
  home?: string;
  local?: WorktreeMachine;
  remote?(hostId: string): WorktreeMachine;
}

/** Usable as a folder name on every system: letters, digits, dot, dash and underscore. */
export function slugify(value: string): string {
  const slug = value.normalize('NFKD').replace(/[^\w.-]+/g, '-').replace(/-{2,}/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60).replace(/[-.]+$/, '');
  return slug || 'worktree';
}
const ADJECTIVES = ['amber', 'brave', 'bright', 'calm', 'clever', 'cosmic', 'crisp', 'eager', 'gentle', 'happy', 'jolly', 'keen', 'lively', 'lucky', 'mellow', 'nimble',
  'proud', 'quick', 'quiet', 'rapid', 'shiny', 'silent', 'smooth', 'sunny', 'swift', 'tidy', 'vivid', 'witty', 'bold', 'fresh', 'golden', 'misty'];
const NOUNS = ['otter', 'falcon', 'maple', 'comet', 'harbor', 'meadow', 'pebble', 'river', 'cedar', 'ember', 'fjord', 'glacier', 'heron', 'island', 'lantern', 'lotus',
  'nebula', 'orchid', 'panda', 'quartz', 'raven', 'sparrow', 'tiger', 'tulip', 'willow', 'badger', 'coral', 'dune', 'aurora', 'canyon', 'koala', 'summit'];
const pick = <T>(list: readonly T[]) => list[Math.floor(Math.random() * list.length)];
/** A branch name such as `swift-otter`, for a new branch nobody named. */
export const friendlyName = () => `${pick(ADJECTIVES)}-${pick(NOUNS)}`;

/** `git for-each-ref` records: refname, commit time, upstream, upstream tracking, separated by NUL. */
export const BRANCH_FORMAT = '%(refname)%00%(committerdate:unix)%00%(upstream)%00%(upstream:track,nobracket)';
/** Local and remote-tracking branches, one entry per name, most recently committed first. */
export function parseBranches(output: string, remotes: readonly string[], checkouts: ReadonlyMap<string, string> = new Map()): WorktreeBranch[] {
  const byName = new Map<string, WorktreeBranch>(), order: string[] = [], tracked = new Set<string>();
  // Remote names may contain slashes; the longest one that prefixes a ref owns it.
  const owners = [...remotes].sort((a, b) => b.length - a.length);
  const entry = (name: string) => {
    let branch = byName.get(name);
    if (!branch) { branch = { name, local: false, date: 0 }; byName.set(name, branch); order.push(name); }
    return branch;
  };
  for (const line of output.split('\n')) {
    const [ref, date, upstream, track] = line.split('\0');
    if (!ref) continue;
    const time = Number(date) || 0;
    if (ref.startsWith('refs/heads/')) {
      const name = ref.slice(11), branch = entry(name);
      branch.local = true; branch.date = Math.max(branch.date, time);
      // A branch tracks its upstream unless that remote branch is gone.
      if (upstream?.startsWith('refs/remotes/') && track !== 'gone') { branch.remote = upstream.slice(13); tracked.add(name); }
      const ahead = /ahead (\d+)/.exec(track ?? ''), behind = /behind (\d+)/.exec(track ?? '');
      if (ahead) branch.ahead = Number(ahead[1]);
      if (behind) branch.behind = Number(behind[1]);
      const at = checkouts.get(name);
      if (at) branch.checkedOutAt = at;
    } else if (ref.startsWith('refs/remotes/')) {
      const rest = ref.slice(13), remote = owners.find(name => rest.startsWith(`${name}/`));
      if (!remote) continue;
      const name = rest.slice(remote.length + 1);
      if (!name || name === 'HEAD') continue;
      const branch = entry(name);
      branch.date = Math.max(branch.date, time);
      // The upstream wins; otherwise origin's branch, otherwise the first remote's.
      if (!tracked.has(name) && (!branch.remote || remote === 'origin')) branch.remote = rest;
    }
  }
  return order.map(name => byName.get(name)!).sort((a, b) => b.date - a.date);
}
export interface WorktreeRecord { path: string; branch: string | null; head?: string; bare?: boolean }
/** `git worktree list --porcelain` output. */
export function parseWorktrees(output: string): WorktreeRecord[] {
  const records: WorktreeRecord[] = [];
  let current: WorktreeRecord | undefined;
  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) { current = { path: line.slice(9), branch: null }; records.push(current); }
    else if (!current) continue;
    else if (line.startsWith('branch ')) current.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (line.startsWith('HEAD ')) current.head = line.slice(5);
    else if (line === 'bare') current.bare = true;
  }
  return records;
}
/** The setup file's commands: `{ "setup": [...], "teardown": [...] }`. */
export function parseConfig(text: string | undefined): { setup: string[]; teardown: string[] } {
  if (text === undefined) return { setup: [], teardown: [] };
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new RemoteError(`${WORKTREE_CONFIG} is not valid JSON`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RemoteError(`${WORKTREE_CONFIG} must be a JSON object`);
  const list = (name: 'setup' | 'teardown') => {
    const items = (value as Record<string, unknown>)[name];
    if (items === undefined) return [];
    if (!Array.isArray(items) || items.length > 50 || items.some(item => typeof item !== 'string' || !item.trim() || item.length > 10_000)) {
      throw new RemoteError(`"${name}" in ${WORKTREE_CONFIG} must be a list of commands`);
    }
    return items as string[];
  };
  return { setup: list('setup'), teardown: list('teardown') };
}

interface Place { machine: WorktreeMachine; location: WorktreeLocation; cwd: string }
interface Repository {
  toplevel: string; common: string; main: string; name: string; subdir: string; head: string | null;
  remotes: string[]; branches: WorktreeBranch[]; worktrees: WorktreeRecord[]; defaultBase: string | null; root: string;
}
interface Step { id: string; state: StepState; detail?: string }
class JobFailure extends Error {
  constructor(readonly payload: JobMessage, readonly actions: JobAction[] = []) { super(payload.key); }
}
const fail = (key: string, values?: Record<string, string>, detail?: string, actions: JobAction[] = []) => new JobFailure({ key, ...(values ? { values } : {}), ...(detail?.trim() ? { detail: detail.trim().slice(-4000) } : {}) }, actions);

/** A running or finished create or archive operation; the client polls it. */
class Job {
  readonly id = randomUUID();
  state: WorktreeJob['state'] = 'running';
  steps: Step[];
  log = '';
  error?: JobMessage;
  actions: JobAction[] = [];
  result?: WorktreeJob['result'];
  updated = Date.now();
  controller = new AbortController();
  constructor(readonly kind: 'create' | 'archive', steps: string[]) { this.steps = steps.map(id => ({ id, state: 'pending' })); }
  write(text: string) {
    this.log += text;
    if (this.log.length > LOG_LIMIT) this.log = this.log.slice(this.log.length - LOG_LIMIT);
    this.updated = Date.now();
  }
  step(id: string, state: StepState, detail?: string) {
    const step = this.steps.find(s => s.id === id);
    if (step) { step.state = state; if (detail === undefined) delete step.detail; else step.detail = detail; }
    this.updated = Date.now();
  }
  view(): WorktreeJob {
    return { id: this.id, kind: this.kind, state: this.state, steps: this.steps.map(s => ({ ...s })), log: this.log, actions: [...this.actions],
      ...(this.error ? { error: this.error } : {}), ...(this.result ? { result: { ...this.result, warnings: [...this.result.warnings] } } : {}) };
  }
}
/** What a create job made so far, so retrying continues from it and discarding removes it. */
interface Created {
  place: Place; repo: Repository; worktree: string; branch: string; ownBranch: boolean; source: string;
  setup: string[]; next: number; workspaces: string[];
  /** Whether these setup commands have been shown; those that were not never run without a confirmation. */
  reviewed: boolean;
}
const sameCommands = (a: readonly string[], b: readonly string[] | undefined) => !!b && a.length === b.length && a.every((command, index) => command === b[index]);

export class WorktreeService {
  private readonly jobs = new Map<string, Job>();
  private readonly created = new Map<string, Created>();
  private readonly busy = new Set<string>();
  private readonly local: WorktreeMachine;
  private readonly remotes = new Map<string, WorktreeMachine>();
  constructor(private readonly host: WorktreeHost) { this.local = host.local ?? new LocalMachine(); }
  /** Stops running operations, as when the plugin unloads. */
  close(): void { for (const job of this.jobs.values()) if (job.state === 'running') job.controller.abort(); }
  private get home() { return this.host.home ?? dshHome(); }
  private remote(hostId: string): WorktreeMachine {
    let machine = this.remotes.get(hostId);
    if (!machine) { machine = this.host.remote?.(hostId) ?? new RemoteMachine(this.host.machines, hostId); this.remotes.set(hostId, machine); }
    return machine;
  }
  private anchored(path: string) { return under(join(this.home, 'remote-workspaces'), resolve(path)); }
  /** The machine and folder a DSH workspace stands for. */
  private async place(path: string, signal?: AbortSignal): Promise<Place> {
    let placement: WorkspacePlacement;
    try { placement = await this.host.access.resolve(path, signal); }
    catch (error) { signal?.throwIfAborted(); throw new RemoteError(error instanceof Error ? error.message : 'Cannot read a valid remote workspace binding', 409); }
    if (placement.cwd) {
      const hostId = placement.hostIds[0], host = this.host.machines.hosts().find(h => h.id === hostId);
      if (!hostId || !host) throw new RemoteError('This workspace\'s machine is not saved in Remote agents', 409);
      return { machine: this.remote(hostId), location: { kind: 'remote', hostId, host: host.label }, cwd: placement.cwd };
    }
    if (this.anchored(path)) throw new RemoteError('This workspace\'s machine is not saved in Remote agents', 409);
    return { machine: this.local, location: { kind: 'local' }, cwd: path };
  }
  /** Only a folder DSH lists as a workspace: a plugin works where the user's conversations do, not anywhere on a machine. */
  async machine(path: string, signal?: AbortSignal): Promise<WorkspaceMachine> {
    if (!(await this.workspaces(signal)).some(view => view.path === path)) throw new RemoteError('This folder is not a DSH workspace', 409);
    const { machine, location, cwd } = await this.place(path, signal);
    const inside = (file: string) => {
      const target = machine.path.resolve(cwd, file), from = machine.path.relative(cwd, target);
      if (!from || from.startsWith('..') || machine.path.isAbsolute(from)) throw new RemoteError('The file is outside this workspace');
      return target;
    };
    return {
      location, folder: cwd,
      git: (steps, options) => machine.git(cwd, steps, options),
      shell: (command, env, output, stop) => machine.shell(cwd, command, env, output, stop),
      read: async (file, limit, stop) => machine.read(inside(file), limit, stop),
    };
  }
  /** The folder holding a machine's worktrees. */
  private async machineRoot(machine: WorktreeMachine, signal?: AbortSignal): Promise<string> {
    if (machine.kind !== 'local') return machine.path.join(await machine.home(signal), ...REMOTE_ROOT);
    // Git reports worktree paths with links resolved, as /private/tmp for /tmp on macOS; so are this folder's.
    const root = join(this.home, 'worktrees');
    await mkdir(root, { recursive: true });
    return realpath(root);
  }
  /** Whether a folder is a worktree this plugin made: two levels under the machine's worktree folder. */
  private async managedRoot(machine: WorktreeMachine, folder: string, signal?: AbortSignal): Promise<string | undefined> {
    const root = await this.machineRoot(machine, signal), relative = machine.path.relative(root, folder);
    if (!relative || relative.startsWith('..') || machine.path.isAbsolute(relative)) return undefined;
    const parts = relative.split(machine.path.sep);
    return parts.length >= 2 && parts[0] && parts[1] ? machine.path.join(root, parts[0], parts[1]) : undefined;
  }
  private async repository(place: Place, signal?: AbortSignal): Promise<Repository> {
    const { machine, cwd } = place;
    const [top, common, prefix, head, remotes, refs, worktrees, origin] = await machine.git(cwd, [
      { argv: ['rev-parse', '--show-toplevel'] }, { argv: ['rev-parse', '--git-common-dir'] }, { argv: ['rev-parse', '--show-prefix'] }, { argv: ['symbolic-ref', '-q', '--short', 'HEAD'] },
      { argv: ['remote'] }, { argv: ['for-each-ref', `--count=${BRANCH_LIMIT}`, '--sort=-committerdate', `--format=${BRANCH_FORMAT}`, 'refs/heads', 'refs/remotes'] },
      { argv: ['worktree', 'list', '--porcelain'] }, { argv: ['symbolic-ref', '-q', 'refs/remotes/origin/HEAD'] },
    ], { reads: true, signal });
    if (top.code !== 0 || !top.stdout.trim()) throw new RemoteError('This folder is not in a Git repository', 400);
    const toplevel = top.stdout.replace(/\n$/, ''), path = machine.path;
    // One repository has one folder of worktrees, whichever of its checkouts, and links on the way to it, a project names.
    const named = path.resolve(cwd, common.stdout.replace(/\n$/, ''));
    const commonDir = machine.kind === 'local' ? await realpath(named).catch(() => named) : named;
    // A repository's own `.git` folder sits in its main checkout; a bare repository is its common folder.
    const main = path.basename(commonDir) === '.git' ? path.dirname(commonDir) : commonDir;
    const name = path.basename(main).replace(/\.git$/, '') || 'repository';
    const records = parseWorktrees(worktrees.stdout).filter(record => !record.bare);
    const checkouts = new Map(records.filter(r => r.branch).map(r => [r.branch!, r.path]));
    const remoteNames = remotes.stdout.split('\n').map(line => line.trim()).filter(Boolean);
    const branches = parseBranches(refs.stdout, remoteNames, checkouts);
    const originHead = origin.code === 0 ? origin.stdout.trim().replace(/^refs\/remotes\/origin\//, '') : '';
    const has = (name: string) => branches.some(b => b.name === name);
    const defaultBase = [originHead, 'main', 'master', head.stdout.trim()].find(name => name && has(name)) ?? branches[0]?.name ?? null;
    // Git names the workspace folder inside its checkout with forward slashes, whatever the links on the way.
    const subdir = prefix.code === 0 ? prefix.stdout.trim().replace(/\/+$/, '') : '';
    const hash = createHash('sha256').update(commonDir).digest('hex').slice(0, 8);
    const root = path.join(await this.machineRoot(machine, signal), `${slugify(name)}-${hash}`);
    return { toplevel, common: commonDir, main, name, subdir, head: head.code === 0 ? head.stdout.trim() || null : null,
      remotes: remoteNames, branches, worktrees: records, defaultBase, root };
  }
  /** DSH's workspaces, as its registry lists them now. */
  private async workspaces(signal?: AbortSignal): Promise<readonly DshWorkspace[]> {
    const dsh = this.host.dsh();
    if (!dsh) return [];
    const controller = new AbortController(), stop = () => controller.abort();
    signal?.addEventListener('abort', stop, { once: true });
    try {
      for await (const frame of dsh.follow(controller.signal)) if (frame.type === 'baseline' || frame.type === 'replace') return frame.value?.items ?? [];
      return [];
    } finally { controller.abort(); signal?.removeEventListener('abort', stop); }
  }
  /** The DSH workspaces inside a worktree on a machine. */
  private async workspacesIn(place: Place, folder: string, views: readonly DshWorkspace[], signal?: AbortSignal): Promise<DshWorkspace[]> {
    const { machine, location } = place, inside = (path: string) => { const r = machine.path.relative(folder, path); return r === '' || !r.startsWith('..') && !machine.path.isAbsolute(r); };
    if (location.kind === 'local') return views.filter(view => !this.anchored(view.path) && inside(view.path));
    const found: DshWorkspace[] = [];
    for (const view of views) {
      if (!this.anchored(view.path)) continue;
      const placement = await this.host.access.resolve(view.path, signal).catch(() => undefined);
      if (placement?.cwd && placement.hostIds.includes(location.hostId) && inside(placement.cwd)) found.push(view);
    }
    return found;
  }
  private async config(machine: WorktreeMachine, folders: string[], signal?: AbortSignal) {
    for (const folder of folders) {
      const text = await machine.read(machine.path.join(folder, WORKTREE_CONFIG), CONFIG_LIMIT, signal);
      if (text !== undefined) return parseConfig(text);
    }
    return parseConfig(undefined);
  }

  /** DSH workspaces that are Git projects on this computer, and those on saved machines, which are checked when chosen. */
  async projects(signal?: AbortSignal): Promise<WorktreeProject[]> {
    const views = await this.workspaces(signal), hosts = this.host.machines.hosts();
    const localRoot = await this.machineRoot(this.local, signal), seen = new Map<string, WorktreeProject & { own: boolean }>();
    const results = await pool(views, 8, async view => {
      if (this.anchored(view.path)) {
        const placement = await this.host.access.resolve(view.path, signal).catch(() => undefined);
        const host = hosts.find(h => placement?.hostIds.includes(h.id));
        if (!placement?.cwd || !host) return undefined;
        return { path: view.path, title: view.title, location: { kind: 'remote' as const, hostId: host.id, host: host.label }, folder: placement.cwd,
          own: placement.cwd.includes(`/${REMOTE_ROOT.join('/')}/`), key: `${host.id}\0${placement.cwd}` };
      }
      const [common] = await this.local.git(view.path, [{ argv: ['rev-parse', '--git-common-dir'], timeoutMs: 5000 }], { reads: true, signal }).catch(() => [undefined]);
      if (!common || common.code !== 0) return undefined;
      const commonDir = await realpath(resolve(view.path, common.stdout.replace(/\n$/, ''))).catch(() => resolve(view.path, common.stdout.replace(/\n$/, '')));
      const own = await realpath(view.path).then(path => under(localRoot, path), () => false);
      return { path: view.path, title: view.title, location: { kind: 'local' as const }, folder: view.path, home: await this.local.home(),
        own, key: `local\0${commonDir}` };
    });
    for (const item of results) {
      if (!item) continue;
      const { key, ...project } = item, existing = seen.get(key);
      // One entry per repository, preferring a workspace that is not one of its worktrees.
      if (!existing || (existing.own && !project.own)) seen.set(key, project);
    }
    return [...seen.values()].filter(project => !(project.location.kind === 'remote' && project.own)).map(({ own: _own, ...project }) => project);
  }
  async inspect(path: string, signal?: AbortSignal): Promise<WorktreeProjectDetail> {
    const place = await this.place(path, signal), repo = await this.repository(place, signal);
    const [config, views] = await Promise.all([this.config(place.machine, [repo.toplevel, repo.main], signal).catch(() => ({ setup: [], teardown: [] })), this.workspaces(signal)]);
    const worktrees: ManagedWorktree[] = [];
    for (const record of repo.worktrees) {
      if (!await this.managedRoot(place.machine, record.path, signal)) continue;
      const [view] = await this.workspacesIn(place, record.path, views, signal);
      worktrees.push({ path: record.path, branch: record.branch, ...(view ? { workspace: { workspaceId: view.workspaceId, title: view.title, path: view.path } } : {}) });
    }
    return { path, location: place.location, home: await place.machine.home(signal), name: repo.name, repository: repo.main, subdir: repo.subdir, head: repo.head, defaultBase: repo.defaultBase,
      branches: repo.branches, root: repo.root, setup: config.setup, worktrees };
  }

  job(id: string): WorktreeJob {
    const job = this.jobs.get(id);
    if (!job) throw new RemoteError('This operation is no longer available', 404);
    return job.view();
  }
  private start(kind: 'create' | 'archive', steps: string[], run: (job: Job) => Promise<void>): WorktreeJob {
    // Finished operations nobody looked at for a while are forgotten.
    for (const [id, old] of this.jobs) if (old.state !== 'running' && Date.now() - old.updated > 30 * 60_000) { this.jobs.delete(id); this.created.delete(id); }
    const job = new Job(kind, steps);
    this.jobs.set(job.id, job);
    void this.drive(job, run);
    return job.view();
  }
  private async drive(job: Job, run: (job: Job) => Promise<void>): Promise<void> {
    job.state = 'running'; job.actions = []; delete job.error;
    try { await run(job); job.state = 'done'; job.actions = []; }
    catch (error) {
      for (const step of job.steps) if (step.state === 'running') step.state = 'failed';
      job.state = 'failed';
      if (error instanceof JobFailure) { job.error = error.payload; job.actions = error.actions; }
      else if (job.controller.signal.aborted) { job.error = { key: 'Stopped' }; job.actions = job.kind === 'archive' ? ['retry'] : this.created.has(job.id) ? ['retry', 'discard'] : []; }
      else { job.error = { key: error instanceof Error ? error.message : String(error) }; job.actions = job.kind === 'create' && this.created.has(job.id) ? ['retry', 'discard'] : []; }
      if (job.error.detail) job.write(`${job.error.detail}\n`);
    } finally { job.updated = Date.now(); }
  }
  async act(id: string, action: JobAction): Promise<WorktreeJob> {
    const job = this.jobs.get(id);
    if (!job) throw new RemoteError('This operation is no longer available', 404);
    if (action === 'cancel') {
      if (job.state === 'running') job.controller.abort();
      return job.view();
    }
    if (job.state !== 'failed' || !job.actions.includes(action)) throw new RemoteError('This action is not available now', 409);
    job.controller = new AbortController();
    const created = this.created.get(id);
    if (job.kind === 'create' && created) {
      if (action === 'discard') void this.drive(job, async () => { await this.discard(job, created); job.state = 'discarded'; }).then(() => { if (job.state === 'done') job.state = 'discarded'; });
      else {
        if (action === 'skip') { for (const step of job.steps) if (step.state === 'failed' || step.state === 'pending') step.state = 'skipped'; created.next = created.setup.length; }
        if (action === 'confirm') created.reviewed = true;
        void this.drive(job, () => this.finish(job, created));
      }
      return job.view();
    }
    const resume = (job as Job & { resume?: (skip: boolean) => Promise<void> }).resume;
    if (!resume) throw new RemoteError('This action is not available now', 409);
    void this.drive(job, () => resume(action === 'skip'));
    return job.view();
  }

  /** Create a worktree from a project and adopt it as a DSH workspace; setup commands run last. */
  create(request: CreateRequest): WorktreeJob {
    return this.start('create', ['prepare', 'checkout', 'register', 'setup'], async job => {
      const signal = job.controller.signal;
      job.step('prepare', 'running');
      const place = await this.place(request.path, signal), repo = await this.repository(place, signal), { machine } = place;
      const find = (name: string | undefined) => repo.branches.find(branch => branch.name === name);
      let branch: string, base: string | undefined, args: string[], fetch: { remote: string; branch: string } | undefined, ownBranch: boolean;
      if (request.mode === 'existing') {
        const entry = find(request.branch);
        if (!entry || !request.branch) throw fail('Choose a branch to check out');
        if (entry.checkedOutAt) throw fail('Branch {branch} is already checked out at {path}', { branch: entry.name, path: entry.checkedOutAt });
        branch = entry.name;
        if (entry.local) { args = [branch]; ownBranch = false; }
        else {
          const remote = entry.remote!, owner = repo.remotes.find(name => remote.startsWith(`${name}/`))!;
          fetch = { remote: owner, branch: remote.slice(owner.length + 1) };
          args = ['--track', '-b', branch, `refs/remotes/${remote}`]; ownBranch = true;
        }
      } else {
        const entry = find(request.base ?? repo.defaultBase ?? undefined);
        if (!entry) throw fail('Choose a branch to start from');
        // A local branch with commits of its own is the start; otherwise the remote branch, which is refreshed first.
        if (entry.local && (!entry.remote || (entry.ahead ?? 0) > 0)) base = `refs/heads/${entry.name}`;
        else {
          const remote = entry.remote!, owner = repo.remotes.find(name => remote.startsWith(`${name}/`));
          if (owner) fetch = { remote: owner, branch: remote.slice(owner.length + 1) };
          base = `refs/remotes/${remote}`;
        }
        const wanted = request.branch?.trim();
        if (wanted) {
          const [check] = await machine.git(place.cwd, [{ argv: ['check-ref-format', '--branch', wanted] }], { reads: true, signal });
          if (check.code !== 0) throw fail('{branch} is not a valid branch name', { branch: wanted });
          if (find(wanted)?.local) throw fail('Branch {branch} already exists. Check it out instead.', { branch: wanted });
          branch = wanted;
        } else {
          branch = friendlyName();
          for (let i = 2; find(branch); i++) branch = `${friendlyName()}${i > 6 ? `-${i}` : ''}`;
        }
        args = ['--no-track', '-b', branch, base]; ownBranch = true;
      }
      let worktree = machine.path.join(repo.root, slugify(branch));
      for (let i = 2; await machine.exists(worktree, signal); i++) worktree = machine.path.join(repo.root, `${slugify(branch)}-${i}`);
      job.step('prepare', 'done', branch);
      job.result = { branch, worktree, warnings: [] };
      job.step('checkout', 'running');
      if (fetch) {
        job.write(`$ git fetch --no-tags ${fetch.remote} ${fetch.branch}\n`);
        const [fetched] = await machine.git(place.cwd, [{ argv: ['fetch', '--no-tags', fetch.remote, `+refs/heads/${fetch.branch}:refs/remotes/${fetch.remote}/${fetch.branch}`], timeoutMs: FETCH_TIMEOUT }], { signal });
        if (fetched.code !== 0) {
          job.write(fetched.stderr);
          job.result.warnings.push({ key: 'Could not update {branch}; started from the copy already on the machine', values: { branch: `${fetch.remote}/${fetch.branch}` }, detail: fetched.stderr.trim().slice(-2000) });
        }
      }
      job.write(`$ git worktree add ${[worktree, ...args].join(' ')}\n`);
      const [added] = await machine.git(place.cwd, [{ argv: ['worktree', 'add', worktree, ...args], timeoutMs: CHECKOUT_TIMEOUT }], { signal });
      job.write(added.stdout + added.stderr);
      if (added.code !== 0) throw fail('Git could not create the worktree', undefined, added.stderr || added.stdout);
      job.step('checkout', 'done');
      const config = await this.config(machine, [worktree, repo.main], signal).catch(error => {
        job.result!.warnings.push({ key: 'Setup was skipped: {reason}', values: { reason: error instanceof Error ? error.message : String(error) } });
        return { setup: [], teardown: [] };
      });
      const created: Created = { place, repo, worktree, branch, ownBranch, source: request.path, setup: config.setup, next: 0, workspaces: [], reviewed: sameCommands(config.setup, request.setup) };
      this.created.set(job.id, created);
      await this.finish(job, created);
    });
  }
  /** Adopt the worktree as a DSH workspace, then run the setup commands not run yet. */
  private async finish(job: Job, created: Created): Promise<void> {
    const signal = job.controller.signal, { machine, location } = created.place;
    if (!job.result?.path) {
      job.step('register', 'running');
      let folder = created.repo.subdir ? machine.path.join(created.worktree, ...created.repo.subdir.split('/')) : created.worktree;
      if (folder !== created.worktree && !await machine.exists(folder, signal)) {
        job.result!.warnings.push({ key: '{folder} is not on this branch; the workspace opens the whole worktree', values: { folder: created.repo.subdir } });
        folder = created.worktree;
      }
      const path = location.kind === 'local' ? folder : (await this.host.anchors.create(location.hostId, folder, signal)).path;
      const name = created.repo.subdir ? created.repo.subdir.split('/').pop()! : created.repo.name;
      const title = await this.register(path, `${name} · ${created.branch}`, created.source, signal).catch(error => {
        throw fail('The worktree was created but could not be added to DSH: {reason}', { reason: error instanceof Error ? error.message : String(error) }, undefined, ['retry', 'discard']);
      });
      created.workspaces.push(path);
      job.result = { ...job.result!, path, ...(title ? { title } : {}) };
      job.step('register', 'done');
    }
    if (created.next >= created.setup.length) { if (job.steps.find(s => s.id === 'setup')?.state !== 'skipped') job.step('setup', created.setup.length ? 'done' : 'skipped'); return; }
    if (!created.reviewed) {
      // In the log, which holds a whole setup file, for reading before choosing. Checking out a branch must not run what it brings.
      job.write(`${created.setup.map(command => `$ ${command}`).join('\n')}\n`);
      throw fail('This branch has setup commands that were not shown before. Read them above, then choose.', undefined, undefined, ['confirm', 'skip', 'discard']);
    }
    const env = { DSH_SOURCE_CHECKOUT_PATH: created.repo.main, DSH_WORKTREE_PATH: created.worktree, DSH_BRANCH_NAME: created.branch };
    while (created.next < created.setup.length) {
      const command = created.setup[created.next];
      job.step('setup', 'running', `${created.next + 1}/${created.setup.length}`);
      job.write(`$ ${command}\n`);
      const code = await machine.shell(created.worktree, command, env, text => job.write(text), signal);
      if (signal.aborted || code === null) throw fail('Setup was stopped', undefined, undefined, ['retry', 'skip', 'discard']);
      if (code !== 0) throw fail('Setup command failed with exit code {code}', { code: String(code) }, undefined, ['retry', 'skip', 'discard']);
      created.next++;
    }
    job.step('setup', 'done', `${created.setup.length}/${created.setup.length}`);
  }
  /** Add a folder to DSH under `title`, next to the workspace it started from and with that workspace's tags. */
  private async register(path: string, title: string, source: string, signal?: AbortSignal): Promise<string | undefined> {
    const dsh = this.host.dsh();
    if (!dsh) throw new RemoteError('DSH workspaces are unavailable', 501);
    const { workspace } = await dsh.create({ path });
    let named: string | undefined;
    for (let i = 1; i <= 5 && !named; i++) {
      const candidate = i === 1 ? title : `${title} (${i})`;
      if (workspace.title === candidate) { named = candidate; break; }
      try { await dsh.rename({ workspaceId: workspace.workspaceId, title: candidate }); named = candidate; } catch { /* a title in use; try the next */ }
    }
    const views = await this.workspaces(signal).catch(() => [] as DshWorkspace[]);
    const at = views.findIndex(view => view.path === source), from = views[at];
    if (from) {
      const next = views.slice(at + 1).find(view => view.workspaceId !== workspace.workspaceId);
      await dsh.insertBefore({ workspaceId: workspace.workspaceId, ...(next ? { beforeWorkspaceId: next.workspaceId } : {}) }).catch(() => {});
      const tags = this.host.tags?.();
      const state = tags?.snapshot(), inherited = state?.assignments[from.workspaceId];
      if (tags && state && inherited?.length && !state.assignments[workspace.workspaceId]?.length) {
        await tags.replace({ ...state, assignments: { ...state.assignments, [workspace.workspaceId]: [...inherited] } }).catch(() => {});
      }
    }
    return named;
  }
  /** Removes what a create job made: its DSH workspace, the worktree and a branch it created. */
  private async discard(job: Job, created: Created): Promise<void> {
    const signal = job.controller.signal;
    await this.removeWorktree(job, created.place, created.repo, created.worktree, signal);
    if (created.ownBranch) {
      job.write(`$ git branch -D ${created.branch}\n`);
      const [deleted] = await created.place.machine.git(created.repo.main, [{ argv: ['branch', '-D', created.branch] }], { signal });
      job.write(deleted.stdout + deleted.stderr);
    }
    const views = await this.workspaces(signal);
    await this.unregister(views.filter(view => created.workspaces.includes(view.path)), signal);
    this.created.delete(job.id);
  }
  private async removeWorktree(job: Job, place: Place, repo: Pick<Repository, 'main'>, worktree: string, signal: AbortSignal): Promise<void> {
    const { machine } = place;
    job.write(`$ git worktree remove --force ${worktree}\n`);
    const [removed] = await machine.git(repo.main, [{ argv: ['worktree', 'remove', '--force', '--force', worktree], timeoutMs: 120_000 }], { signal });
    job.write(removed.stdout + removed.stderr);
    // Git forgets a worktree whose folder was deleted, or keeps files it does not track; the folder goes either way.
    if (await machine.exists(worktree, signal)) await machine.removeTree(worktree, signal);
    await machine.git(repo.main, [{ argv: ['worktree', 'prune'] }], { signal }).catch(() => {});
  }
  private async unregister(views: readonly DshWorkspace[], signal?: AbortSignal): Promise<void> {
    const dsh = this.host.dsh();
    for (const view of views) {
      signal?.throwIfAborted();
      await dsh?.delete({ workspaceId: view.workspaceId });
      // A remote worktree's anchor folder goes with it; a later worktree of the same name gets a fresh one.
      if (this.anchored(view.path)) {
        const anchors = resolve(this.home, 'remote-workspaces'), parts = relative(anchors, resolve(view.path)).split(sep);
        if (parts.length >= 2 && parts[0] && parts[1]) await rm(join(anchors, parts[0], parts[1]), { recursive: true, force: true });
      }
    }
  }

  /** What archiving a worktree would lose, for the confirmation. */
  async archiveCheck(path: string, worktree: string, signal?: AbortSignal): Promise<ArchiveCheck> {
    const place = await this.place(path, signal), repo = await this.repository(place, signal), { machine } = place;
    const record = await this.owned(place, repo, worktree, signal);
    const [status, unpushed, upstream] = await machine.git(worktree, [
      { argv: ['status', '--porcelain'] },
      { argv: ['rev-list', '--count', 'HEAD', '--not', '--remotes'] },
      { argv: ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'] },
    ], { reads: true, signal }).catch(() => [{ code: 1, stdout: '', stderr: '' }, { code: 1, stdout: '', stderr: '' }, { code: 1, stdout: '', stderr: '' }]);
    const mergedInto = record?.branch ? await this.mergedInto(place, repo, record.branch, signal) : null;
    const config = await this.config(machine, [worktree, repo.main], signal).catch(() => ({ setup: [], teardown: [] }));
    const views = await this.workspacesIn(place, worktree, await this.workspaces(signal), signal);
    return {
      branch: record?.branch ?? null,
      dirty: status.code === 0 ? status.stdout.split('\n').filter(Boolean).length : 0,
      unpushed: repo.remotes.length && unpushed.code === 0 ? Number(unpushed.stdout.trim()) || 0 : upstream.code === 0 ? 0 : null,
      mergedInto, teardown: config.teardown,
      workspaces: views.map(view => ({ workspaceId: view.workspaceId, title: view.title, sessions: view.sessionIds.length })),
    };
  }
  /** A worktree of this project that this plugin made, still known to Git or left behind as a folder. */
  private async owned(place: Place, repo: Repository, worktree: string, signal?: AbortSignal): Promise<WorktreeRecord | undefined> {
    const root = await this.managedRoot(place.machine, worktree, signal);
    if (!root || root !== worktree || place.machine.path.dirname(root) !== repo.root) throw new RemoteError('Only worktrees created here can be archived', 403);
    return repo.worktrees.find(record => record.path === worktree);
  }
  private async mergedInto(place: Place, repo: Repository, branch: string, signal?: AbortSignal): Promise<string | null> {
    const base = repo.defaultBase && repo.branches.find(b => b.name === repo.defaultBase);
    if (!base || base.name === branch) return null;
    const target = base.remote ? `refs/remotes/${base.remote}` : `refs/heads/${base.name}`;
    const [merged] = await place.machine.git(repo.main, [{ argv: ['merge-base', '--is-ancestor', `refs/heads/${branch}`, target] }], { reads: true, signal });
    return merged.code === 0 ? base.remote ?? base.name : null;
  }
  /** Stop the worktree's sessions, run its teardown, remove it, optionally delete its merged branch, and remove its workspaces from DSH. */
  archive(request: ArchiveRequest): WorktreeJob {
    let teardownDone = false;
    return this.start('archive', ['sessions', 'teardown', 'remove', ...(request.deleteBranch ? ['branch'] : []), 'unregister'], async job => {
      const run = async (skipTeardown: boolean) => {
        const signal = job.controller.signal;
        const place = await this.place(request.path, signal), repo = await this.repository(place, signal), { machine, location } = place;
        const record = await this.owned(place, repo, request.worktree, signal);
        const views = await this.workspacesIn(place, request.worktree, await this.workspaces(signal), signal);
        job.result = { branch: record?.branch ?? null, worktree: request.worktree, warnings: [] };
        if (job.steps.find(s => s.id === 'sessions')?.state !== 'done') {
          job.step('sessions', 'running');
          const dsh = this.host.dsh();
          for (const view of views) for (const sessionId of view.sessionIds) {
            await dsh?.archiveSession({ sessionId, stopActivity: true }).catch(error => job.write(`${error instanceof Error ? error.message : String(error)}\n`));
          }
          if (location.kind === 'remote') await this.host.stopRemoteSessions?.(location.hostId, request.worktree).catch(error => job.write(`${error instanceof Error ? error.message : String(error)}\n`));
          job.step('sessions', 'done');
        }
        if (!teardownDone) {
          if (skipTeardown) { job.step('teardown', 'skipped'); teardownDone = true; }
          else {
            const config = await machine.exists(request.worktree, signal) ? await this.config(machine, [request.worktree, repo.main], signal).catch(() => ({ setup: [], teardown: [] })) : { setup: [], teardown: [] };
            const env = { DSH_SOURCE_CHECKOUT_PATH: repo.main, DSH_WORKTREE_PATH: request.worktree, DSH_BRANCH_NAME: record?.branch ?? '' };
            for (const [index, command] of config.teardown.entries()) {
              job.step('teardown', 'running', `${index + 1}/${config.teardown.length}`);
              job.write(`$ ${command}\n`);
              const code = await machine.shell(request.worktree, command, env, text => job.write(text), signal);
              if (signal.aborted || code === null) throw fail('Teardown was stopped', undefined, undefined, ['retry', 'skip']);
              if (code !== 0) throw fail('Teardown command failed with exit code {code}', { code: String(code) }, undefined, ['retry', 'skip']);
            }
            job.step('teardown', config.teardown.length ? 'done' : 'skipped'); teardownDone = true;
          }
        }
        job.step('remove', 'running');
        await this.removeWorktree(job, place, repo, request.worktree, signal).catch(error => {
          throw fail('Could not remove the worktree: {reason}', { reason: error instanceof Error ? error.message : String(error) }, undefined, ['retry']);
        });
        job.step('remove', 'done');
        if (request.deleteBranch && record?.branch) {
          job.step('branch', 'running');
          if (await this.mergedInto(place, repo, record.branch, signal)) {
            job.write(`$ git branch -D ${record.branch}\n`);
            const [deleted] = await machine.git(repo.main, [{ argv: ['branch', '-D', record.branch] }], { signal });
            job.write(deleted.stdout + deleted.stderr);
            job.step('branch', deleted.code === 0 ? 'done' : 'failed');
            if (deleted.code !== 0) job.result.warnings.push({ key: 'Branch {branch} was kept: Git could not delete it', values: { branch: record.branch }, detail: deleted.stderr });
          } else {
            job.step('branch', 'skipped');
            job.result.warnings.push({ key: 'Branch {branch} was kept because it is not merged', values: { branch: record.branch } });
          }
        } else if (request.deleteBranch) job.step('branch', 'skipped');
        job.step('unregister', 'running');
        await this.unregister(views, signal);
        job.step('unregister', 'done');
      };
      const locked = async (skip: boolean) => {
        if (this.busy.has(request.worktree)) throw fail('This worktree is already being archived');
        this.busy.add(request.worktree);
        try { await run(skip); } finally { this.busy.delete(request.worktree); }
      };
      (job as Job & { resume?: (skip: boolean) => Promise<void> }).resume = locked;
      await locked(false);
    });
  }
}

/** Runs `task` over `items` with at most `limit` running at once, keeping their order. */
async function pool<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await task(items[index]); }
  }));
  return results;
}
