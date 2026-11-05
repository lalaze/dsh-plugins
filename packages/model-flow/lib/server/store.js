/** The models chosen in settings. Nothing about a running flow is saved: it ends with DSH. */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DEFAULT_ROUNDS, MAX_ROUNDS } from './line.js';
function routeFrom(value) {
    if (!value || typeof value !== 'object')
        return undefined;
    const { provider, model, effort, label } = value;
    if (typeof provider !== 'string' || !provider || typeof model !== 'string' || !model)
        return undefined;
    return { provider, model, label: typeof label === 'string' && label ? label : model, ...(typeof effort === 'string' && effort ? { effort } : {}) };
}
export function configFrom(value) {
    const raw = value && typeof value === 'object' ? value : {};
    const rounds = Number(raw.rounds), plan = routeFrom(raw.plan), implement = routeFrom(raw.implement), review = routeFrom(raw.review);
    return {
        ...(plan ? { plan } : {}), ...(implement ? { implement } : {}), ...(review ? { review } : {}),
        rounds: Number.isSafeInteger(rounds) && rounds >= 1 && rounds <= MAX_ROUNDS ? rounds : DEFAULT_ROUNDS,
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
