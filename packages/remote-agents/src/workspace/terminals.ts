import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-connection';
import { join } from 'node:path';
import { field, identifier, RemoteError } from '@dsh-plugins/remote-core/domain.js';
import type { MachineFiles, RemoteAgentsMachines } from '@dsh-plugins/remote-core/machines.js';
import { requireClient, transferBody, transferFailure, transferSize } from '@dsh-plugins/remote-core/transfer.js';
import type { RemoteUsageRecord } from '@dsh-plugins/remote-core/usage.js';
import { workspacePath, type WorkspaceTarget } from '@dsh-plugins/remote-core/workspace.js';
import { endClosedTerminals, installWorkspaceTerminal, type ClosableTerminals } from './terminal.js';
import { installTuiActivity } from './tui-activity.js';
import { TuiFiles } from './tui-files.js';
import { TuiRemote } from './tui-remote.js';
import type { TuiStore } from './tui-state.js';
import { TuiUsage } from './tui-usage.js';
import { CODEX_THREAD_NAME, TuiSessions } from './tui.js';
import { WorktreeService, type DshWorkspaceController, type WorkspaceTags } from './worktrees.js';
import type { ArchiveCheck, ArchiveRequest, CreateRequest, JobAction, WorkspaceMachine, WorktreeJob, WorktreeProject, WorktreeProjectDetail } from './worktrees.js';

/**
 * Worktree workspaces for other DSH plugins, as the service `remoteAgentsWorktrees`: what "New workspace from a project"
 * does, for a project on this computer or on a saved machine, and a way to run Git and shell commands in a workspace's
 * folder. A create or archive answers with a job; `job` reads how far it is and `act` answers what it stopped to ask.
 */
export interface RemoteAgentsWorktrees {
  readonly version: 1;
  projects(signal?: AbortSignal): Promise<WorktreeProject[]>;
  inspect(path: string, signal?: AbortSignal): Promise<WorktreeProjectDetail>;
  create(request: CreateRequest): WorktreeJob;
  job(id: string): WorktreeJob;
  act(id: string, action: JobAction): Promise<WorktreeJob>;
  archiveCheck(path: string, worktree: string, signal?: AbortSignal): Promise<ArchiveCheck>;
  archive(request: ArchiveRequest): WorktreeJob;
  /** `path` is a DSH workspace's path, as in a project or a finished create. */
  machine(path: string, signal?: AbortSignal): Promise<WorkspaceMachine>;
}

/** `terminal.shell` is the Remote workspace launcher in DSH's shell menu, once installed. */
export interface Terminals { terminal: { shell?: string }; worktrees: WorktreeService; tui: TuiSessions }

/**
 * Terminals that open in a conversation's remote workspace and outlive DSH, conversations whose view is Claude Code or
 * Codex in such a terminal, and workspaces made from a project's Git worktrees. They reach the saved machines only
 * through `machines`, which Remote Agents provides.
 * @param tuiFile - the file `store` saves to, which a terminal's launcher reads.
 */
