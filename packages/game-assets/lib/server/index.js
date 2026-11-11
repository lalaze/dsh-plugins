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
 * the Assets tab. It reads files only; the one thing it writes is which folders each workspace scans, in the DSH home.
 */
export function apply(ctx) {
    const get = (service) => ctx.get(service);
    const assets = new AssetService(id => workingDirectoryOf(get, id), join(stateDir(), 'workspaces.json'));
    const log = (message) => ctx.get('logger')?.warn?.(message);
    // The host connection supplies authentication and origin checks.
    ctx.connection.fetch.register({ path: ROUTE, methods: ['GET', 'POST'], requestBody: 'buffered', fetch: createHandler(assets, log) });
}
