import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ROUTE } from './domain.js';
import { createHandler } from './http.js';
import { AssetService } from './service.js';
import { workingDirectoryOf } from './session-cwd.js';
export const name = 'dsh-game-assets';
export const inject = ['connection'];
const stateDir = () => join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'storages', name);
/**
 * Host half: scans the workspace of a conversation for images and for the code that names them, and serves the images to
 * the Assets tab; on request it retires images and saves tags there (manage.ts). A workspace on a remote machine is
 * worked on through Remote Agents' connection to it, by a script sent to that machine (remote-agent.ts).
 */
export function apply(ctx) {
    const get = (service) => ctx.get(service);
    // The build writes the remote script next to lib/server.
    let script;
    const remoteScript = () => script ??= readFile(new URL('../remote-agent.cjs', import.meta.url), 'utf8').catch(error => { script = undefined; throw error; });
    const assets = new AssetService(id => workingDirectoryOf(get, id), join(stateDir(), 'workspaces.json'), { machines: () => ctx.get('remoteAgentsMachines'), remoteScript });
    const log = (message) => ctx.get('logger')?.warn?.(message);
    // The host connection supplies authentication and origin checks.
    ctx.connection.fetch.register({ path: ROUTE, methods: ['GET', 'POST'], requestBody: 'buffered', fetch: createHandler(assets, log) });
}
