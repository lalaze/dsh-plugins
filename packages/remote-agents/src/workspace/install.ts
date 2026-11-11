import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';
import { join } from 'node:path';
import { accessOf, type ToolDefinition, type ToolHost } from '@dsh-plugins/remote-core/dsh-host.js';
import { sharesSessions } from '@dsh-plugins/remote-core/domain.js';
import type { Store } from '../core/store.js';
import { dshHome, under, WorkspaceAccess, type WorkspacePlacement, type WorkspaceRuntime } from './access.js';
import { editorHandler } from './editor-route.js';
import type { WorkspaceHosts } from './hosts.js';
import { tuiFilesHandler, workspaceTransferHandler, type WorkspaceFeatures } from './http.js';
import { type GitBatch, type GitRun, type WorkspaceEntry, type WorkspaceTarget } from './domain.js';
import { RemoteWorkspaces } from './remote-workspaces.js';
import { WorkspaceTagSync, type WorkspaceTagsService } from './tag-sync.js';
import { WorkspaceService } from './service.js';
import { endClosedTerminals, installWorkspaceTerminal, type ClosableTerminals } from './terminal.js';
import { installTuiActivity } from './tui-activity.js';
import { TuiFiles } from './tui-files.js';
import { TuiUsage } from './tui-usage.js';
import { CODEX_THREAD_NAME, TuiSessions } from './tui.js';
import { workspaceTools } from './tools.js';
import { WorkspaceTunnels } from './tunnels.js';
import { WorktreeService, type DshWorkspaceController } from './worktrees.js';
import type { ArchiveCheck, ArchiveRequest, CreateRequest, JobAction, WorkspaceMachine, WorktreeJob, WorktreeProject, WorktreeProjectDetail } from './worktrees.js';

/**
 * What other DSH plugins on this host may do in a conversation's remote workspace, as the service `remoteAgentsWorkspaces`:
 * always on its verified machine and in its verified directory, which every call checks again. dsh-git-view runs Git
 * through it. Models use the `remote_workspace` tool instead, which offers no Git operation.
 */
export interface RemoteAgentsWorkspaces {
  /** Version 1 binds Git, transfers and cancellation to verified workspace targets. */
  readonly gitWorkspaceVersion: 1;
  target(sessionId: string, signal?: AbortSignal): Promise<WorkspaceTarget>;
  git(sessionId: string, batch: GitBatch, signal?: AbortSignal, expected?: WorkspaceTarget): Promise<GitRun[]>;
  cancelGit(sessionId: string, id: string, signal?: AbortSignal, expected?: WorkspaceTarget): Promise<void>;
  /** `path` is relative to the workspace, as in every call below; the revision is the file's SHA-256. */
  stat(sessionId: string, path: string, signal?: AbortSignal, expected?: WorkspaceTarget): Promise<{ path: string; revision: string; size: number }>;
  download(sessionId: string, path: string, revision: string, signal?: AbortSignal, expected?: WorkspaceTarget): Promise<Buffer>;
  /** Replaces the file read at `revision`, or creates it with null; a file changed since is refused. */
  upload(sessionId: string, path: string, revision: string | null, data: Uint8Array, signal?: AbortSignal, expected?: WorkspaceTarget): Promise<{ path: string; revision: string; size: number }>;
  /** A folder's entries, folders first. Absent before Remote Agents 0.2.64. */
  list?(sessionId: string, path: string, signal?: AbortSignal, expected?: WorkspaceTarget): Promise<{ path: string; entries: WorkspaceEntry[] }>;
  /** Deletes the file read at `revision`; a file changed since is refused. Absent before Remote Agents 0.2.64. */
  remove?(sessionId: string, path: string, revision: string, signal?: AbortSignal, expected?: WorkspaceTarget): Promise<{ path: string }>;
}
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
export interface Workspaces {
  /** Which saved machines and remote directory a local workspace path stands for. */
  access: WorkspaceAccess;
  /** The verified placement of a DSH conversation, rechecked so a workspace switch during verification yields none. */
  placement(sessionId: string, signal: AbortSignal): Promise<WorkspacePlacement>;
  workspaces: RemoteWorkspaces;
  features: WorkspaceFeatures & { tunnels: WorkspaceTunnels; worktrees: WorktreeService };
}

