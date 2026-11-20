import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-connection';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ROUTE, type ProjectStatusEntry } from './domain.js';
import type { RemoteWorktrees } from './git.js';
import { createHandler } from './http.js';
import { ProjectStatusService, type SessionRow } from './service.js';
import { workingDirectoryOf } from './session-cwd.js';
import { StatusStore } from './store.js';

/** What other host plugins may read of the statuses, as the service `projectStatus`. */
export interface ProjectStatus {
  readonly version: 1;
  /** The status of the project a folder belongs to: a workspace's path, or any checkout of the repository. */
  get(folder: string, signal?: AbortSignal): Promise<ProjectStatusEntry>;
  /** Every project that has been opened in the Status tab. */
  list(): Promise<ProjectStatusEntry[]>;
}

declare module '@deepseek-ai/cordis' {
  interface Context { projectStatus: ProjectStatus }
}

export const name = 'dsh-project-status';
export const inject = ['connection'];

const stateDir = () => join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'storages', name);

/**
 * Host half: keeps one status file per project in the DSH home and serves it to the Status tab with what Git says about
 * the conversation's folder. A project is a repository with all of its worktrees and branches (see project.ts); the file
 * is plain Markdown that the agents working on this computer read and write themselves (see status-file.ts).
 */
export function apply(ctx: Context): void {
  // Looked up when needed: plugins load in any order, and may be updated while this one runs.
  const get = (service: string) => ctx.get(service);
  const service = new ProjectStatusService(new StatusStore(stateDir()), {
    cwd: id => workingDirectoryOf(get, id),
    worktrees: () => get('remoteAgentsWorktrees') as RemoteWorktrees | undefined,
    sessions: async () => (await (get('sessionController') as { list?(input: object): Promise<{ items?: SessionRow[] }> } | undefined)?.list?.({}))?.items ?? [],
  });
  const log = (message: string) => (get('logger') as { warn?(text: string): void } | undefined)?.warn?.(message);
  ctx.provide('projectStatus', {
    version: 1,
    get: (folder, signal) => service.forFolder(folder, signal),
    list: () => service.list(),
  } satisfies ProjectStatus);
  // The host connection supplies authentication and origin checks.
  ctx.connection.fetch.register({ path: ROUTE, methods: ['POST'], requestBody: 'buffered', fetch: createHandler(service, log) });
}
