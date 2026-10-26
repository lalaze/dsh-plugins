import { mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validRecord } from './domain.js';
// Keep ownership across module reloads as well as plugin disable/re-enable.
const registryKey = Symbol.for('dsh-usage-stats.stores.v1');
const processState = globalThis;
const stores = processState[registryKey] ??= new Map();
/** Each plugin and running stream holds a lease until it no longer uses the file. */
export function acquireUsageStore(path) {
    const key = resolve(path);
    let entry = stores.get(key);
    if (!entry) {
        const store = new UsageStore(key);
        entry = { ready: store.load().then(() => store), references: 0 };
        stores.set(key, entry);
        const loading = entry;
        void entry.ready.catch(() => { if (stores.get(key) === loading)
            stores.delete(key); });
    }
    const shared = entry;
    shared.references++;
    let released = false;
    return { ready: shared.ready, release: () => {
            if (released)
                return;
            released = true;
            if (--shared.references === 0 && stores.get(key) === shared)
                stores.delete(key);
        } };
}
/** Serialized atomic snapshots: a failed write never replaces the last committed file. */
export class UsageStore {
    path;
    records = [];
    queue = Promise.resolve();
    failedWrites = 0;
    constructor(path) {
        this.path = path;
    }
    async load() {
        let raw;
        try {
            raw = await readFile(this.path, 'utf8');
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return;
            throw error;
        }
        const value = JSON.parse(raw);
        if (value?.version !== 1 || !Array.isArray(value.records) || !value.records.every(validRecord))
            throw new Error("Invalid usage data format; preserve and inspect the original file");
        this.records = value.records;
    }
    snapshot() { return structuredClone(this.records); }
    append(record) {
        const copy = structuredClone(record);
        const task = this.queue.then(async () => {
            if (!validRecord(copy))
                throw new Error("Invalid usage record");
            const next = [...this.records, copy];
            const temp = `${this.path}.${randomUUID()}.tmp`;
            try {
                await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
                await writeFile(temp, JSON.stringify({ version: 1, records: next }), { mode: 0o600, flag: 'wx' });
                await rename(temp, this.path);
                this.records = next;
            }
            finally {
                await rm(temp, { force: true }).catch(() => { });
            }
        });
        this.queue = task.catch(() => { this.failedWrites++; });
        return task;
    }
}
