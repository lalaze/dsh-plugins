import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';
import { join } from 'node:path';
import { permissionOf, type ToolDefinition, type ToolHost } from '../core/dsh-host.js';
import type { Store } from '../core/store.js';
import { dshHome, under, WorkspaceAccess, type WorkspacePlacement, type WorkspaceRuntime } from './access.js';
import { editorHandler } from './editor-route.js';
import type { WorkspaceHosts } from './hosts.js';
import { workspaceTransferHandler, type WorkspaceFeatures } from './http.js';
import type { GitBatch, GitRun, WorkspaceEntry, WorkspaceTarget } from './domain.js';
import { RemoteWorkspaces } from './remote-workspaces.js';
import { WorkspaceService } from './service.js';
import { installWorkspaceTerminal } from './terminal.js';
import { workspaceTools } from './tools.js';
import { WorkspaceTunnels } from './tunnels.js';

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
export interface Workspaces {
  /** Which saved machines and remote directory a local workspace path stands for. */
  access: WorkspaceAccess;
  /** The verified placement of a DSH conversation, rechecked so a workspace switch during verification yields none. */
  placement(sessionId: string, signal: AbortSignal): Promise<WorkspacePlacement>;
  workspaces: RemoteWorkspaces;
  features: WorkspaceFeatures & { tunnels: WorkspaceTunnels };
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
  ctx.inject(['terminalController'], scoped => {
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
    for (const tool of workspaceTools(files, host, agent => permissionOf(scoped, (agent as { session?: Session } | undefined)?.session))) host.tools.register(tool);
  });
  return { access, placement, workspaces, features: { files, tunnels, terminal } };
}
