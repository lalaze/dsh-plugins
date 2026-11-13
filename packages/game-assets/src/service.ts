/** Scans, settings and changes of workspaces, local or on a remote machine, reached only through a conversation's working directory. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { DEFAULT_RETIRE_DIR, IMAGE_BATCH, NOTE_LIMIT_HINT, PROMPT_LIMIT, RAW_LIMIT, REFERENCE_LIMIT, REMOTE_ANCHOR, SELECTION_LIMIT, extensionOf, isReference, usesApi, type Aspect, type AssetDetail, type GeneratedImage, type ProjectSourceStatus, type ProjectStatus, type ScanResult, type ScannedAsset, type SourcesAnswer, type TabMode } from './domain.js';
import { rasterType } from './images.js';
import { Library, cleanImagePath, cleanRetireDir, cleanTag, type Failure, type Moved, type Placed } from './manage.js';
import { REMOTE_CHUNK, runRemote, type RemoteMachines } from './remote.js';
import { Scanner, type Rules } from './scan.js';
import { SourceStore, generateImage } from './sources.js';
import type { ProjectBundle } from './project.js';
import { AssetError, STAGING_DIR, handle, readImage, type ReadAnswer, type WorkspaceAnswers, type WorkspaceRequest } from './workspace.js';

type FullScan = ScanResult<ScannedAsset>;

export { AssetError };

/** Folder names the client may switch: at most 500, each a plain name with two booleans. */
export function parseRules(value: unknown): Rules {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AssetError('Invalid folder settings');
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 500) throw new AssetError('Invalid folder settings');
  const rules: Rules = {};
  for (const [name, rule] of entries) {
    const { assets, code } = (rule ?? {}) as { assets?: unknown; code?: unknown };
    if (!name || name.length > 255 || /[/\\\0]/.test(name) || typeof assets !== 'boolean' || typeof code !== 'boolean') throw new AssetError('Invalid folder settings');
    rules[name] = { assets, code };
  }
  return rules;
}

