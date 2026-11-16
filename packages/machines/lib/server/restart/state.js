/** The restart hand-off between the running plugin, the detached helper and the next plugin instance. */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
export const isRestartMode = (value) => value === 'now' || value === 'idle';
export function readRecord(file) {
    try {
        return JSON.parse(readFileSync(file, 'utf8'));
    }
    catch {
        return undefined;
    }
}
/** Atomic: the helper and the plugin read this file while the other writes it. */
export function writeRecord(file, record) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(record, null, 2), { mode: 0o600 });
    renameSync(temporary, file);
}
/** Update the record only while it is still the given restart. */
export function updateRecord(file, id, change) {
    const record = readRecord(file);
    if (record?.id !== id)
        return undefined;
    const next = change(record);
    writeRecord(file, next);
    return next;
}
