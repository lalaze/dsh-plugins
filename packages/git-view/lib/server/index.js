import { homedir } from 'node:os';
import { join } from 'node:path';
import { Credentials } from './credentials.js';
import { editorHandler } from './editor-route.js';
import { GitView } from './git.js';
import { createHandler } from './http.js';
import { gitExecutable, isRemoteAnchor, LocalRunner } from './runner.js';
export const name = 'dsh-git-view';
export const inject = ['connection', 'subprocess'];
/** A conversation's working directory, from the live session or, before it is opened, from saved sessions. */
async function sessionCwd(ctx, sessionId) {
    const sessions = ctx.get('sessions');
    const live = sessions?.get?.(sessionId);
    if (live)
        return live.header.cwd;
    const persistence = ctx.get('sessionPersistence');
    const stored = (await persistence?.list() ?? []).map(row => 'header' in row ? row.header : row).find(row => row.id === sessionId);
    // A session activated meanwhile is the authority.
    return sessions?.get?.(sessionId)?.header.cwd ?? stored?.cwd;
}
const stateDir = () => join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'storages', name);
export function apply(ctx) {
    const subprocess = ctx.get('subprocess'), git = gitExecutable(subprocess), credentials = new Credentials(join(stateDir(), 'git-credentials'));
    const view = new GitView({
        cwdOf: id => sessionCwd(ctx, id),
        isRemoteCwd: isRemoteAnchor,
        local: cwd => new LocalRunner(subprocess, git, cwd, () => credentials.config()),
        // Remote Agents runs Git in its remote workspaces; read it per request, as it may load, reload or leave at any time.
        remote: () => ctx.get('remoteAgentsWorkspaces'),
        credentials,
    });
    const log = (message) => ctx.get('logger')?.warn?.(message);
    ctx.connection.fetch.register({ path: '/api/git-view', methods: ['POST'], requestBody: 'buffered', fetch: createHandler(view, log) });
    // The client's EDITOR_SRC; the build writes the bundle next to lib/server.
    ctx.connection.fetch.register({ path: '/api/git-view/editor.js', methods: ['GET'], requestBody: 'buffered', fetch: editorHandler(new URL('../editor.js', import.meta.url)) });
}