interface Saved { mode: TabMode; workspaces: Record<string, Rules>; projects: Record<string, boolean>; retire: Record<string, string> }
/** What the user chose, in one JSON file of the DSH home: where the tab appears, and per workspace its folders and whether it is a game. */
class Settings {
  private loaded: Promise<Saved> | undefined;
  private writing: Promise<unknown> = Promise.resolve();
  constructor(private readonly file: string) {}
  private load() {
    return this.loaded ??= readFile(this.file, 'utf8').then(text => {
      const raw = JSON.parse(text) as { mode?: unknown; workspaces?: unknown; projects?: unknown };
      const raw2 = raw as { retire?: unknown };
      const saved: Saved = { mode: raw.mode === 'all' ? 'all' : 'games', workspaces: {}, projects: {}, retire: {} };
      for (const [root, dir] of Object.entries(raw2.retire && typeof raw2.retire === 'object' ? raw2.retire : {})) { const clean = cleanRetireDir(dir); if (clean) saved.retire[root] = clean; }
      for (const [root, rules] of Object.entries(raw.workspaces && typeof raw.workspaces === 'object' ? raw.workspaces : {})) try { saved.workspaces[root] = parseRules(rules); } catch { /* skip a damaged entry */ }
      for (const [root, game] of Object.entries(raw.projects && typeof raw.projects === 'object' ? raw.projects : {})) if (typeof game === 'boolean') saved.projects[root] = game;
      return saved;
    }).catch((): Saved => ({ mode: 'games', workspaces: {}, projects: {}, retire: {} }));
  }
  private async save(change: (saved: Saved) => void): Promise<void> {
    const saved = await this.load();
    change(saved);
    const write = this.writing.catch(() => {}).then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify({ version: 1, ...saved }, null, 2)}\n`, { mode: 0o600 });
        await rename(temporary, this.file);
      } catch (error) { await rm(temporary, { force: true }); throw error; }
    });
    this.writing = write;
    await write;
  }
  async get(root: string): Promise<Rules> { return (await this.load()).workspaces[root] ?? {}; }
  set(root: string, rules: Rules, retireDir?: string): Promise<void> { return this.save(saved => { saved.workspaces[root] = rules; if (retireDir) saved.retire[root] = retireDir; }); }
  async retireDir(root: string): Promise<string> { return (await this.load()).retire[root] ?? DEFAULT_RETIRE_DIR; }
  async mode(): Promise<TabMode> { return (await this.load()).mode; }
  setMode(mode: TabMode): Promise<void> { return this.save(saved => { saved.mode = mode; }); }
  async project(root: string): Promise<boolean | null> { return (await this.load()).projects[root] ?? null; }
  setProject(root: string, game: boolean | null): Promise<void> { return this.save(saved => { if (game === null) delete saved.projects[root]; else saved.projects[root] = game; }); }
}

/** One workspace folder and how to reach it. `key` names it in the settings and in what the host remembers of it. */
interface Workspace {
  key: string;
  name: string;
  /** The machine's label in Remote Agents; absent for a folder on this computer. */
  host?: string;
  /** The folder itself, for a local workspace. */
  root?: string;
  /** `signal` ends a request the caller gave up on: a Codex run on the machine stops with it. */
  call<K extends WorkspaceRequest['op']>(request: Extract<WorkspaceRequest, { op: K }>, signal?: AbortSignal): Promise<WorkspaceAnswers[K]>;
}
type MoveAnswer = { moved: number; failed: Failure[]; scan: FullScan };
/** Image requests that arrive together travel to a remote machine in one run. */
const READ_WAIT_MS = 20, READ_BATCH = 24;

export interface ServiceOptions {
  /** Remote Agents' machines service when that plugin is installed; asked for at each use, as it may load later. */
  machines?: () => RemoteMachines | undefined;
  /** The bundled script that runs on a remote machine. */
  remoteScript?: () => Promise<string>;
  /** How image APIs are reached; tests answer for them. */
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  /** The bundled script recorded in projects for their agents. */
  projectScript?: () => Promise<string>;
  /** How Codex is started for a local workspace: through the login shell (the default), and which command; tests change both. */
  codex?: { loginShell?: boolean; command?: string };
}
const ASPECTS: readonly Aspect[] = ['square', 'wide', 'tall'];
/** The file type a saved picture's extension promises. */
const TYPE_OF: Record<string, string> = { png: 'png', webp: 'webp', jpg: 'jpeg', jpeg: 'jpeg' };

export class AssetService {
  private readonly scanner = new Scanner();
  private readonly settings: Settings;
  private readonly sourceStore: SourceStore;
  private readonly results = new Map<string, FullScan>();
  private readonly running = new Map<string, Promise<FullScan>>();
  private readonly libraries = new Map<string, Library>();
  /** Engines found lately, so a tab switch does not read the workspace's manifests again. */
  private readonly engines = new Map<string, { at: number; engine: string | null }>();
  private readonly reads = new Map<string, { workspace: Workspace; waiting: { path: string; resolve(data: Buffer): void; reject(error: unknown): void }[]; timer?: ReturnType<typeof setTimeout> }>();
  /** Image sources and their keys sit beside the settings, in a file of their own that only its owner may read. */
  constructor(private readonly cwdOf: (sessionId: string) => Promise<string | undefined>, settingsFile: string, private readonly options: ServiceOptions = {}) {
    this.settings = new Settings(settingsFile);
    this.sourceStore = new SourceStore(join(dirname(settingsFile), 'image-sources.json'));
  }

  private library(root: string): Library {
    let library = this.libraries.get(root);
    if (!library) this.libraries.set(root, library = new Library(root));
    return library;
  }
  /** The conversation's workspace: a folder on this computer, or one on the machine Remote Agents keeps it on. */
  private async workspace(sessionId: string): Promise<Workspace> {
    const cwd = await this.cwdOf(sessionId);
    if (!cwd) throw new AssetError('This conversation has no workspace folder', 409);
    if (!REMOTE_ANCHOR.test(cwd)) {
      const root = await realpath(cwd).catch(() => { throw new AssetError('The workspace folder is not available', 404); });
      const extras = { codexCommand: this.options.codex?.command };
      return { key: root, name: basename(root), root, call: (request, signal) => handle(root, request, this.scanner, this.library(root), { ...extras, signal }) as Promise<never> };
    }
    const machines = this.options.machines?.(), script = this.options.remoteScript;
    if (!machines || typeof machines.target !== 'function' || typeof machines.withWorkspace !== 'function' || !script) throw new AssetError('Assets of a remote workspace need Remote Agents 0.2.130 or newer', 409);
    const target = await machines.target(sessionId).catch(error => { throw new AssetError(`The remote workspace is not available: ${error instanceof Error ? error.message : String(error)}`, 409); });
    const run = async (request: WorkspaceRequest, signal?: AbortSignal) => runRemote(machines, sessionId, target, await script(), request, undefined, signal);
    return {
      key: `remote:${target.hostId}:${target.cwd}`, name: target.cwd.replace(/\/+$/, '').split('/').pop() || target.cwd, host: target.label,
      call: (async (request: WorkspaceRequest, signal?: AbortSignal) => {
        // A long selection goes in several runs, so no command outgrows what a shell argument may hold.
        if (request.op === 'retire' || request.op === 'restore') {
          const all: Moved = { moved: [], failed: [] };
          for (let i = 0; i < request.paths.length; i += REMOTE_CHUNK) { const part = await run({ ...request, paths: request.paths.slice(i, i + REMOTE_CHUNK) }) as Moved; all.moved.push(...part.moved); all.failed.push(...part.failed); }
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
        if (request.op === 'codex') return run(request, signal);
        if (request.op === 'tag') {
          const all: Record<string, string[]> = {};
          for (let i = 0; i < request.paths.length; i += REMOTE_CHUNK) Object.assign(all, await run({ ...request, paths: request.paths.slice(i, i + REMOTE_CHUNK) }));
          return all;
        }
        return run(request);
      }) as Workspace['call'],
    };
  }

  /**
   * Whether a conversation's workspace gets the Assets tab: the user's choice for it, or else whether it declares a
   * game engine. A conversation without a workspace this plugin can reach is not a game project.
   */
  async project(sessionId: string): Promise<ProjectStatus> {
    const mode = await this.settings.mode();
    const workspace = await this.workspace(sessionId).catch(error => { if (error instanceof AssetError) return undefined; throw error; });
    if (!workspace) return { root: null, host: null, engine: null, override: null, game: false, mode };
    let found = this.engines.get(workspace.key);
    if (!found || Date.now() - found.at > 30_000) {
      // A machine that cannot be asked right now is not a reason to hide a tab the user chose to show.
      const engine = await workspace.call({ op: 'detect' }).then(answer => answer.engine, error => { if (workspace.root) throw error; return null; });
      this.engines.set(workspace.key, found = { at: Date.now(), engine });
    }
    const override = await this.settings.project(workspace.key);
    return { root: workspace.name, host: workspace.host ?? null, engine: found.engine, override, game: override ?? found.engine !== null, mode };
  }
  /** Shows or hides the tab for this workspace whatever is detected; null goes back to the detection. */
  async setProject(sessionId: string, game: boolean | null): Promise<ProjectStatus> {
    await this.settings.setProject((await this.workspace(sessionId)).key, game);
    return this.project(sessionId);
  }
  mode(): Promise<TabMode> { return this.settings.mode(); }
  async setMode(mode: TabMode): Promise<TabMode> { await this.settings.setMode(mode); return mode; }

  private run(workspace: Workspace): Promise<FullScan> {
    let running = this.running.get(workspace.key);
    if (!running) {
      running = Promise.all([this.settings.get(workspace.key), this.settings.retireDir(workspace.key)])
        .then(([rules, retireDir]) => workspace.call({ op: 'scan', rules, retireDir }))
        .then(result => { const scan = { ...result, root: workspace.name }; this.results.set(workspace.key, scan); return scan; })
        .finally(() => { if (this.running.get(workspace.key) === running) this.running.delete(workspace.key); });
      this.running.set(workspace.key, running);
    }
    return running;
  }
  /** A scan that started before a change must not be the answer to it. */
  private async fresh(workspace: Workspace): Promise<FullScan> {
    await this.running.get(workspace.key)?.catch(() => {});
    return this.run(workspace);
  }
  private async last(workspace: Workspace): Promise<FullScan> { return this.results.get(workspace.key) ?? this.run(workspace); }
  /** The last scan of the workspace, or a new one when there is none or `refresh` asks for it. */
  async scan(sessionId: string, refresh = false): Promise<FullScan> {
    const workspace = await this.workspace(sessionId);
    return refresh ? this.run(workspace) : this.last(workspace);
  }
  /** The references to one image of the last scan. */
  async detail(sessionId: string, path: string): Promise<AssetDetail> {
    const asset = (await this.scan(sessionId)).assets.find(entry => entry.path === path);
    if (!asset) throw new AssetError('File not found', 404);
    return { path, refs: asset.refs, refCount: asset.refCount };
  }
  /** Saves which top-level folders are read and, when given, where retired images go; then scans with them. */
  async configure(sessionId: string, rules: Rules, retireDir?: unknown): Promise<FullScan> {
    const workspace = await this.workspace(sessionId), folder = retireDir === undefined ? undefined : cleanRetireDir(retireDir);
    if (retireDir !== undefined && !folder) throw new AssetError('Invalid retired folder');
    await this.settings.set(workspace.key, rules, folder);
    return this.fresh(workspace);
  }

  /** The named images of the last scan that pass `allowed`; the rest are reported, never touched. */
  private async chosen(sessionId: string, paths: unknown, allowed: (asset: ScannedAsset) => boolean) {
    if (!Array.isArray(paths) || !paths.length || paths.length > SELECTION_LIMIT || paths.some(path => typeof path !== 'string')) throw new AssetError('Invalid selection');
    const workspace = await this.workspace(sessionId), byPath = new Map((await this.last(workspace)).assets.map(asset => [asset.path, asset]));
    const picked: ScannedAsset[] = [], failed: Failure[] = [];
    for (const path of new Set(paths as string[])) {
      const asset = byPath.get(path);
      if (asset && allowed(asset)) picked.push(asset); else failed.push({ path, error: asset ? 'This image cannot be moved that way' : 'Not an image of this workspace' });
    }
    return { workspace, picked, failed };
  }
  private async move(op: 'retire' | 'restore', sessionId: string, paths: unknown): Promise<MoveAnswer> {
    const { workspace, picked, failed } = await this.chosen(sessionId, paths, asset => (op === 'restore') === !!asset.retired);
    const result: Moved = picked.length ? await workspace.call({ op, retireDir: await this.settings.retireDir(workspace.key), paths: picked.map(asset => asset.path) }) : { moved: [], failed: [] };
    return { moved: result.moved.length, failed: [...failed, ...result.failed], scan: await this.fresh(workspace) };
  }
  /** Moves images of the last scan into the retired folder; only what the scan listed can be named. */
  retire(sessionId: string, paths: unknown): Promise<MoveAnswer> { return this.move('retire', sessionId, paths); }
  /** Moves retired images back where they came from. */
  restore(sessionId: string, paths: unknown): Promise<MoveAnswer> { return this.move('restore', sessionId, paths); }
  /** Adds and removes tags on images of the last scan, in the workspace's tag file. */
  async tag(sessionId: string, paths: unknown, add: unknown, remove: unknown): Promise<{ tags: Record<string, string[]> }> {
    const clean = (value: unknown) => {
      if (value === undefined) return [];
      if (!Array.isArray(value) || value.length > 50) throw new AssetError('Invalid tag');
      return value.map(entry => { const tag = cleanTag(entry); if (!tag) throw new AssetError('Invalid tag'); return tag; });
    };
    const adding = clean(add), removing = clean(remove), { workspace, picked } = await this.chosen(sessionId, paths, () => true);
    const tags = picked.length ? await workspace.call({ op: 'tag', paths: picked.map(asset => asset.path), add: adding, remove: removing }) : {};
    for (const asset of picked) { if (tags[asset.path]?.length) asset.tags = tags[asset.path]; else delete asset.tags; }
    return { tags };
  }
  /** Sets or clears the note of one image of the last scan. */
  async note(sessionId: string, path: unknown, note: unknown): Promise<{ note: string }> {
    if (typeof note !== 'string' || note.length > NOTE_LIMIT_HINT) throw new AssetError('Invalid note');
    const { workspace, picked } = await this.chosen(sessionId, [path], () => true);
    if (!picked.length) throw new AssetError('File not found', 404);
    const saved = (await workspace.call({ op: 'note', path: picked[0].path, note })).note;
    if (saved) picked[0].note = saved; else delete picked[0].note;
    return { note: saved };
  }

  /** Several images at once, as a grid asks for its thumbnails: one run on a remote machine instead of one per image. */
  async images(sessionId: string, paths: unknown): Promise<ReadAnswer[]> {
    if (!Array.isArray(paths) || !paths.length || paths.length > IMAGE_BATCH || paths.some(path => typeof path !== 'string')) throw new AssetError('Invalid selection');
    return (await this.workspace(sessionId)).call({ op: 'read', paths: [...new Set(paths as string[])] });
  }
  /** An image's bytes. The path is relative to the workspace; symbolic links may not lead outside it. */
  async raw(sessionId: string, path: string): Promise<Buffer> {
    const workspace = await this.workspace(sessionId);
    if (workspace.root) return readImage(workspace.root, path);
    // A grid asks for many thumbnails at once; those go to the machine together.
    return new Promise<Buffer>((resolve, reject) => {
      let batch = this.reads.get(workspace.key);
      if (!batch) this.reads.set(workspace.key, batch = { workspace, waiting: [] });
      batch.waiting.push({ path, resolve, reject });
      const flush = () => {
        const current = this.reads.get(workspace.key);
        if (!current) return;
        this.reads.delete(workspace.key); clearTimeout(current.timer);
        current.workspace.call({ op: 'read', paths: [...new Set(current.waiting.map(entry => entry.path))] }).then(answers => {
          const byPath = new Map(answers.map((answer: ReadAnswer) => [answer.path, answer]));
          for (const entry of current.waiting) {
            const answer = byPath.get(entry.path);
            if (answer?.data !== undefined) entry.resolve(Buffer.from(answer.data, 'base64')); else entry.reject(new AssetError(answer?.error ?? 'File not found', answer?.status ?? 404));
          }
        }, error => { for (const entry of current.waiting) entry.reject(error); });
      };
      if (batch.waiting.length >= READ_BATCH) flush(); else batch.timer ??= setTimeout(flush, READ_WAIT_MS);
    });
  }

  sources(): Promise<SourcesAnswer> { return this.sourceStore.list(); }
  saveSource(source: unknown): Promise<SourcesAnswer & { id: string }> { return this.sourceStore.put(source); }
  deleteSource(id: unknown): Promise<SourcesAnswer> { return this.sourceStore.remove(id); }
  setDefaultSource(id: unknown): Promise<SourcesAnswer> { return this.sourceStore.setDefault(id); }

  /**
   * Asks an image source for one picture, with images of the last scan as references. Nothing is written: the picture
   * comes back for the user to look at, and `save` puts it in the workspace.
   */
  async generate(sessionId: string, input: { sourceId?: unknown; prompt?: unknown; references?: unknown; aspect?: unknown; transparent?: unknown }, signal?: AbortSignal): Promise<GeneratedImage> {
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
    if (!prompt || prompt.length > PROMPT_LIMIT) throw new AssetError('Describe the picture in up to 8000 characters');
    if (!ASPECTS.includes(input.aspect as Aspect) || typeof input.transparent !== 'boolean') throw new AssetError('Invalid picture settings');
    const paths = input.references ?? [];
    if (!Array.isArray(paths) || paths.length > REFERENCE_LIMIT || paths.some(path => typeof path !== 'string')) throw new AssetError('Up to 4 images can be sent as references');
    const source = await this.sourceStore.get(input.sourceId);
    const listed = new Set((await this.scan(sessionId)).assets.map(asset => asset.path));
    for (const path of paths as string[]) {
      if (!listed.has(path)) throw new AssetError('Not an image of this workspace', 404);
      if (!isReference(path)) throw new AssetError('Only PNG, WebP and JPEG images can be sent to an image API');
    }
    if (!usesApi(source.kind)) {
      // Codex runs on the workspace's machine, with that machine's login, and reads the references there.
      const workspace = await this.workspace(sessionId), started = Date.now();
      const picture = await workspace.call({ op: 'codex', prompt, references: [...new Set(paths as string[])], aspect: input.aspect as Aspect, transparent: input.transparent,
        ...(source.model ? { model: source.model } : {}), ...(workspace.root ? { loginShell: this.options.codex?.loginShell ?? true } : {}) }, signal);
      return { ...picture, model: source.model || 'Codex', source: source.name, ms: Date.now() - started };
    }
    const references = await Promise.all([...new Set(paths as string[])].map(async path => {
      const data = await this.raw(sessionId, path), type = rasterType(data);
      if (type !== 'png' && type !== 'jpeg' && type !== 'webp') throw new AssetError(`${path} is not the image its name says`);
      return { name: basename(path), data, mediaType: `image/${type}` };
    }));
    const started = Date.now();
    const picture = await generateImage(source, { prompt, references, aspect: input.aspect as Aspect, transparent: input.transparent }, { fetch: this.options.fetch, signal });
    return { data: picture.data.toString('base64'), mediaType: picture.mediaType, ...(picture.width ? { width: picture.width, height: picture.height } : {}),
      model: source.model, source: source.name, ms: Date.now() - started, ...(picture.text ? { text: picture.text } : {}) };
  }

  /**
   * Writes a picture to the workspace. A new path must be free and outside the retired folder; `replace` takes the place
   * of an image of the last scan, which is retired first and can be restored.
   */
  async save(sessionId: string, path: unknown, data: unknown, replace: unknown): Promise<Placed & { scan: FullScan }> {
    const clean = cleanImagePath(path);
    if (!clean || clean !== path) throw new AssetError('Save pictures as .png, .webp or .jpg files in a visible folder of the workspace');
    if (typeof data !== 'string' || !data || data.length > Math.ceil(RAW_LIMIT / 3) * 4) throw new AssetError('The picture is missing or too large');
    const bytes = Buffer.from(data, 'base64');
    if (rasterType(bytes) !== TYPE_OF[extensionOf(clean)]) throw new AssetError(`The picture is not a ${extensionOf(clean).toUpperCase()} file`);
    const workspace = await this.workspace(sessionId), retireDir = await this.settings.retireDir(workspace.key);
    if (clean === retireDir || clean.startsWith(`${retireDir}/`)) throw new AssetError('Pictures cannot be saved in the retired folder');
    const listed = (await this.last(workspace)).assets.find(asset => asset.path === clean);
    if (replace === true ? !listed || listed.retired : listed) throw new AssetError(replace === true ? 'Only an image of the last scan can be replaced' : 'A file of that name is already there', 409);
    const placed = await workspace.call({ op: 'place', path: clean, replace: replace === true, retireDir, data });
    return { ...placed, scan: await this.fresh(workspace) };
  }

  /** The image source the workspace records for its agents. */
  async projectSource(sessionId: string): Promise<ProjectSourceStatus> {
    return (await this.workspace(sessionId)).call({ op: 'projectSource' });
  }
  /**
   * Records a source for the agents working in the workspace, or with null removes it. The project gets the source
   * without its key and the generate-image script; the key goes to the workspace machine's home folder.
   */
  async setProjectSource(sessionId: string, sourceId: unknown): Promise<ProjectSourceStatus> {
    const workspace = await this.workspace(sessionId);
    if (sourceId === null) return workspace.call({ op: 'setProjectSource', bundle: null });
    if (typeof sourceId !== 'string' || !sourceId) throw new AssetError('Invalid image source');
    const source = await this.sourceStore.get(sourceId), script = await this.options.projectScript?.();
    if (!script) throw new AssetError('The generate-image script is missing from this build of the plugin', 500);
    const bundle: ProjectBundle = { source: { id: source.id, name: source.name, kind: source.kind, model: source.model, baseUrl: source.baseUrl }, script,
      ...(usesApi(source.kind) ? { key: source.apiKey } : {}) };
    return workspace.call({ op: 'setProjectSource', bundle });
  }
}