/**
 * Remote workspace tools on the saved machines: files, sync, tunnels, the native terminal's Remote workspace shell, the
 * `remote_workspace` tool and its system prompt. The caller closes `features.tunnels`.
 */
export async function installWorkspaces(ctx: Context, store: Store, machines: WorkspaceHosts): Promise<Workspaces> {
  const access = new WorkspaceAccess(() => store.hosts(), { runtime: () => ctx.get('subprocess') as WorkspaceRuntime | undefined });
  const workspaces = new RemoteWorkspaces(machines, access);
  const sessionCwd = async (sessionId: string): Promise<string | undefined> => {
    const sessions = ctx.get('sessions') as { get?(id: string): { header: { cwd?: string } } | undefined } | undefined;
    const live = () => sessions?.get?.(sessionId);
    const attached = live();
    if (attached) return attached.header.cwd;
    const persistence = ctx.get('sessionPersistence') as { list(): Promise<({ id: string; cwd?: string } | { header: { id: string; cwd?: string } })[]> } | undefined;
    const stored = (await persistence?.list() ?? []).map(row => 'header' in row ? row.header : row).find(row => row.id === sessionId);
    const activated = live();
    return activated ? activated.header.cwd : stored?.cwd;
  };
  const placement = async (id: string, signal: AbortSignal) => {
    const cwd = await sessionCwd(id), value = await access.resolve(cwd, signal);
    return cwd === await sessionCwd(id) ? value : { hostIds: [] };
  };
  const files = new WorkspaceService(machines, placement, sessionCwd);
  const unbounded = () => new AbortController().signal;
  ctx.provide('remoteAgentsWorkspaces', {
    gitWorkspaceVersion: 1,
    target: (id, signal = unbounded()) => files.target(id, signal),
    git: (id, batch, signal = unbounded(), expected) => files.git(id, batch, signal, expected),
    cancelGit: (id, job, signal = unbounded(), expected) => files.cancelGit(id, job, signal, expected),
    stat: async (id, path, signal = unbounded(), expected) => await files.operate(id, { op: 'stat', path }, signal, expected) as { path: string; revision: string; size: number },
    download: (id, path, revision, signal = unbounded(), expected) => files.download(id, path, revision, signal, expected),
    upload: async (id, path, revision, data, signal = unbounded(), expected) =>
      await files.upload(id, path, revision, data.length, (async function* () { yield data; })(), signal, expected) as { path: string; revision: string; size: number },
    list: async (id, path, signal = unbounded(), expected) => await files.operate(id, { op: 'list', path }, signal, expected) as { path: string; entries: WorkspaceEntry[] },
    remove: async (id, path, revision, signal = unbounded(), expected) => await files.operate(id, { op: 'remove', path, revision }, signal, expected) as { path: string },
  } satisfies RemoteAgentsWorkspaces);
  const tunnels = new WorkspaceTunnels(join(store.directory, 'workspace-tunnels.json'), () => store.hosts());
  await tunnels.open();
  const terminal: { shell?: string } = {};
  // Uploads stream; downloads need their own buffered route, because DSH builds every request of a streaming route
  // with the request stream as its body, and a GET request with a body cannot be built.
  const transfer = workspaceTransferHandler(files);
  ctx.connection.fetch.register({ path: '/api/remote-agents/files', methods: ['POST'], requestBody: 'streaming', fetch: transfer });
  ctx.connection.fetch.register({ path: '/api/remote-agents/download', methods: ['GET'], requestBody: 'buffered', fetch: transfer });
  // The client's EDITOR_SRC; the build writes the bundle next to lib/server.
  ctx.connection.fetch.register({ path: '/api/remote-agents/editor.js', methods: ['GET'], requestBody: 'buffered', fetch: editorHandler(new URL('../../editor.js', import.meta.url)) });
  // TUI conversations' usage, read from their CLIs' logs, as no relay sees their turns.
  const tuiUsage = new TuiUsage(store, {
    target: (id, signal) => files.target(id, signal),
    read: (hostId, sessions, entries, signal) => files.tuiUsageLines(hostId, sessions, entries, signal),
    emit: record => ctx.emit('remote-agents/usage', record),
    warn: message => (ctx.get('logger') as { warn?(text: string): void } | undefined)?.warn?.(message),
  });
  tuiUsage.start();
  ctx.effect(() => () => tuiUsage.close());
  installTuiActivity(ctx, store, id => tuiUsage.finished(id));
  ctx.inject(['terminalController'], scoped => {
    scoped.effect(() => endClosedTerminals(scoped.get('terminalController') as ClosableTerminals, (sessionId, holder) => files.endHolder(sessionId, holder, AbortSignal.timeout(20_000))));
    let disposed = false, cleanup: (() => void) | undefined;
    void installWorkspaceTerminal(scoped.get('terminalController'), join(store.directory, 'terminal'), join(store.directory, 'state.json'))
      .then(({ shell, dispose }) => { if (disposed) dispose(); else { cleanup = () => { delete terminal.shell; dispose(); }; terminal.shell = shell; } })
      .catch(error => scoped.get('logger')?.warn?.(`Remote workspace terminal unavailable: ${String(error)}`));
    scoped.effect(() => () => { disposed = true; cleanup?.(); });
  });
  ctx.inject(['systemPrompt'], scoped => {
    (scoped.get('systemPrompt') as { section(value: unknown): void }).section({ name: 'remote-agents-workspace', order: 88,
      text: ({ agent }: { agent?: { session?: { header?: { cwd?: string } } } }) => {
        const cwd = agent?.session?.header?.cwd;
        return cwd && under(join(dshHome(), 'remote-workspaces'), cwd)
          ? 'Remote workspace: the local directory is an anchor, not the project files. Use remote_workspace to list, read, search, edit and run commands in this conversation’s verified remote directory. Read remote AGENTS.md before making changes. Local filesystem and shell tools act on the DSH host; do not use them for remote project work.' : '';
      } });
  });
  ctx.inject(['tools', 'approval', 'userQuestions'], scoped => {
    const host = scoped as unknown as ToolHost & { tools: { register(tool: ToolDefinition): unknown } };
    // A delegated team member's sandbox counts as its permission: it may edit the workspace, and nobody can approve more.
    for (const tool of workspaceTools(files, host, agent => accessOf(scoped, (agent as { session?: Session } | undefined)?.session).permission)) host.tools.register(tool);
  });
  installTagSync(ctx, store, machines, access);
  // New workspaces from a project: a Git worktree here or on a saved machine.
  const worktrees = new WorktreeService({
    machines, access, anchors: workspaces,
    dsh: () => ctx.get('workspaceController') as DshWorkspaceController | undefined,
    tags: () => ctx.get('workspaceTags') as WorkspaceTagsService | undefined,
    stopRemoteSessions: (hostId, folder) => machines.archiveSessionsIn?.(hostId, folder) ?? Promise.resolve(),
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
    verify: (id, signal) => files.target(id, signal),
    session: id => (ctx.get('sessions') as { get?(id: string): { append(type: string, data: unknown): unknown } | undefined } | undefined)?.get?.(id),
    agent: id => (ctx.get('agents') as { get?(id: string): unknown } | undefined)?.get?.(id),
    list: async () => (await sessionController()?.list({}))?.items ?? [],
    rename: async (sessionId, title) => { await sessionController()?.rename({ sessionId, title }); },
    selectModel: async selection => {
      const controller = sessionController();
      if (!controller) throw new Error('DSH sessions are not available yet');
      await controller.selectModel(selection);
    },
    titleRecords: (id, claudeSession, signal) => files.claudeTitleRecords(id, claudeSession, signal),
    codexThread: (id, signal) => files.codexThread(id, CODEX_THREAD_NAME, signal),
    codexTitleRecords: (id, thread, signal) => files.codexTitleRecords(id, thread, signal),
    endHolder: (id, holder, signal) => files.endHolder(id, holder, signal),
  });
  ctx.connection.fetch.register({ path: '/api/remote-agents/tui-files', methods: ['POST'], requestBody: 'streaming',
    fetch: tuiFilesHandler(new TuiFiles({ isTui: id => tui.list().includes(id), directory: store.directory, attach: (...file) => files.attach(...file) })) });
  return { access, placement, workspaces, features: { files, tunnels, terminal, worktrees, tui } };
}

