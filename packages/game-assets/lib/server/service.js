/** Scans, folder settings and image bytes of local workspaces, reached only through a conversation's working directory. */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { basename } from 'node:path';
import { detectEngine } from './detect.js';
import { DEFAULT_RETIRE_DIR, NOTE_LIMIT_HINT, RAW_LIMIT, REMOTE_ANCHOR, SELECTION_LIMIT, isImage } from './domain.js';
import { Library, cleanRetireDir, cleanTag } from './manage.js';
import { Scanner } from './scan.js';
export class AssetError extends Error {
    status;
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}
const fsError = (error) => {
    const code = error?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR')
        throw new AssetError('File not found', 404);
    if (code === 'EACCES' || code === 'EPERM')
        throw new AssetError('Permission denied', 403);
    throw error;
};
/** Folder names the client may switch: at most 500, each a plain name with two booleans. */
export function parseRules(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new AssetError('Invalid folder settings');
    const entries = Object.entries(value);
    if (entries.length > 500)
        throw new AssetError('Invalid folder settings');
    const rules = {};
    for (const [name, rule] of entries) {
        const { assets, code } = (rule ?? {});
        if (!name || name.length > 255 || /[/\\\0]/.test(name) || typeof assets !== 'boolean' || typeof code !== 'boolean')
            throw new AssetError('Invalid folder settings');
        rules[name] = { assets, code };
    }
    return rules;
}
/** What the user chose, in one JSON file of the DSH home: where the tab appears, and per workspace its folders and whether it is a game. */
class Settings {
    file;
    loaded;
    writing = Promise.resolve();
    constructor(file) {
        this.file = file;
    }
    load() {
        return this.loaded ??= readFile(this.file, 'utf8').then(text => {
            const raw = JSON.parse(text);
            const raw2 = raw;
            const saved = { mode: raw.mode === 'all' ? 'all' : 'games', workspaces: {}, projects: {}, retire: {} };
            for (const [root, dir] of Object.entries(raw2.retire && typeof raw2.retire === 'object' ? raw2.retire : {})) {
                const clean = cleanRetireDir(dir);
                if (clean)
                    saved.retire[root] = clean;
            }
            for (const [root, rules] of Object.entries(raw.workspaces && typeof raw.workspaces === 'object' ? raw.workspaces : {}))
                try {
                    saved.workspaces[root] = parseRules(rules);
                }
                catch { /* skip a damaged entry */ }
            for (const [root, game] of Object.entries(raw.projects && typeof raw.projects === 'object' ? raw.projects : {}))
                if (typeof game === 'boolean')
                    saved.projects[root] = game;
            return saved;
        }).catch(() => ({ mode: 'games', workspaces: {}, projects: {}, retire: {} }));
    }
    async save(change) {
        const saved = await this.load();
        change(saved);
        const write = this.writing.catch(() => { }).then(async () => {
            await mkdir(dirname(this.file), { recursive: true });
            const temporary = `${this.file}.${randomUUID()}.tmp`;
            try {
                await writeFile(temporary, `${JSON.stringify({ version: 1, ...saved }, null, 2)}\n`, { mode: 0o600 });
                await rename(temporary, this.file);
            }
            catch (error) {
                await rm(temporary, { force: true });
                throw error;
            }
        });
        this.writing = write;
        await write;
    }
    async get(root) { return (await this.load()).workspaces[root] ?? {}; }
    set(root, rules, retireDir) { return this.save(saved => { saved.workspaces[root] = rules; if (retireDir)
        saved.retire[root] = retireDir; }); }
    async retireDir(root) { return (await this.load()).retire[root] ?? DEFAULT_RETIRE_DIR; }
    async mode() { return (await this.load()).mode; }
    setMode(mode) { return this.save(saved => { saved.mode = mode; }); }
    async project(root) { return (await this.load()).projects[root] ?? null; }
    setProject(root, game) { return this.save(saved => { if (game === null)
        delete saved.projects[root];
    else
        saved.projects[root] = game; }); }
}
export class AssetService {
    cwdOf;
    scanner = new Scanner();
    settings;
    results = new Map();
    running = new Map();
    libraries = new Map();
    /** Engines found lately, so a tab switch does not read the workspace's manifests again. */
    engines = new Map();
    constructor(cwdOf, settingsFile) {
        this.cwdOf = cwdOf;
        this.settings = new Settings(settingsFile);
    }
    /** The conversation's workspace folder, with symbolic links resolved. */
    async root(sessionId) {
        const cwd = await this.cwdOf(sessionId);
        if (!cwd)
            throw new AssetError('This conversation has no workspace folder', 409);
        if (REMOTE_ANCHOR.test(cwd))
            throw new AssetError('Assets of a remote workspace are not supported yet', 409);
        return realpath(cwd).catch(() => { throw new AssetError('The workspace folder is not available', 404); });
    }
    /**
     * Whether a conversation's workspace gets the Assets tab: the user's choice for it, or else whether it declares a
     * game engine. A conversation without a local workspace is not a game project.
     */
    async project(sessionId) {
        const mode = await this.settings.mode();
        const root = await this.root(sessionId).catch(error => { if (error instanceof AssetError)
            return undefined; throw error; });
        if (!root)
            return { root: null, engine: null, override: null, game: false, mode };
        let found = this.engines.get(root);
        if (!found || Date.now() - found.at > 30_000)
            this.engines.set(root, found = { at: Date.now(), engine: await detectEngine(root) });
        const override = await this.settings.project(root);
        return { root: basename(root), engine: found.engine ?? null, override, game: override ?? found.engine !== undefined, mode };
    }
    /** Shows or hides the tab for this workspace whatever is detected; null goes back to the detection. */
    async setProject(sessionId, game) {
        await this.settings.setProject(await this.root(sessionId), game);
        return this.project(sessionId);
    }
    mode() { return this.settings.mode(); }
    async setMode(mode) { await this.settings.setMode(mode); return mode; }
    run(root) {
        let running = this.running.get(root);
        if (!running) {
            running = Promise.all([this.settings.get(root), this.settings.retireDir(root)]).then(([rules, retireDir]) => this.scanner.scan(root, rules, retireDir)).then(result => { this.results.set(root, result); return result; })
                .finally(() => { if (this.running.get(root) === running)
                this.running.delete(root); });
            this.running.set(root, running);
        }
        return running;
    }
    /** The last scan of the workspace, or a new one when there is none or `refresh` asks for it. */
    async scan(sessionId, refresh = false) {
        const root = await this.root(sessionId);
        return (!refresh && this.results.get(root)) || this.run(root);
    }
    /** The references to one image of the last scan. */
    async detail(sessionId, path) {
        const asset = (await this.scan(sessionId)).assets.find(entry => entry.path === path);
        if (!asset)
            throw new AssetError('File not found', 404);
        return { path, refs: asset.refs, refCount: asset.refCount };
    }
    /** Saves which top-level folders are read and, when given, where retired images go; then scans with them. */
    async configure(sessionId, rules, retireDir) {
        const root = await this.root(sessionId), folder = retireDir === undefined ? undefined : cleanRetireDir(retireDir);
        if (retireDir !== undefined && !folder)
            throw new AssetError('Invalid retired folder');
        await this.settings.set(root, rules, folder);
        return this.fresh(root);
    }
    /** A scan that started before a change must not be the answer to it. */
    async fresh(root) {
        await this.running.get(root)?.catch(() => { });
        return this.run(root);
    }
    library(root) {
        let library = this.libraries.get(root);
        if (!library)
            this.libraries.set(root, library = new Library(root));
        return library;
    }
    /** The named images of the last scan that pass `allowed`; the rest are reported, never touched. */
    async chosen(sessionId, paths, allowed) {
        if (!Array.isArray(paths) || !paths.length || paths.length > SELECTION_LIMIT || paths.some(path => typeof path !== 'string'))
            throw new AssetError('Invalid selection');
        const root = await this.root(sessionId), byPath = new Map((await this.scan(sessionId)).assets.map(asset => [asset.path, asset]));
        const picked = [], failed = [];
        for (const path of new Set(paths)) {
            const asset = byPath.get(path);
            if (asset && allowed(asset))
                picked.push(asset);
            else
                failed.push({ path, error: asset ? 'This image cannot be moved that way' : 'Not an image of this workspace' });
        }
        return { root, picked, failed };
    }
    /** Moves images of the last scan into the retired folder; only what the scan listed can be named. */
    async retire(sessionId, paths) {
        const { root, picked, failed } = await this.chosen(sessionId, paths, asset => !asset.retired);
        const result = await this.library(root).retire(await this.settings.retireDir(root), picked.map(asset => asset.path));
        return { moved: result.moved.length, failed: [...failed, ...result.failed], scan: await this.fresh(root) };
    }
    /** Moves retired images back where they came from. */
    async restore(sessionId, paths) {
        const { root, picked, failed } = await this.chosen(sessionId, paths, asset => !!asset.retired);
        const result = await this.library(root).restore(await this.settings.retireDir(root), picked.map(asset => asset.path));
        return { moved: result.moved.length, failed: [...failed, ...result.failed], scan: await this.fresh(root) };
    }
    /** Adds and removes tags on images of the last scan, in the workspace's tag file. */
    async tag(sessionId, paths, add, remove) {
        const clean = (value) => {
            if (value === undefined)
                return [];
            if (!Array.isArray(value) || value.length > 50)
                throw new AssetError('Invalid tag');
            return value.map(entry => { const tag = cleanTag(entry); if (!tag)
                throw new AssetError('Invalid tag'); return tag; });
        };
        const adding = clean(add), removing = clean(remove), { root, picked } = await this.chosen(sessionId, paths, () => true);
        const tags = await this.library(root).tag(picked.map(asset => asset.path), adding, removing);
        for (const asset of picked) {
            if (tags[asset.path]?.length)
                asset.tags = tags[asset.path];
            else
                delete asset.tags;
        }
        return { tags };
    }
    /** Sets or clears the note of one image of the last scan. */
    async note(sessionId, path, note) {
        if (typeof note !== 'string' || note.length > NOTE_LIMIT_HINT)
            throw new AssetError('Invalid note');
        const { root, picked } = await this.chosen(sessionId, [path], () => true);
        if (!picked.length)
            throw new AssetError('File not found', 404);
        const saved = await this.library(root).note(picked[0].path, note);
        if (saved)
            picked[0].note = saved;
        else
            delete picked[0].note;
        return { note: saved };
    }
    /** An image's bytes. The path is relative to the workspace; symbolic links may not lead outside it. */
    async raw(sessionId, path) {
        if (!path || path.length > 4096 || path.includes('\0') || isAbsolute(path))
            throw new AssetError('Invalid file path');
        if (!isImage(path))
            throw new AssetError('Not an image', 415);
        const root = await this.root(sessionId);
        const outside = (file) => { const inside = relative(root, file); return !inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside); };
        // Checked as written before the disk is touched, so the answer says nothing about files elsewhere; then again with links resolved.
        if (outside(resolve(root, path)))
            throw new AssetError('The file is outside this conversation’s workspace', 403);
        const file = await realpath(resolve(root, path)).catch(fsError);
        if (outside(file))
            throw new AssetError('The file is outside this conversation’s workspace', 403);
        if (!isImage(file))
            throw new AssetError('Not an image', 415);
        const info = await stat(file).catch(fsError);
        if (!info.isFile())
            throw new AssetError('File not found', 404);
        if (info.size > RAW_LIMIT)
            throw new AssetError('The image is too large to preview', 413);
        return readFile(file).catch(fsError);
    }
}