export function installTerminals(ctx: Context, machines: RemoteAgentsMachines, store: TuiStore, tuiFile: string): Terminals {
  /** Runs `action` on a conversation's machine, checked to be its machine still once the connection is ready. */
  const onMachine = async <T>(sessionId: string, signal: AbortSignal, action: (files: MachineFiles, target: WorkspaceTarget) => Promise<T>): Promise<T> => {
    const target = await machines.target(sessionId, signal);
    return machines.withWorkspace(target.hostId, async () => { await machines.target(sessionId, signal, target); }, files => action(files, target));
  };
  const remote = <T>(sessionId: string, signal: AbortSignal, action: (remote: TuiRemote, target: WorkspaceTarget) => Promise<T>) =>
    onMachine(sessionId, signal, (files, target) => action(new TuiRemote(files.transport), target));
  const endHolder = (sessionId: string, holder: string, signal: AbortSignal) => remote(sessionId, signal, tui => tui.endHolder(holder));

  // TUI conversations' usage, read from their CLIs' logs, as no relay sees their turns.
  const tuiUsage = new TuiUsage(store, {
    target: (id, signal) => machines.target(id, signal),
    // Every conversation is verified to be on the machine again before its log is read.
    read: (hostId, sessions, entries, signal) => machines.withWorkspace(hostId,
      async () => { for (const { sessionId, target } of sessions) await machines.target(sessionId, signal, target); },
      files => new TuiRemote(files.transport).tuiUsageLines(entries, signal)),
    emit: record => (ctx as unknown as { emit(name: 'remote-agents/usage', record: RemoteUsageRecord): void }).emit('remote-agents/usage', record),
    warn: message => (ctx.get('logger') as { warn?(text: string): void } | undefined)?.warn?.(message),
  });
  tuiUsage.start();
  ctx.effect(() => () => tuiUsage.close());
  installTuiActivity(ctx, store, id => tuiUsage.finished(id));

  const terminal: { shell?: string } = {};
  ctx.inject(['terminalController'], scoped => {
    scoped.effect(() => endClosedTerminals(scoped.get('terminalController') as ClosableTerminals, (sessionId, holder) => endHolder(sessionId, holder, AbortSignal.timeout(20_000))));
    let disposed = false, cleanup: (() => void) | undefined;
    void installWorkspaceTerminal(scoped.get('terminalController'), join(store.directory, 'terminal'), { hosts: machines.stateFile, tui: tuiFile })
      .then(({ shell, dispose }) => { if (disposed) dispose(); else { cleanup = () => { delete terminal.shell; dispose(); }; terminal.shell = shell; } })
      .catch(error => scoped.get('logger')?.warn?.(`Remote workspace terminal unavailable: ${String(error)}`));
    scoped.effect(() => () => { disposed = true; cleanup?.(); });
  });

  // New workspaces from a project: a Git worktree here or on a saved machine.
  const worktrees = new WorktreeService({
    machines, access: { resolve: (path, signal) => machines.resolve(path, signal) },
    anchors: { create: (hostId, path, signal) => machines.createWorkspace(hostId, path, signal) },
    dsh: () => ctx.get('workspaceController') as DshWorkspaceController | undefined,
    tags: () => ctx.get('workspaceTags') as WorkspaceTags | undefined,
    stopRemoteSessions: (hostId, folder) => machines.archiveSessionsIn(hostId, folder),
  });
  ctx.effect(() => () => worktrees.close());
  ctx.provide('remoteAgentsWorktrees', {
    version: 1,
    projects: signal => worktrees.projects(signal), inspect: (path, signal) => worktrees.inspect(path, signal),
    create: request => worktrees.create(request), job: id => worktrees.job(id), act: (id, action) => worktrees.act(id, action),
    archiveCheck: (path, worktree, signal) => worktrees.archiveCheck(path, worktree, signal), archive: request => worktrees.archive(request),
    machine: (path, signal) => worktrees.machine(path, signal),
  } satisfies RemoteAgentsWorktrees);

  const sessionController = () => ctx.get('sessionController') as { list(input: object): Promise<{ items?: { sessionId: string; blank?: boolean }[] }>; rename(input: { sessionId: string; title: string }): Promise<unknown>; selectModel(input: { sessionId: string; provider: string; model: string; reasoningEffort?: string }): Promise<unknown> } | undefined;
  const tui = new TuiSessions(store, {
    verify: (id, signal) => machines.target(id, signal),
    session: id => (ctx.get('sessions') as { get?(id: string): { append(type: string, data: unknown): unknown } | undefined } | undefined)?.get?.(id),
    agent: id => (ctx.get('agents') as { get?(id: string): unknown } | undefined)?.get?.(id),
    list: async () => (await sessionController()?.list({}))?.items ?? [],
    rename: async (sessionId, title) => { await sessionController()?.rename({ sessionId, title }); },
    selectModel: async selection => {
      const controller = sessionController();
      if (!controller) throw new Error('DSH sessions are not available yet');
      await controller.selectModel(selection);
    },
    titleRecords: (id, claudeSession, signal) => remote(id, signal, tui => tui.claudeTitleRecords(claudeSession)),
    codexThread: (id, signal) => remote(id, signal, (tui, target) => tui.codexThread(target.cwd, CODEX_THREAD_NAME, signal)),
    codexTitleRecords: (id, thread, signal) => remote(id, signal, tui => tui.codexTitleRecords(thread)),
    endHolder,
  });
  const files = new TuiFiles({
    isTui: id => tui.list().includes(id), directory: store.directory,
    attach: (id, path, input, size, sha256, signal) => onMachine(id, signal, (machine, target) => machine.attach(target.cwd, path, input, size, sha256, signal)),
  });
  ctx.connection.fetch.register({ path: '/api/remote-agents/tui-files', methods: ['POST'], requestBody: 'streaming', fetch: tuiFilesHandler(files) });
  return { terminal, worktrees, tui };
}

