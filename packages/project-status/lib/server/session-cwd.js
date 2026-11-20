import { REMOTE_ANCHOR } from './domain.js';
/** The directory a conversation started in, from the live session or, before it is opened, from saved sessions. */
async function sessionCwd(get, sessionId) {
    const sessions = get('sessions');
    const live = sessions?.get?.(sessionId);
    if (live)
        return live.header.cwd;
    const persistence = get('sessionPersistence');
    const stored = (await persistence?.list() ?? []).map(row => 'header' in row ? row.header : row).find(row => row.id === sessionId);
    // A session activated meanwhile is the authority.
    return sessions?.get?.(sessionId)?.header.cwd ?? stored?.cwd;
}
const directory = (value) => typeof value === 'string' && value !== '' ? value : undefined;
/** DSH's record of where a session moved; undefined when it has none, which leaves the session where it started. */
async function movedTo(get, sessionId) {
    try {
        const live = get('sessions')?.get?.(sessionId);
        if (live)
            return directory(get('workingDirectory')?.get?.(live));
        const controller = get('sessionController');
        return directory((await controller?.projections?.({ sessionId }, AbortSignal.timeout(5000)))?.values?.workingDirectory);
    }
    catch {
        return undefined;
    }
}
/**
 * The directory a conversation works in now: a session that moved into a worktree shows that worktree's assets. A remote
 * workspace stays on its anchor, which the service refuses.
 */
export async function workingDirectoryOf(get, sessionId) {
    const started = await sessionCwd(get, sessionId);
    if (!started || REMOTE_ANCHOR.test(started))
        return started;
    return await movedTo(get, sessionId) ?? started;
}