/** Workspace Tags follow a remote workspace to every DSH sharing its machine. */
function installTagSync(ctx: Context, store: Store, machines: WorkspaceHosts, access: WorkspaceAccess): void {
  const root = join(dshHome(), 'remote-workspaces');
  const listed = new Map<string, { workspaceId: string; path: string }>();
  const placements = new Map<string, { at: number; value: Promise<WorkspacePlacement> }>();
  const sync = new WorkspaceTagSync(store, {
    tags: () => ctx.get('workspaceTags') as WorkspaceTagsService | undefined,
    workspaces: () => [...listed.values()],
    targets: async path => {
      // Only this plugin's anchors stand for a remote directory; resolving one reads its metadata, so it is kept a while.
      if (!under(root, path)) return [];
      let cached = placements.get(path);
      if (!cached || Date.now() - cached.at > 600_000) placements.set(path, cached = { at: Date.now(), value: access.resolve(path) });
      const placement = await cached.value.catch(() => ({ hostIds: [] as string[], cwd: undefined }));
      const cwd = placement.cwd;
      return cwd ? placement.hostIds.filter(id => store.hosts().some(host => host.id === id && sharesSessions(host))).map(hostId => ({ hostId, remotePath: cwd })) : [];
    },
    shared: hostId => machines.sharedWorkspaceList(hostId),
    publish: (hostId, path, tags) => machines.setWorkspaceTags(hostId, path, tags),
    warn: message => { const logger = ctx.get('logger') as { warn?(text: string): void } | undefined; if (logger?.warn) logger.warn(message); else console.warn(`[dsh-remote-agents] ${message}`); },
  });
  // DSH lists its workspaces only as a stream; follow it, and start over when it ends.
  const controller = new AbortController();
  void (async () => {
    while (!controller.signal.aborted) {
      const workspaces = ctx.get('workspaceController') as { follow(signal: AbortSignal): AsyncIterable<{ type: string; value?: { items?: unknown[] }; workspace?: unknown; workspaceId?: string }> } | undefined;
      try {
        if (workspaces) for await (const frame of workspaces.follow(controller.signal)) {
          const keep = (item: unknown) => { const w = item as { workspaceId?: unknown; path?: unknown }; if (typeof w?.workspaceId === 'string' && typeof w.path === 'string') listed.set(w.workspaceId, { workspaceId: w.workspaceId, path: w.path }); };
          if (frame.type === 'baseline' || frame.type === 'replace') { listed.clear(); for (const item of frame.value?.items ?? []) keep(item); }
          else if (frame.type === 'upsert') keep(frame.workspace);
          else if (frame.type === 'remove' && frame.workspaceId) listed.delete(frame.workspaceId);
          else continue;
          sync.trigger();
        }
      } catch { /* followed again below */ }
      await new Promise(resolve => { const timer = setTimeout(resolve, 10_000); timer.unref?.(); controller.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(undefined); }, { once: true }); });
    }
  })();
  // Tags another DSH changed arrive with the host registry's report, so they are compared right away.
  const changed = () => sync.trigger();
  machines.sharedWorkspaceListeners?.add(changed);
  sync.start();
  ctx.effect(() => () => { controller.abort(); machines.sharedWorkspaceListeners?.delete(changed); sync.close(); });
}