/** A file dropped or pasted into a TUI conversation, which comes back as its absolute path on the conversation's machine. */
export function tuiFilesHandler(files: TuiFiles) {
  return async (request: Request): Promise<Response> => {
    try {
      requireClient(request);
      const q = new URL(request.url).searchParams, sessionId = field(q.get('sessionId'), 'session ID', 256), size = transferSize(request);
      return Response.json({ path: await files.upload(sessionId, q.get('name'), transferBody(request, size), request.signal) }, { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) { return transferFailure(error); }
  };
}

const JOB_ACTIONS: readonly JobAction[] = ['cancel', 'retry', 'skip', 'discard', 'confirm'];
/** Worktree workspaces: a project's DSH workspace path, a worktree's path on its machine, and operation IDs. */
export async function worktreeAction(worktrees: WorktreeService, action: string, input: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
  const path = () => workspacePath(input.path, 'workspace path'), job = () => identifier(input.jobId);
  const name = (value: unknown, label: string) => value === undefined || value === '' ? undefined : field(value, label, 250);
  switch (action) {
    case 'worktreeProjects': return worktrees.projects(signal);
    case 'worktreeInspect': return worktrees.inspect(path(), signal);
    case 'createWorktree': {
      if (input.mode !== 'new' && input.mode !== 'existing') throw new RemoteError('Invalid worktree mode');
      const setup = Array.isArray(input.setup) && input.setup.every(command => typeof command === 'string') ? input.setup as string[] : undefined;
      return worktrees.create({ path: path(), mode: input.mode, base: name(input.base, 'branch'), branch: name(input.branch, 'branch'), setup });
    }
    case 'worktreeJob': return worktrees.job(job());
    case 'worktreeJobAction': {
      if (!JOB_ACTIONS.includes(input.jobAction as JobAction)) throw new RemoteError('Invalid worktree action');
      return worktrees.act(job(), input.jobAction as JobAction);
    }
    case 'worktreeArchiveCheck': return worktrees.archiveCheck(path(), workspacePath(input.worktree, 'worktree'), signal);
    case 'archiveWorktree': return worktrees.archive({ path: path(), worktree: workspacePath(input.worktree, 'worktree'), deleteBranch: input.deleteBranch === true });
  }
  throw new RemoteError('Unknown workspace action');
}

/** The requests about TUI conversations. */
export async function tuiAction(tui: TuiSessions, action: string, input: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
  if (action === 'tuiSessions') return { sessions: tui.list(), codex: tui.codex(), localScroll: tui.localScroll() };
  if (action === 'tuiScroll') {
    if (typeof input.local !== 'boolean') throw new RemoteError('Invalid scrolling choice');
    await tui.setLocalScroll(input.local);
    return { localScroll: input.local };
  }
  const sessionId = field(input.sessionId, 'session ID', 256);
  if (action === 'tuiStart') {
    await tui.start(sessionId, { cli: input.cli, model: input.model, effort: input.effort }, signal);
    return { sessionId };
  }
  if (action === 'tuiTitle') return { title: await tui.syncTitle(sessionId, input.current, signal) };
  if (action === 'tuiEnd') { await tui.end(sessionId, signal); return { ok: true }; }
  throw new RemoteError('Unknown workspace action');
}
