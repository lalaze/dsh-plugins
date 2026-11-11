import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
const record = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
/** The TUI part of a saved state, without what does not fit: a conversation without details still opens as Claude Code. */
function tuiState(value) {
    const saved = record(value) ?? {}, details = record(saved.tuiDetails);
    return {
        ...(Array.isArray(saved.tuiSessions) ? { tuiSessions: saved.tuiSessions.filter((id) => typeof id === 'string') } : {}),
        ...(details ? { tuiDetails: Object.fromEntries(Object.entries(details).filter(([, entry]) => record(entry))) } : {}),
        ...(typeof saved.tuiLocalScroll === 'boolean' ? { tuiLocalScroll: saved.tuiLocalScroll } : {}),
    };
}
/** What the plugin saves, in one JSON file a terminal's launcher also reads; see terminal.ts. */
export class TerminalsState {
    file;
    state = { version: 1 };
    writes = Promise.resolve();
    constructor(file) {
        this.file = file;
    }
    get directory() { return dirname(this.file); }
    async open() {
        let text;
        try {
            text = await readFile(this.file, 'utf8');
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return;
            throw error;
        }
        // A damaged file is not replaced with an empty one: that would forget which conversations are TUI conversations.
        const saved = record(JSON.parse(text));
        if (saved?.version !== 1)
            throw new Error('Invalid remote terminals state');
        this.state = { version: 1, ...tuiState(saved), ...(saved.adopted === true ? { adopted: true } : {}) };
    }
    snapshot() { const { version: _version, adopted: _adopted, ...tui } = this.state; return structuredClone(tui); }
    /** Changes are saved one after another; a change that throws saves nothing. */
    update(change) { return this.save(change); }
    save(change) {
        const saved = this.writes.then(async () => {
            const next = structuredClone(this.state);
            change(next);
            await mkdir(this.directory, { recursive: true, mode: 0o700 });
            const temp = `${this.file}.${randomUUID()}.tmp`;
            try {
                await writeFile(temp, `${JSON.stringify(next)}\n`, { mode: 0o600 });
                await rename(temp, this.file);
            }
            finally {
                await rm(temp, { force: true });
            }
            this.state = next;
        });
        this.writes = saved.catch(() => { });
        return saved;
    }
    /**
     * Remote Agents kept TUI conversations in its own state until 0.2.129. They are taken over once, from the file that
     * plugin names, and left there, so that going back to that version finds them.
     */
    async adopt(remoteAgentsState) {
        if (this.state.adopted)
            return;
        let theirs = {};
        try {
            theirs = tuiState(JSON.parse(await readFile(remoteAgentsState, 'utf8')));
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
        }
        await this.save(state => {
            state.adopted = true;
            // Anything started here since comes first; theirs are older.
            const sessions = [...new Set([...theirs.tuiSessions ?? [], ...state.tuiSessions ?? []])];
            if (sessions.length)
                state.tuiSessions = sessions;
            if (theirs.tuiDetails || state.tuiDetails)
                state.tuiDetails = { ...theirs.tuiDetails, ...state.tuiDetails };
            if (state.tuiLocalScroll === undefined && theirs.tuiLocalScroll !== undefined)
                state.tuiLocalScroll = theirs.tuiLocalScroll;
        });
    }
    /** Waits for what is being saved. */
    async close() { await this.writes; }
}
