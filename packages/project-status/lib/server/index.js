import { homedir } from 'node:os';
import { join } from 'node:path';
import { ROUTE } from './domain.js';
import { createHandler } from './http.js';
import { ProjectStatusService } from './service.js';
import { workingDirectoryOf } from './session-cwd.js';
import { StatusStore } from './store.js';
export const name = 'dsh-project-status';
export const inject = ['connection'];
const stateDir = () => join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'storages', name);
/**
 * Host half: keeps one status file per project in the DSH home and serves it to the Status tab with what Git says about
 * the conversation's folder. A project is a repository with all of its worktrees and branches (see project.ts); the file
 * is plain Markdown that the agents working on this computer read and write themselves (see status-file.ts).
 */
export function apply(ctx) {
    // Looked up when needed: plugins load in any order, and may be updated while this one runs.
    const get = (service) => ctx.get(service);
    const service = new ProjectStatusService(new StatusStore(stateDir()), {
        cwd: id => workingDirectoryOf(get, id),
        worktrees: () => get('remoteAgentsWorktrees'),
        sessions: async () => (await get('sessionController')?.list?.({}))?.items ?? [],
    });
    const log = (message) => get('logger')?.warn?.(message);
    ctx.provide('projectStatus', {
        version: 1,
        get: (folder, signal) => service.forFolder(folder, signal),
        list: () => service.list(),
    });
    // The host connection supplies authentication and origin checks.
    ctx.connection.fetch.register({ path: ROUTE, methods: ['POST'], requestBody: 'buffered', fetch: createHandler(service, log) });
}
