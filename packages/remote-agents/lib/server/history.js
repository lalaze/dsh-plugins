import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
export class TaskHistory {
    directory;
    taskId;
    entries = [];
    queue = Promise.resolve();
    failure;
    /** Raised when entries are replaced, so readers holding cursors start over. */
    generation = 0;
    /** Called after entries written here are saved; a shared host copies them to its registry. Not called for imports. */
    onAppend;
    constructor(directory, taskId) {
        this.directory = directory;
        this.taskId = taskId;
    }
    get epoch() { return `task-${this.taskId}${this.generation ? `-${this.generation}` : ''}`; }
    get file() { return join(this.directory, 'events', `${this.taskId}.jsonl`); }
    async open() {
        let data;
        try {
            data = await readFile(join(this.directory, 'events', `${this.taskId}.jsonl`), 'utf8');
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return;
            throw error;
        }
        if (data && !data.endsWith('\n'))
            throw new Error('Task history has an incomplete record; restore its event log before continuing');
        const lines = data.split('\n');
        for (let i = 0; i < lines.length; i++) {
            if (!lines[i])
                continue;
            let entry;
            try {
                entry = JSON.parse(lines[i]);
            }
            catch {
                throw new Error('Task history is damaged; restore its event log before continuing');
            }
            if (entry.seqStart !== this.entries.length + 1 || entry.seqEnd !== entry.seqStart || typeof entry.item?.type !== 'string')
                throw new Error('Invalid task history sequence');
            this.entries.push(entry);
        }
    }
    append(item, turnId, relay) { return this.appendBatch([{ item, turnId }], relay); }
    /**
     * One write for everything a CLI output line produced. Every entry records the relay byte
     * offset after that line, so a restarted DSH resumes there without repeating or losing output.
     */
    appendBatch(items, relay) {
        const saved = structuredClone(items), position = relay && structuredClone(relay);
        const next = this.queue.then(async () => {
            if (this.failure)
                throw this.failure;
            if (!saved.length)
                return;
            const timestamp = new Date().toISOString();
            const entries = saved.map(({ item, turnId }, index) => ({ seqStart: this.entries.length + index + 1, seqEnd: this.entries.length + index + 1, timestamp, item, ...(turnId ? { turnId } : {}), ...(position ? { relay: position } : {}) }));
            await mkdir(join(this.directory, 'events'), { recursive: true, mode: 0o700 });
            await appendFile(join(this.directory, 'events', `${this.taskId}.jsonl`), entries.map(e => `${JSON.stringify(e)}\n`).join(''), { mode: 0o600 });
            this.entries.push(...entries);
            try {
                this.onAppend?.();
            }
            catch { /* Copying is retried by its owner. */ }
        });
        this.queue = next.catch(error => { this.failure = error; });
        return next;
    }
    /** Number of saved entries, once queued writes finished. */
    async length() { await this.queue; return this.entries.length; }
    /** Entries `from`…`to` (1-based, inclusive) as saved lines. */
    async lines(from, to = Infinity) {
        await this.queue;
        return this.entries.slice(Math.max(0, from - 1), Math.min(this.entries.length, to)).map(e => JSON.stringify(e));
    }
    /** Append entries another DSH recorded. They must continue this history's sequence. */
    importLines(lines) {
        const next = this.queue.then(async () => {
            if (this.failure)
                throw this.failure;
            const entries = lines.map((line, index) => {
                let entry;
                try {
                    entry = JSON.parse(line);
                }
                catch {
                    throw new Error('A shared history entry is damaged');
                }
                if (entry?.seqStart !== this.entries.length + index + 1 || entry.seqEnd !== entry.seqStart || typeof entry.item?.type !== 'string')
                    throw new Error('A shared history entry is out of sequence');
                return entry;
            });
            if (!entries.length)
                return;
            await mkdir(join(this.directory, 'events'), { recursive: true, mode: 0o700 });
            await appendFile(this.file, entries.map(e => `${JSON.stringify(e)}\n`).join(''), { mode: 0o600 });
            this.entries.push(...entries);
        });
        this.queue = next.catch(error => { this.failure = error; });
        return next;
    }
    /** Keep only the first `seq` entries: what this DSH recorded after losing a shared session is replaced by the shared history. */
    truncate(seq) {
        const next = this.queue.then(async () => {
            if (this.failure)
                throw this.failure;
            if (seq >= this.entries.length)
                return;
            const kept = this.entries.slice(0, Math.max(0, seq)), temporary = `${this.file}.${randomUUID()}.tmp`;
            await mkdir(join(this.directory, 'events'), { recursive: true, mode: 0o700 });
            try {
                await writeFile(temporary, kept.map(e => `${JSON.stringify(e)}\n`).join(''), { mode: 0o600, flag: 'wx' });
                await rename(temporary, this.file);
            }
            finally {
                await rm(temporary, { force: true });
            }
            this.entries = kept;
            this.generation++;
        });
        this.queue = next.catch(error => { this.failure = error; });
        return next;
    }
    /** Where to resume reading a relay: after the last output line whose entries were saved. */
    async checkpoint(relayId) {
        await this.queue;
        return structuredClone(this.entries.findLast(e => e.relay?.id === relayId)?.relay);
    }
    /** The latest submitted message and everything recorded after it. */
    async turn() {
        await this.queue;
        const start = this.entries.findLastIndex(e => e.item.type === 'user_message');
        return structuredClone(start < 0 ? { entries: this.entries } : { message: this.entries[start], entries: this.entries.slice(start + 1) });
    }
    async page(cursor, direction = 'before') {
        await this.queue;
        const reset = !!cursor && cursor.epoch !== this.epoch;
        const selected = this.entries.filter(e => !cursor || reset || (direction === 'after' ? e.seqStart > cursor.seq : e.seqStart < cursor.seq));
        const entries = direction === 'after' && !reset ? selected.slice(0, 100) : selected.slice(-100);
        const first = entries[0]?.seqStart, last = entries.at(-1)?.seqEnd;
        return { epoch: this.epoch, reset, staleCursor: reset, gap: false, entries: structuredClone(entries), startCursor: first ? { epoch: this.epoch, seq: first } : null, endCursor: last ? { epoch: this.epoch, seq: last } : null, hasOlder: !!first && first > 1, hasNewer: !!last && last < this.entries.length };
    }
    async hasMessage(id) { await this.queue; return this.entries.some(e => e.item.type === 'user_message' && e.item.clientMessageId === id); }
    async messagePage(messageId, cursor) {
        await this.queue;
        return messageTimeline(this.entries, this.epoch, messageId, cursor);
    }
    /** Assistant text written since the latest user message, for delegation results. */
    async lastReply() {
        await this.queue;
        const parts = [];
        for (let i = this.entries.length - 1; i >= 0 && this.entries[i].item.type !== 'user_message'; i--) {
            const item = this.entries[i].item;
            if (item.type === 'assistant_message' && typeof item.text === 'string')
                parts.push(item.text);
        }
        return parts.reverse().join('');
    }
    async flush() { await this.queue; }
    async remove() {
        await this.queue.catch(() => { });
        this.failure = new Error('Agent history was deleted');
        await rm(join(this.directory, 'events', `${this.taskId}.jsonl`), { force: true });
    }
}
export function messageTimeline(all, epoch, messageId, cursor) {
    if (cursor && cursor.epoch !== epoch)
        throw new Error('Remote message history changed');
    const start = all.findIndex(e => e.item.type === 'user_message' && e.item.clientMessageId === messageId);
    const next = start < 0 ? -1 : all.findIndex((e, i) => i > start && e.item.type === 'user_message');
    const selected = start < 0 ? [] : all.slice(start + 1, next < 0 ? undefined : next).filter(e => !cursor || e.seqStart > cursor.seq);
    const entries = structuredClone(selected.slice(0, 100));
    const deliveryConfirmed = start >= 0 && (all[start].item.delivery !== 'pending' || all.slice(start + 1, next < 0 ? undefined : next).some(e => e.item.type === 'delivery' && e.item.clientMessageId === messageId));
    const terminal = start < 0 ? undefined : all.slice(start + 1, next < 0 ? undefined : next).findLast(e => e.item.type === 'turn_end' && e.item.clientMessageId === messageId);
    return { found: start >= 0, deliveryConfirmed, hasFollowingMessage: next >= 0, ...(terminal ? { terminalStatus: String(terminal.item.status) } : {}), epoch, entries, reset: false, staleCursor: false, gap: false,
        startCursor: entries.length ? { epoch, seq: entries[0].seqStart } : null,
        endCursor: entries.length ? { epoch, seq: entries.at(-1).seqEnd } : cursor ?? null,
        hasOlder: false, hasNewer: selected.length > entries.length };
}
