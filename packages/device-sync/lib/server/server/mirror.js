/**
 * Read-only copies of another machine's sessions, kept in this plugin's own storage and never in DSH's session store.
 *
 * Each session is an append-only file of shared events. Appends only take events after the stored position, and
 * reads drop repeated sequence numbers, so a retried or interrupted fetch can never show an event twice. Attachments
 * are stored once per content hash, whichever sessions refer to them.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { titleOf } from './events.js';
import { appendLines, readJson, Serial, writeAtomic, writeJsonAtomic } from './files.js';
const safeId = (id) => {
    if (!/^[\w.-]{1,200}$/.test(id))
        throw new Error('Invalid identifier');
    return id;
};
export class Mirror {
    deviceId;
    dir;
    index = { version: 1, workspaces: [], sessions: {} };
    serial = new Serial();
    constructor(deviceId, dir) {
        this.deviceId = deviceId;
        this.dir = dir;
    }
    async load() {
        const stored = await readJson(join(this.dir, 'index.json'));
        if (stored?.version === 1)
            this.index = { version: 1, cursor: stored.cursor, workspaces: stored.workspaces ?? [], sessions: stored.sessions ?? {} };
    }
    save() { return writeJsonAtomic(join(this.dir, 'index.json'), this.index); }
    get cursor() { return this.index.cursor; }
    workspaces() { return this.index.workspaces; }
    /** Apply one changes response, then remember its cursor. */
    update(changes) {
        return this.serial.run(async () => {
            if (changes.workspaces)
                this.index.workspaces = changes.workspaces;
            for (const entry of changes.sessions) {
                const id = safeId(entry.sessionId);
                const old = this.index.sessions[id];
                this.index.sessions[id] = { ...entry, storedSeq: old?.storedSeq ?? -1, ...(old?.hidden ? { hidden: true } : {}),
                    ...(old?.localTitle ? { localTitle: old.localTitle } : {}), ...(old?.attachments ? { attachments: old.attachments } : {}) };
            }
            this.index.cursor = changes.cursor;
            await this.save();
        });
    }
    /** Replace one entry's live status without touching its stored events. */
    status(entry) {
        return this.serial.run(async () => {
            const old = this.index.sessions[safeId(entry.sessionId)];
            if (!old)
                return;
            this.index.sessions[entry.sessionId] = { ...old, ...entry, storedSeq: old.storedSeq };
            await this.save();
        });
    }
    session(sessionId) { return this.index.sessions[sessionId]; }
    /** Sessions whose executing machine has events this copy lacks. */
    behind() { return Object.values(this.index.sessions).filter(s => !s.removed && s.lastSeq > s.storedSeq); }
    views() {
        return Object.values(this.index.sessions).map(({ localTitle, attachments: _attachments, title, ...session }) => ({
            ...session, deviceId: this.deviceId, ...(title ?? localTitle ? { title: title ?? localTitle } : {}),
        }));
    }
    /**
     * Store events after the stored position; everything through `through` counts as held afterwards.
     * @returns the events that were new.
     */
    append(sessionId, events, through, attachments = {}) {
        return this.serial.run(async () => {
            const session = this.index.sessions[safeId(sessionId)];
            if (!session)
                return [];
            const fresh = events.filter(event => event.seq > session.storedSeq).sort((a, b) => a.seq - b.seq);
            await appendLines(this.logPath(sessionId), fresh.map(event => JSON.stringify(event)));
            session.storedSeq = Math.max(session.storedSeq, through, fresh.at(-1)?.seq ?? -1);
            const title = titleOf(fresh);
            if (title)
                session.localTitle = title;
            for (const [id, meta] of Object.entries(attachments))
                session.attachments = { ...session.attachments, [id]: { ...session.attachments?.[id], ...meta } };
            await this.save();
            return fresh;
        });
    }
    /** Stored events in order, each sequence once, optionally after a position and up to a count from the end. */
    async read(sessionId, options = {}) {
        const path = this.logPath(safeId(sessionId));
        try {
            await access(path);
        }
        catch {
            return [];
        }
        const bySeq = new Map();
        const lines = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity });
        for await (const line of lines) {
            if (!line.trim())
                continue;
            try {
                const event = JSON.parse(line);
                if (typeof event.seq === 'number' && event.seq > (options.after ?? -1) && !bySeq.has(event.seq))
                    bySeq.set(event.seq, event);
            }
            catch { /* a line cut short by a crash; the fetch after it repeats the event */ }
        }
        const events = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
        return options.last ? events.slice(-options.last) : events;
    }
    attachment(sessionId, attachmentId) { return this.index.sessions[sessionId]?.attachments?.[attachmentId]; }
    setAttachment(sessionId, attachmentId, meta) {
        return this.serial.run(async () => {
            const session = this.index.sessions[sessionId];
            if (!session)
                return;
            session.attachments = { ...session.attachments, [attachmentId]: { ...session.attachments?.[attachmentId], ...meta } };
            await this.save();
        });
    }
    /** Hide a session here, or show it again. Nothing is deleted. */
    hide(sessionId, hidden) {
        return this.serial.run(async () => {
            const session = this.index.sessions[sessionId];
            if (!session)
                throw new Error('Unknown session');
            if (hidden)
                session.hidden = true;
            else
                delete session.hidden;
            await this.save();
        });
    }
    /** Everything this copy stores, for a backup. */
    snapshot() { return structuredClone(this.index); }
    /** Delete the copy entirely, after the user chose to forget a machine's history. */
    destroy() { return this.serial.run(() => rm(this.dir, { recursive: true, force: true })); }
    logPath(sessionId) { return join(this.dir, 'sessions', `${safeId(sessionId)}.jsonl`); }
}
/** Attachment bytes stored by SHA-256, shared by every mirror. */
export class Blobs {
    dir;
    constructor(dir) {
        this.dir = dir;
    }
    path(sha256) {
        if (!/^[0-9a-f]{64}$/.test(sha256))
            throw new Error('Invalid content hash');
        return join(this.dir, sha256.slice(0, 2), sha256);
    }
    async has(sha256) {
        try {
            await stat(this.path(sha256));
            return true;
        }
        catch {
            return false;
        }
    }
    async put(data) {
        const sha256 = createHash('sha256').update(data).digest('hex');
        if (!await this.has(sha256))
            await writeAtomic(this.path(sha256), data);
        return sha256;
    }
    get(sha256) { return readFile(this.path(sha256)); }
    async count() {
        try {
            let total = 0;
            for (const shard of await readdir(this.dir))
                total += (await readdir(join(this.dir, shard))).length;
            return total;
        }
        catch {
            return 0;
        }
    }
}
export async function ensureDir(path) { await mkdir(path, { recursive: true, mode: 0o700 }); }
