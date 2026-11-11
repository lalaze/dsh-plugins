/** Reads a workspace folder: its images, the code that names them, byte-identical copies, and versioned packs. */
import { createHash } from 'node:crypto';
import { open, readFile, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { ASSET_LIMIT, DEFAULT_RETIRE_DIR, RAW_LIMIT, ROOT_FOLDER, defaultRule, extensionOf, isImage } from './domain.js';
import { HEADER_BYTES, imageSize } from './images.js';
import { DATA_EXTENSIONS, SOURCE_EXTENSIONS, findReferences } from './references.js';
import { readRetired, readTags } from './manage.js';
import { groupVersions } from './versions.js';
/** Code and data files larger than this are not read for references. */
export const TEXT_LIMIT = 4 * 1024 * 1024;
/** Directory entries one scan visits before it reports the workspace as truncated. */
const ENTRY_LIMIT = 400_000;
const CONCURRENCY = 32;
/** Runs `task` over `items`, a few at a time, keeping their order. */
async function mapLimit(items, limit, task) {
    const results = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await task(items[index]);
        }
    }));
    return results;
}
/** Every image, code file and data file under `root`. Hidden entries, `node_modules` and symbolic links are skipped. */
async function list(root) {
    const images = [], sources = [], data = [];
    let pending = [''], visited = 0, truncated = false;
    while (pending.length && !truncated) {
        const batch = pending;
        pending = [];
        await mapLimit(batch, CONCURRENCY, async (dir) => {
            const entries = await readdir(join(root, dir), { withFileTypes: true }).catch(() => []);
            for (const entry of entries) {
                if (entry.name.startsWith('.') || entry.name === 'node_modules')
                    continue;
                if (++visited > ENTRY_LIMIT) {
                    truncated = true;
                    return;
                }
                const path = dir ? `${dir}/${entry.name}` : entry.name;
                if (entry.isDirectory())
                    pending.push(path);
                else if (entry.isFile()) {
                    const extension = extensionOf(entry.name);
                    if (isImage(entry.name))
                        images.push(path);
                    else if (SOURCE_EXTENSIONS.has(extension))
                        sources.push(path);
                    else if (DATA_EXTENSIONS.has(extension))
                        data.push(path);
                }
            }
        });
    }
    return { images: images.sort(), sources: sources.sort(), data: data.sort(), truncated };
}
const topOf = (path) => path.includes('/') ? path.slice(0, path.indexOf('/')) : ROOT_FOLDER;
/** Formats whose size is not in the first few bytes. */
const DEEP_HEADER = new Set(['jpg', 'jpeg', 'svg']);
export class Scanner {
    /** Sizes and hashes of files unchanged since an earlier scan, by absolute path. */
    measured = new Map();
    snapshot() { return Object.fromEntries(this.measured); }
    /** Takes over entries saved earlier; an entry is used only while its file's size and time are unchanged. */
    restore(entries) {
        for (const [file, entry] of Object.entries(entries ?? {}))
            if (entry && typeof entry.size === 'number' && typeof entry.mtimeMs === 'number')
                this.measured.set(file, entry);
    }
    async measure(file) {
        const info = await stat(file).catch(() => undefined);
        if (!info?.isFile())
            return undefined;
        const known = this.measured.get(file);
        if (known && known.size === info.size && known.mtimeMs === info.mtimeMs)
            return known;
        const entry = { size: info.size, mtimeMs: info.mtimeMs };
        const handle = await open(file, 'r').catch(() => undefined);
        if (handle) {
            try {
                const buffer = Buffer.alloc(Math.min(info.size, DEEP_HEADER.has(extensionOf(file)) ? HEADER_BYTES : 64));
                const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
                Object.assign(entry, imageSize(buffer.subarray(0, bytesRead)));
            }
            catch { /* listed without a size */ }
            finally {
                await handle.close();
            }
        }
        this.measured.set(file, entry);
        return entry;
    }
    /** Marks byte-identical files with a shared number. Only files of equal size are read. */
    async markDuplicates(root, assets) {
        const bySize = new Map();
        for (const asset of assets) {
            if (!asset.size || asset.size > RAW_LIMIT)
                continue;
            const list = bySize.get(asset.size);
            if (list)
                list.push(asset);
            else
                bySize.set(asset.size, [asset]);
        }
        const candidates = [...bySize.values()].filter(group => group.length > 1).flat();
        const byHash = new Map();
        await mapLimit(candidates, 8, async (asset) => {
            const file = join(root, asset.path), entry = this.measured.get(file);
            const hash = entry?.hash ?? await readFile(file).then(bytes => createHash('sha1').update(bytes).digest('hex'), () => undefined);
            if (!hash)
                return;
            if (entry)
                entry.hash = hash;
            const list = byHash.get(hash);
            if (list)
                list.push(asset);
            else
                byHash.set(hash, [asset]);
        });
        let group = 0;
        for (const asset of assets) {
            const hash = this.measured.get(join(root, asset.path))?.hash, same = hash ? byHash.get(hash) : undefined;
            if (!same || same.length < 2)
                continue;
            if (same[0].dup === undefined) {
                group++;
                for (const member of same)
                    member.dup = group;
            }
        }
    }
    /**
     * `root` is an existing directory; `rules` name the top-level folders the user switched on or off. Images under
     * `retireDir` are listed as retired whatever the rules say, and nothing in that folder counts as code.
     */
    async scan(root, rules = {}, retireDir = DEFAULT_RETIRE_DIR) {
        const started = Date.now(), all = await list(root);
        const retired = (path) => path.startsWith(`${retireDir}/`);
        const listing = { ...all, images: all.images.filter(path => !retired(path)), sources: all.sources.filter(path => !retired(path)), data: all.data.filter(path => !retired(path)) };
        const shelved = all.images.filter(retired);
        const folders = new Map();
        const folder = (path) => {
            const name = topOf(path);
            let entry = folders.get(name);
            if (!entry)
                folders.set(name, entry = { name, images: 0, codeFiles: 0, assets: true, code: true });
            return entry;
        };
        for (const path of listing.images)
            folder(path).images++;
        for (const path of listing.sources)
            folder(path).codeFiles++;
        for (const path of listing.data)
            folder(path);
        for (const entry of folders.values())
            Object.assign(entry, rules[entry.name] ?? defaultRule(entry.name, entry.images, entry.codeFiles, listing.sources.length));
        const rule = (path) => folders.get(topOf(path));
        const wanted = listing.images.filter(path => rule(path).assets), truncated = listing.truncated || wanted.length + shelved.length > ASSET_LIMIT;
        const paths = wanted.slice(0, ASSET_LIMIT);
        const measured = await mapLimit(paths, CONCURRENCY, path => this.measure(join(root, path)));
        const read = async (path) => {
            const file = join(root, path), info = await stat(file).catch(() => undefined);
            if (!info?.isFile() || info.size > TEXT_LIMIT)
                return undefined;
            const bytes = await readFile(file).catch(() => undefined);
            return !bytes || bytes.includes(0) ? undefined : bytes.toString('utf8');
        };
        const references = await findReferences({
            assets: paths, read,
            sources: listing.sources.filter(path => rule(path).code),
            data: listing.data.filter(path => { const r = rule(path); return r.code || r.assets; }),
        });
        const assets = [];
        paths.forEach((path, index) => {
            const entry = measured[index];
            if (!entry)
                return;
            assets.push({ path, size: entry.size, mtimeMs: entry.mtimeMs, ...(entry.width ? { width: entry.width, height: entry.height } : {}),
                usage: references.usage[index], refs: references.refs[index], refCount: references.counts[index] });
        });
        await this.markDuplicates(root, assets);
        const families = groupVersions(assets);
        // Retired images are listed, not judged: their paths mirror the ones code names, so matching them would call them used.
        const origins = new Map((await readRetired(root, retireDir)).map(entry => [entry.to, entry.from]));
        const shelf = shelved.slice(0, Math.max(0, ASSET_LIMIT - assets.length));
        (await mapLimit(shelf, CONCURRENCY, path => this.measure(join(root, path)))).forEach((entry, index) => {
            if (!entry)
                return;
            const path = shelf[index], origin = origins.get(path);
            assets.push({ path, size: entry.size, mtimeMs: entry.mtimeMs, ...(entry.width ? { width: entry.width, height: entry.height } : {}), usage: 'unused', refs: [], refCount: 0,
                retired: true, ...(origin ? { origin } : {}) });
        });
        const labels = await readTags(root);
        for (const asset of assets) {
            if (labels.tags[asset.path])
                asset.tags = labels.tags[asset.path];
            if (labels.notes[asset.path])
                asset.note = labels.notes[asset.path];
        }
        // Forget files that are gone, so a long-lived host does not keep every path it ever saw.
        if (this.measured.size > assets.length * 2 + 1000) {
            const prefix = root.endsWith('/') ? root : `${root}/`, live = new Set(assets.map(asset => join(root, asset.path)));
            for (const file of this.measured.keys())
                if (file.startsWith(prefix) && !live.has(file))
                    this.measured.delete(file);
        }
        return {
            root: basename(root), scannedAt: Date.now(), durationMs: Date.now() - started, assets, families, truncated, codeFiles: references.filesRead, retireDir,
            folders: [...folders.values()].filter(entry => entry.images || entry.codeFiles).sort((a, b) => a.name === ROOT_FOLDER ? -1 : b.name === ROOT_FOLDER ? 1 : a.name.localeCompare(b.name)),
        };
    }
}
