/** Scans, settings and changes of workspaces, local or on a remote machine, reached only through a conversation's working directory. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { DEFAULT_RETIRE_DIR, IMAGE_BATCH, NOTE_LIMIT_HINT, PROMPT_LIMIT, RAW_LIMIT, REFERENCE_LIMIT, REMOTE_ANCHOR, SELECTION_LIMIT, extensionOf, isReference, usesApi } from './domain.js';
import { rasterType } from './images.js';
import { Library, cleanImagePath, cleanRetireDir, cleanTag } from './manage.js';
import { REMOTE_CHUNK, runRemote } from './remote.js';
import { Scanner } from './scan.js';
import { SourceStore, generateImage } from './sources.js';
import { AssetError, STAGING_DIR, handle, readImage } from './workspace.js';
export { AssetError };
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
/** Image requests that arrive together travel to a remote machine in one run. */
const READ_WAIT_MS = 20, READ_BATCH = 24;
const ASPECTS = ['square', 'wide', 'tall'];
/** The file type a saved picture's extension promises. */
const TYPE_OF = { png: 'png', webp: 'webp', jpg: 'jpeg', jpeg: 'jpeg' };
export class AssetService {
    cwdOf;
    options;
    scanner = new Scanner();
    settings;
    sourceStore;
    results = new Map();
    running = new Map();
    libraries = new Map();
    /** Engines found lately, so a tab switch does not read the workspace's manifests again. */
    engines = new Map();
    reads = new Map();
    /** Image sources and their keys sit beside the settings, in a file of their own that only its owner may read. */
    constructor(cwdOf, settingsFile, options = {}) {
        this.cwdOf = cwdOf;
        this.options = options;
        this.settings = new Settings(settingsFile);
        this.sourceStore = new SourceStore(join(dirname(settingsFile), 'image-sources.json'));
    }
    library(root) {
        let library = this.libraries.get(root);
        if (!library)
            this.libraries.set(root, library = new Library(root));
        return library;
    }
    /** The conversation's workspace: a folder on this computer, or one on the machine Remote Agents keeps it on. */
    async workspace(sessionId) {
        const cwd = await this.cwdOf(sessionId);
        if (!cwd)
            throw new AssetError('This conversation has no workspace folder', 409);
        if (!REMOTE_ANCHOR.test(cwd)) {
            const root = await realpath(cwd).catch(() => { throw new AssetError('The workspace folder is not available', 404); });
            const extras = { codexCommand: this.options.codex?.command };
            return { key: root, name: basename(root), root, call: (request, signal) => handle(root, request, this.scanner, this.library(root), { ...extras, signal }) };
        }
        const machines = this.options.machines?.(), script = this.options.remoteScript;
        if (!machines || typeof machines.target !== 'function' || typeof machines.withWorkspace !== 'function' || !script)
            throw new AssetError('Assets of a remote workspace need Remote Agents 0.2.130 or newer', 409);
        const target = await machines.target(sessionId).catch(error => { throw new AssetError(`The remote workspace is not available: ${error instanceof Error ? error.message : String(error)}`, 409); });
        const run = async (request, signal) => runRemote(machines, sessionId, target, await script(), request, undefined, signal);
        return {
            key: `remote:${target.hostId}:${target.cwd}`, name: target.cwd.replace(/\/+$/, '').split('/').pop() || target.cwd, host: target.label,
            call: (async (request, signal) => {
                // A long selection goes in several runs, so no command outgrows what a shell argument may hold.
                if (request.op === 'retire' || request.op === 'restore') {
                    const all = { moved: [], failed: [] };
                    for (let i = 0; i < request.paths.length; i += REMOTE_CHUNK) {
                        const part = await run({ ...request, paths: request.paths.slice(i, i + REMOTE_CHUNK) });
                        all.moved.push(...part.moved);
                        all.failed.push(...part.failed);
                    }
                    return all;
                }
                if (request.op === 'place' && request.data !== undefined) {
                    const data = Buffer.from(request.data, 'base64'), sha256 = createHash('sha256').update(data).digest('hex');
                    const staged = `${STAGING_DIR}/${sha256}.${extensionOf(request.path)}`;
                    return runRemote(machines, sessionId, target, await script(), { ...request, data: undefined, staged, sha256 }, { path: staged, data, sha256 });
                }
                // The bundle carries a key and a script: it travels by upload, never on a command line.
                if (request.op === 'setProjectSource' && request.bundle) {
                    const data = Buffer.from(JSON.stringify(request.bundle), 'utf8'), sha256 = createHash('sha256').update(data).digest('hex');
                    const staged = `${STAGING_DIR}/${sha256}.json`;
                    return runRemote(machines, sessionId, target, await script(), { op: 'setProjectSource', staged, sha256 }, { path: staged, data, sha256 });
                }
                if (request.op === 'codex')
                    return run(request, signal);
                if (request.op === 'tag') {
                    const all = {};
                    for (let i = 0; i < request.paths.length; i += REMOTE_CHUNK)
                        Object.assign(all, await run({ ...request, paths: request.paths.slice(i, i + REMOTE_CHUNK) }));
                    return all;
                }
                return run(request);
            }),
        };
    }
    /**
     * Whether a conversation's workspace gets the Assets tab: the user's choice for it, or else whether it declares a
     * game engine. A conversation without a workspace this plugin can reach is not a game project.
     */
    async project(sessionId) {
        const mode = await this.settings.mode();
        const workspace = await this.workspace(sessionId).catch(error => { if (error instanceof AssetError)
            return undefined; throw error; });
        if (!workspace)
            return { root: null, host: null, engine: null, override: null, game: false, mode };
        let found = this.engines.get(workspace.key);
        if (!found || Date.now() - found.at > 30_000) {
            // A machine that cannot be asked right now is not a reason to hide a tab the user chose to show.
            const engine = await workspace.call({ op: 'detect' }).then(answer => answer.engine, error => { if (workspace.root)
                throw error; return null; });
            this.engines.set(workspace.key, found = { at: Date.now(), engine });
        }
        const override = await this.settings.project(workspace.key);
        return { root: workspace.name, host: workspace.host ?? null, engine: found.engine, override, game: override ?? found.engine !== null, mode };
    }
    /** Shows or hides the tab for this workspace whatever is detected; null goes back to the detection. */
    async setProject(sessionId, game) {
        await this.settings.setProject((await this.workspace(sessionId)).key, game);
        return this.project(sessionId);
    }
    mode() { return this.settings.mode(); }
    async setMode(mode) { await this.settings.setMode(mode); return mode; }
    run(workspace) {
        let running = this.running.get(workspace.key);
        if (!running) {
            running = Promise.all([this.settings.get(workspace.key), this.settings.retireDir(workspace.key)])
                .then(([rules, retireDir]) => workspace.call({ op: 'scan', rules, retireDir }))
                .then(result => { const scan = { ...result, root: workspace.name }; this.results.set(workspace.key, scan); return scan; })
                .finally(() => { if (this.running.get(workspace.key) === running)
                this.running.delete(workspace.key); });
            this.running.set(workspace.key, running);
        }
        return running;
    }
    /** A scan that started before a change must not be the answer to it. */
    async fresh(workspace) {
        await this.running.get(workspace.key)?.catch(() => { });
        return this.run(workspace);
    }
    async last(workspace) { return this.results.get(workspace.key) ?? this.run(workspace); }
    /** The last scan of the workspace, or a new one when there is none or `refresh` asks for it. */
    async scan(sessionId, refresh = false) {
        const workspace = await this.workspace(sessionId);
        return refresh ? this.run(workspace) : this.last(workspace);
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
        const workspace = await this.workspace(sessionId), folder = retireDir === undefined ? undefined : cleanRetireDir(retireDir);
        if (retireDir !== undefined && !folder)
            throw new AssetError('Invalid retired folder');
        await this.settings.set(workspace.key, rules, folder);
        return this.fresh(workspace);
    }
    /** The named images of the last scan that pass `allowed`; the rest are reported, never touched. */
    async chosen(sessionId, paths, allowed) {
        if (!Array.isArray(paths) || !paths.length || paths.length > SELECTION_LIMIT || paths.some(path => typeof path !== 'string'))
            throw new AssetError('Invalid selection');
        const workspace = await this.workspace(sessionId), byPath = new Map((await this.last(workspace)).assets.map(asset => [asset.path, asset]));
        const picked = [], failed = [];
        for (const path of new Set(paths)) {
            const asset = byPath.get(path);
            if (asset && allowed(asset))
                picked.push(asset);
            else
                failed.push({ path, error: asset ? 'This image cannot be moved that way' : 'Not an image of this workspace' });
        }
        return { workspace, picked, failed };
    }
    async move(op, sessionId, paths) {
        const { workspace, picked, failed } = await this.chosen(sessionId, paths, asset => (op === 'restore') === !!asset.retired);
        const result = picked.length ? await workspace.call({ op, retireDir: await this.settings.retireDir(workspace.key), paths: picked.map(asset => asset.path) }) : { moved: [], failed: [] };
        return { moved: result.moved.length, failed: [...failed, ...result.failed], scan: await this.fresh(workspace) };
    }
    /** Moves images of the last scan into the retired folder; only what the scan listed can be named. */
    retire(sessionId, paths) { return this.move('retire', sessionId, paths); }
    /** Moves retired images back where they came from. */
    restore(sessionId, paths) { return this.move('restore', sessionId, paths); }
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
        const adding = clean(add), removing = clean(remove), { workspace, picked } = await this.chosen(sessionId, paths, () => true);
        const tags = picked.length ? await workspace.call({ op: 'tag', paths: picked.map(asset => asset.path), add: adding, remove: removing }) : {};
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
        const { workspace, picked } = await this.chosen(sessionId, [path], () => true);
        if (!picked.length)
            throw new AssetError('File not found', 404);
        const saved = (await workspace.call({ op: 'note', path: picked[0].path, note })).note;
        if (saved)
            picked[0].note = saved;
        else
            delete picked[0].note;
        return { note: saved };
    }
    /** Several images at once, as a grid asks for its thumbnails: one run on a remote machine instead of one per image. */
    async images(sessionId, paths) {
        if (!Array.isArray(paths) || !paths.length || paths.length > IMAGE_BATCH || paths.some(path => typeof path !== 'string'))
            throw new AssetError('Invalid selection');
        return (await this.workspace(sessionId)).call({ op: 'read', paths: [...new Set(paths)] });
    }
    /** An image's bytes. The path is relative to the workspace; symbolic links may not lead outside it. */
    async raw(sessionId, path) {
        const workspace = await this.workspace(sessionId);
        if (workspace.root)
            return readImage(workspace.root, path);
        // A grid asks for many thumbnails at once; those go to the machine together.
        return new Promise((resolve, reject) => {
            let batch = this.reads.get(workspace.key);
            if (!batch)
                this.reads.set(workspace.key, batch = { workspace, waiting: [] });
            batch.waiting.push({ path, resolve, reject });
            const flush = () => {
                const current = this.reads.get(workspace.key);
                if (!current)
                    return;
                this.reads.delete(workspace.key);
                clearTimeout(current.timer);
                current.workspace.call({ op: 'read', paths: [...new Set(current.waiting.map(entry => entry.path))] }).then(answers => {
                    const byPath = new Map(answers.map((answer) => [answer.path, answer]));
                    for (const entry of current.waiting) {
                        const answer = byPath.get(entry.path);
                        if (answer?.data !== undefined)
                            entry.resolve(Buffer.from(answer.data, 'base64'));
                        else
                            entry.reject(new AssetError(answer?.error ?? 'File not found', answer?.status ?? 404));
                    }
                }, error => { for (const entry of current.waiting)
                    entry.reject(error); });
            };
            if (batch.waiting.length >= READ_BATCH)
                flush();
            else
                batch.timer ??= setTimeout(flush, READ_WAIT_MS);
        });
    }
    sources() { return this.sourceStore.list(); }
    saveSource(source) { return this.sourceStore.put(source); }
    deleteSource(id) { return this.sourceStore.remove(id); }
    setDefaultSource(id) { return this.sourceStore.setDefault(id); }
    /**
     * Asks an image source for one picture, with images of the last scan as references. Nothing is written: the picture
     * comes back for the user to look at, and `save` puts it in the workspace.
     */
    async generate(sessionId, input, signal) {
        const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
        if (!prompt || prompt.length > PROMPT_LIMIT)
            throw new AssetError('Describe the picture in up to 8000 characters');
        if (!ASPECTS.includes(input.aspect) || typeof input.transparent !== 'boolean')
            throw new AssetError('Invalid picture settings');
        const paths = input.references ?? [];
        if (!Array.isArray(paths) || paths.length > REFERENCE_LIMIT || paths.some(path => typeof path !== 'string'))
            throw new AssetError('Up to 4 images can be sent as references');
        const source = await this.sourceStore.get(input.sourceId);
        const listed = new Set((await this.scan(sessionId)).assets.map(asset => asset.path));
        for (const path of paths) {
            if (!listed.has(path))
                throw new AssetError('Not an image of this workspace', 404);
            if (!isReference(path))
                throw new AssetError('Only PNG, WebP and JPEG images can be sent to an image API');
        }
        if (!usesApi(source.kind)) {
            // Codex runs on the workspace's machine, with that machine's login, and reads the references there.
            const workspace = await this.workspace(sessionId), started = Date.now();
            const picture = await workspace.call({ op: 'codex', prompt, references: [...new Set(paths)], aspect: input.aspect, transparent: input.transparent,
                ...(source.model ? { model: source.model } : {}), ...(workspace.root ? { loginShell: this.options.codex?.loginShell ?? true } : {}) }, signal);
            return { ...picture, model: source.model || 'Codex', source: source.name, ms: Date.now() - started };
        }
        const references = await Promise.all([...new Set(paths)].map(async (path) => {
            const data = await this.raw(sessionId, path), type = rasterType(data);
            if (type !== 'png' && type !== 'jpeg' && type !== 'webp')
                throw new AssetError(`${path} is not the image its name says`);
            return { name: basename(path), data, mediaType: `image/${type}` };
        }));
        const started = Date.now();
        const picture = await generateImage(source, { prompt, references, aspect: input.aspect, transparent: input.transparent }, { fetch: this.options.fetch, signal });
        return { data: picture.data.toString('base64'), mediaType: picture.mediaType, ...(picture.width ? { width: picture.width, height: picture.height } : {}),
            model: source.model, source: source.name, ms: Date.now() - started, ...(picture.text ? { text: picture.text } : {}) };
    }
    /**
     * Writes a picture to the workspace. A new path must be free and outside the retired folder; `replace` takes the place
     * of an image of the last scan, which is retired first and can be restored.
     */
    async save(sessionId, path, data, replace) {
        const clean = cleanImagePath(path);
        if (!clean || clean !== path)
            throw new AssetError('Save pictures as .png, .webp or .jpg files in a visible folder of the workspace');
        if (typeof data !== 'string' || !data || data.length > Math.ceil(RAW_LIMIT / 3) * 4)
            throw new AssetError('The picture is missing or too large');
        const bytes = Buffer.from(data, 'base64');
        if (rasterType(bytes) !== TYPE_OF[extensionOf(clean)])
            throw new AssetError(`The picture is not a ${extensionOf(clean).toUpperCase()} file`);
        const workspace = await this.workspace(sessionId), retireDir = await this.settings.retireDir(workspace.key);
        if (clean === retireDir || clean.startsWith(`${retireDir}/`))
            throw new AssetError('Pictures cannot be saved in the retired folder');
        const listed = (await this.last(workspace)).assets.find(asset => asset.path === clean);
        if (replace === true ? !listed || listed.retired : listed)
            throw new AssetError(replace === true ? 'Only an image of the last scan can be replaced' : 'A file of that name is already there', 409);
        const placed = await workspace.call({ op: 'place', path: clean, replace: replace === true, retireDir, data });
        return { ...placed, scan: await this.fresh(workspace) };
    }
    /** The image source the workspace records for its agents. */
    async projectSource(sessionId) {
        return (await this.workspace(sessionId)).call({ op: 'projectSource' });
    }
    /**
     * Records a source for the agents working in the workspace, or with null removes it. The project gets the source
     * without its key and the generate-image script; the key goes to the workspace machine's home folder.
     */
    async setProjectSource(sessionId, sourceId) {
        const workspace = await this.workspace(sessionId);
        if (sourceId === null)
            return workspace.call({ op: 'setProjectSource', bundle: null });
        if (typeof sourceId !== 'string' || !sourceId)
            throw new AssetError('Invalid image source');
        const source = await this.sourceStore.get(sourceId), script = await this.options.projectScript?.();
        if (!script)
            throw new AssetError('The generate-image script is missing from this build of the plugin', 500);
        const bundle = { source: { id: source.id, name: source.name, kind: source.kind, model: source.model, baseUrl: source.baseUrl }, script,
            ...(usesApi(source.kind) ? { key: source.apiKey } : {}) };
        return workspace.call({ op: 'setProjectSource', bundle });
    }
}
