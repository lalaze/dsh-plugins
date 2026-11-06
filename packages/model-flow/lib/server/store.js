/** The models chosen in settings. Nothing about a running flow is saved: it ends with DSH. */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { combosFrom, roundsFrom } from './combos.js';
import { DEFAULT_ROUNDS } from './line.js';
import { routeFrom } from './routes.js';
export function configFrom(value) {
    const raw = value && typeof value === 'object' ? value : {};
    const plan = routeFrom(raw.plan), implement = routeFrom(raw.implement), review = routeFrom(raw.review);
    return {
        ...(plan ? { plan } : {}), ...(implement ? { implement } : {}), ...(review ? { review } : {}),
        rounds: roundsFrom(raw.rounds),
        ...(Array.isArray(raw.combos) ? { combos: combosFrom(raw.combos) } : {}),
    };
}
export class FlowStore {
    path;
    config = { rounds: DEFAULT_ROUNDS };
    constructor(path) {
        this.path = path;
    }
    async open() {
        try {
            this.config = configFrom(JSON.parse(await readFile(this.path, 'utf8')));
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
        }
    }
    async save(next) {
        await mkdir(dirname(this.path), { recursive: true });
        const temporary = `${this.path}.${process.pid}.tmp`;
        await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
        await rename(temporary, this.path);
        this.config = next;
    }
}
