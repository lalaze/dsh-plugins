/** Bugs a person types in: the source that needs no tracker. Its pictures are kept as files until the bug is fixed or thrown away. */
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decodePictures, EXTENSIONS } from './pictures.js';
export const MANUAL = 'manual';
const MEDIA = Object.fromEntries(Object.entries(EXTENSIONS).map(([type, extension]) => [extension, type]));
export class ManualSource {
    directory;
    id = MANUAL;
    /** A page shows this in its own language. */
    name = 'Manual';
    next;
    constructor(directory) {
        this.directory = directory;
    }
    folder(id) {
        if (!/^\d+$/u.test(id))
            throw new Error('Not a bug that was typed in');
        return join(this.directory, id);
    }
    /** Numbers go up and are never used twice, also across restarts. */
    async number() {
        if (this.next === undefined) {
            let counter = 0;
            try {
                counter = Number(await readFile(join(this.directory, 'counter'), 'utf8')) || 0;
            }
            catch { /* The first bug. */ }
            this.next = counter + 1;
        }
        const number = this.next++;
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        await writeFile(join(this.directory, 'counter'), String(number), { mode: 0o600 });
        return number;
    }
    /** Checks what was typed and keeps the pictures; the item still has to be handed to the pool. */
    async create(input) {
        const title = typeof input.title === 'string' ? input.title.trim() : '', body = typeof input.body === 'string' ? input.body.trim() : '';
        if (!title)
            throw new Error('Give the bug a title');
        if (title.length > 300 || body.length > 100_000)
            throw new Error('The title or the description is too long');
        const pictures = decodePictures(input.images).map(picture => ({ data: picture.data, extension: EXTENSIONS[picture.mediaType] }));
        const labels = Array.isArray(input.labels) ? [...new Set(input.labels.map(label => String(label).trim().slice(0, 50)).filter(Boolean))].slice(0, 20) : [];
        const number = await this.number(), id = String(number);
        if (pictures.length) {
            await mkdir(this.folder(id), { recursive: true, mode: 0o700 });
            await Promise.all(pictures.map((picture, index) => writeFile(join(this.folder(id), `${index + 1}.${picture.extension}`), picture.data, { mode: 0o600 })));
        }
        // A picture has no place in typed text unless the person gave it one; say where they are.
        const attached = typeof input.attached === 'number' && Number.isSafeInteger(input.attached) ? Math.min(Math.max(input.attached, 0), 16) : 0;
        const marks = Array.from({ length: pictures.length + attached }, (_, index) => `[image ${index + 1}]`).filter(mark => !body.includes(mark));
        return { source: MANUAL, id, ref: `M${number}`, title, body: [body, marks.join(' ')].filter(Boolean).join('\n\n'), labels, ...(pictures.length ? { images: pictures.length } : {}) };
    }
    async image(item, index) {
        let names;
        try {
            names = await readdir(this.folder(item.id));
        }
        catch {
            return undefined;
        }
        const name = names.find(entry => entry.startsWith(`${index + 1}.`)), mediaType = name && MEDIA[name.split('.').pop() ?? ''];
        return name && mediaType ? { data: await readFile(join(this.folder(item.id), name)), mediaType, name } : undefined;
    }
    async discard(item) { await rm(this.folder(item.id), { recursive: true, force: true }); }
}
