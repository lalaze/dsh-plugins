import { RemoteError } from '../core/domain.js';
/**
 * Conversations whose main view is the interactive Claude Code instead of DSH's chat. Each stays a real DSH session, so
 * it is a row in the workspace list. DSH shows no views in a session until its log has a turn, so starting one records
 * an empty turn. The conversation itself lives in the remote Claude Code; see the Remote Claude launcher in terminal.ts.
 */
export class TuiSessions {
    store;
    dsh;
    constructor(store, dsh) {
        this.store = store;
        this.dsh = dsh;
    }
    list() { return this.store.snapshot().tuiSessions ?? []; }
    async start(sessionId, signal) {
        await this.dsh.verify(sessionId, signal);
        if (this.list().includes(sessionId))
            return;
        const session = this.dsh.session(sessionId);
        if (!session)
            throw new RemoteError('This conversation is not open', 409);
        // Its turns would stay in DSH while Claude Code started from nothing.
        if ((await this.dsh.list()).find(row => row.sessionId === sessionId)?.blank === false)
            throw new RemoteError('Only a new conversation can start in the TUI', 409);
        signal.throwIfAborted();
        await this.store.update(state => { state.tuiSessions = [...state.tuiSessions ?? [], sessionId]; });
        session.append('turn/start', { turn: 1 });
        session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
        const now = new Date();
        await this.dsh.rename(sessionId, `Claude TUI ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`);
    }
}
