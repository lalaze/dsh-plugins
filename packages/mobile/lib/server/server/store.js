/** This plugin's state: one private JSON file, written atomically. */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { EXECUTOR_DATA_VERSION, emptyExecutorData } from './bridge/executor.js';
import { generateVapidKeys } from './push.js';
import { nodeX25519 } from './x25519.js';
export function newState(defaults = {}) {
    const keys = nodeX25519.generate();
    return {
        version: 1,
        // The relay routes by this ID; the `srv_` form matches Paseo's.
        hub: { id: `srv_${randomBytes(9).toString('base64url')}`, secretKey: Buffer.from(keys.secretKey).toString('base64url'), publicKey: Buffer.from(keys.publicKey).toString('base64url') },
        settings: { name: defaults.name || hostname().replace(/\.local$/i, ''), relay: defaults.relay ?? '', tls: defaults.tls ?? true, appUrl: defaults.appUrl ?? '' },
        vapid: generateVapidKeys(),
        phones: {},
        executor: emptyExecutorData(),
    };
}
export class Store {
    file;
    state;
    timer;
    writing = Promise.resolve();
    constructor(file, state) {
        this.file = file;
        this.state = state;
    }
    static async open(dir, defaults = {}) {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        const file = join(dir, 'state.json');
        let state;
        try {
            state = JSON.parse(await readFile(file, 'utf8'));
            if (state.version !== 1 || !state.hub?.secretKey)
                throw new Error(`Unsupported state in ${file}`);
            state.executor ??= emptyExecutorData();
            state.executor.sessions ??= {};
            state.executor.handled ??= {};
            // Facts cached by an older version (titles, models) are read again.
            if (state.executor.version !== EXECUTOR_DATA_VERSION) {
                state.executor.sessions = {};
                state.executor.version = EXECUTOR_DATA_VERSION;
            }
            state.phones ??= {};
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
            state = newState(defaults);
        }
        const store = new Store(file, state);
        await store.flush();
        return store;
    }
    /** Write soon; several changes share one write. */
    save() {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => { void this.flush(); }, 200);
    }
    flush() {
        clearTimeout(this.timer);
        this.timer = undefined;
        const text = JSON.stringify(this.state);
        this.writing = this.writing.then(async () => {
            const temporary = `${this.file}.${process.pid}.tmp`;
            await writeFile(temporary, text, { mode: 0o600 });
            await rename(temporary, this.file);
        }).catch(error => { console.warn('[dsh-mobile] Could not save state', error); });
        return this.writing;
    }
}
