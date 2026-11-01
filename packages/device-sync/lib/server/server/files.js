import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
/** Read JSON, or undefined when the file does not exist. An unreadable file is moved aside and treated as missing. */
export async function readJson(path) {
    let raw;
    try {
        raw = await readFile(path, 'utf8');
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return undefined;
        throw error;
    }
    try {
        return JSON.parse(raw);
    }
    catch {
        const kept = `${path}.unreadable-${Date.now()}`;
        await rename(path, kept);
        console.warn(`[dsh-device-sync] ${path} was not valid JSON; moved it to ${kept}`);
        return undefined;
    }
}
/** Replace a file in one step, readable only by this user: a crash leaves the old or the new file, never half of one. */
export async function writeJsonAtomic(path, value) {
    await writeAtomic(path, JSON.stringify(value));
}
export async function writeAtomic(path, data) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
        await writeFile(temp, data, { mode: 0o600, flag: 'wx' });
        await rename(temp, path);
    }
    finally {
        await rm(temp, { force: true }).catch(() => { });
    }
}
export async function appendLines(path, lines) {
    if (lines.length === 0)
        return;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await appendFile(path, lines.map(line => `${line}\n`).join(''), { mode: 0o600 });
}
/** Runs tasks one at a time, in order; a failed task does not stop the ones after it. */
export class Serial {
    tail = Promise.resolve();
    run(task) {
        const next = this.tail.then(task);
        this.tail = next.catch(() => { });
        return next;
    }
}
