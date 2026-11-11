/** Scans, folder settings and image bytes of local workspaces, reached only through a conversation's working directory. */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { basename } from 'node:path';
import { detectEngine } from './detect.js';
import { DEFAULT_RETIRE_DIR, NOTE_LIMIT_HINT, RAW_LIMIT, REMOTE_ANCHOR, SELECTION_LIMIT, isImage, type AssetDetail, type ProjectStatus, type ScanResult, type ScannedAsset, type TabMode } from './domain.js';
import { Library, cleanRetireDir, cleanTag, type Failure } from './manage.js';

type FullScan = ScanResult<ScannedAsset>;
import { Scanner, type Rules } from './scan.js';

export class AssetError extends Error { constructor(message: string, readonly status = 400) { super(message); } }

const fsError = (error: unknown): never => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') throw new AssetError('File not found', 404);
  if (code === 'EACCES' || code === 'EPERM') throw new AssetError('Permission denied', 403);
  throw error;
};

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

export class AssetService {
  private readonly scanner = new Scanner();
  private readonly settings: Settings;
  private readonly results = new Map<string, FullScan>();
  private readonly running = new Map<string, Promise<FullScan>>();
  private readonly libraries = new Map<string, Library>();
  /** Engines found lately, so a tab switch does not read the workspace's manifests again. */
  private readonly engines = new Map<string, { at: number; engine: string | undefined }>();
  constructor(private readonly cwdOf: (sessionId: string) => Promise<string | undefined>, settingsFile: string) { this.settings = new Settings(settingsFile); }

  /** The conversation's workspace folder, with symbolic links resolved. */
  async root(sessionId: string): Promise<string> {
    const cwd = await this.cwdOf(sessionId);
    if (!cwd) throw new AssetError('This conversation has no workspace folder', 409);
    if (REMOTE_ANCHOR.test(cwd)) throw new AssetError('Assets of a remote workspace are not supported yet', 409);
    return realpath(cwd).catch(() => { throw new AssetError('The workspace folder is not available', 404); });
  }

  /**
   * Whether a conversation's workspace gets the Assets tab: the user's choice for it, or else whether it declares a
   * game engine. A conversation without a local workspace is not a game project.
   */
  async project(sessionId: string): Promise<ProjectStatus> {
    const mode = await this.settings.mode();
    const root = await this.root(sessionId).catch(error => { if (error instanceof AssetError) return undefined; throw error; });
    if (!root) return { root: null, engine: null, override: null, game: false, mode };
    let found = this.engines.get(root);
    if (!found || Date.now() - found.at > 30_000) this.engines.set(root, found = { at: Date.now(), engine: await detectEngine(root) });
    const override = await this.settings.project(root);
    return { root: basename(root), engine: found.engine ?? null, override, game: override ?? found.engine !== undefined, mode };
  }
  /** Shows or hides the tab for this workspace whatever is detected; null goes back to the detection. */
  async setProject(sessionId: string, game: boolean | null): Promise<ProjectStatus> {
    await this.settings.setProject(await this.root(sessionId), game);
    return this.project(sessionId);
  }
  mode(): Promise<TabMode> { return this.settings.mode(); }
  async setMode(mode: TabMode): Promise<TabMode> { await this.settings.setMode(mode); return mode; }

  private run(root: string): Promise<FullScan> {
    let running = this.running.get(root);
    if (!running) {
      running = Promise.all([this.settings.get(root), this.settings.retireDir(root)]).then(([rules, retireDir]) => this.scanner.scan(root, rules, retireDir)).then(result => { this.results.set(root, result); return result; })
        .finally(() => { if (this.running.get(root) === running) this.running.delete(root); });
      this.running.set(root, running);
    }
    return running;
  }
  /** The last scan of the workspace, or a new one when there is none or `refresh` asks for it. */
  async scan(sessionId: string, refresh = false): Promise<FullScan> {
    const root = await this.root(sessionId);
    return (!refresh && this.results.get(root)) || this.run(root);
  }
  /** The references to one image of the last scan. */
  async detail(sessionId: string, path: string): Promise<AssetDetail> {
    const asset = (await this.scan(sessionId)).assets.find(entry => entry.path === path);
    if (!asset) throw new AssetError('File not found', 404);
    return { path, refs: asset.refs, refCount: asset.refCount };
  }
  /** Saves which top-level folders are read and, when given, where retired images go; then scans with them. */
  async configure(sessionId: string, rules: Rules, retireDir?: unknown): Promise<FullScan> {
    const root = await this.root(sessionId), folder = retireDir === undefined ? undefined : cleanRetireDir(retireDir);
    if (retireDir !== undefined && !folder) throw new AssetError('Invalid retired folder');
    await this.settings.set(root, rules, folder);
    return this.fresh(root);
  }
  /** A scan that started before a change must not be the answer to it. */
  private async fresh(root: string): Promise<FullScan> {
    await this.running.get(root)?.catch(() => {});
    return this.run(root);
  }
  private library(root: string): Library {
    let library = this.libraries.get(root);
    if (!library) this.libraries.set(root, library = new Library(root));
    return library;
  }
  /** The named images of the last scan that pass `allowed`; the rest are reported, never touched. */
  private async chosen(sessionId: string, paths: unknown, allowed: (asset: ScannedAsset) => boolean) {
    if (!Array.isArray(paths) || !paths.length || paths.length > SELECTION_LIMIT || paths.some(path => typeof path !== 'string')) throw new AssetError('Invalid selection');
    const root = await this.root(sessionId), byPath = new Map((await this.scan(sessionId)).assets.map(asset => [asset.path, asset]));
    const picked: ScannedAsset[] = [], failed: Failure[] = [];
    for (const path of new Set(paths as string[])) {
      const asset = byPath.get(path);
      if (asset && allowed(asset)) picked.push(asset); else failed.push({ path, error: asset ? 'This image cannot be moved that way' : 'Not an image of this workspace' });
    }
    return { root, picked, failed };
  }
  /** Moves images of the last scan into the retired folder; only what the scan listed can be named. */
  async retire(sessionId: string, paths: unknown): Promise<{ moved: number; failed: Failure[]; scan: FullScan }> {
    const { root, picked, failed } = await this.chosen(sessionId, paths, asset => !asset.retired);
    const result = await this.library(root).retire(await this.settings.retireDir(root), picked.map(asset => asset.path));
    return { moved: result.moved.length, failed: [...failed, ...result.failed], scan: await this.fresh(root) };
  }
  /** Moves retired images back where they came from. */
  async restore(sessionId: string, paths: unknown): Promise<{ moved: number; failed: Failure[]; scan: FullScan }> {
    const { root, picked, failed } = await this.chosen(sessionId, paths, asset => !!asset.retired);
    const result = await this.library(root).restore(await this.settings.retireDir(root), picked.map(asset => asset.path));
    return { moved: result.moved.length, failed: [...failed, ...result.failed], scan: await this.fresh(root) };
  }
  /** Adds and removes tags on images of the last scan, in the workspace's tag file. */
  async tag(sessionId: string, paths: unknown, add: unknown, remove: unknown): Promise<{ tags: Record<string, string[]> }> {
    const clean = (value: unknown) => {
      if (value === undefined) return [];
      if (!Array.isArray(value) || value.length > 50) throw new AssetError('Invalid tag');
      return value.map(entry => { const tag = cleanTag(entry); if (!tag) throw new AssetError('Invalid tag'); return tag; });
    };
    const adding = clean(add), removing = clean(remove), { root, picked } = await this.chosen(sessionId, paths, () => true);
    const tags = await this.library(root).tag(picked.map(asset => asset.path), adding, removing);
    for (const asset of picked) { if (tags[asset.path]?.length) asset.tags = tags[asset.path]; else delete asset.tags; }
    return { tags };
  }
  /** Sets or clears the note of one image of the last scan. */
  async note(sessionId: string, path: unknown, note: unknown): Promise<{ note: string }> {
    if (typeof note !== 'string' || note.length > NOTE_LIMIT_HINT) throw new AssetError('Invalid note');
    const { root, picked } = await this.chosen(sessionId, [path], () => true);
    if (!picked.length) throw new AssetError('File not found', 404);
    const saved = await this.library(root).note(picked[0].path, note);
    if (saved) picked[0].note = saved; else delete picked[0].note;
    return { note: saved };
  }

  /** An image's bytes. The path is relative to the workspace; symbolic links may not lead outside it. */
  async raw(sessionId: string, path: string): Promise<Buffer> {
    if (!path || path.length > 4096 || path.includes('\0') || isAbsolute(path)) throw new AssetError('Invalid file path');
    if (!isImage(path)) throw new AssetError('Not an image', 415);
    const root = await this.root(sessionId);
    const outside = (file: string) => { const inside = relative(root, file); return !inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside); };
    // Checked as written before the disk is touched, so the answer says nothing about files elsewhere; then again with links resolved.
    if (outside(resolve(root, path))) throw new AssetError('The file is outside this conversation’s workspace', 403);
    const file = await realpath(resolve(root, path)).catch(fsError);
    if (outside(file)) throw new AssetError('The file is outside this conversation’s workspace', 403);
    if (!isImage(file)) throw new AssetError('Not an image', 415);
    const info = await stat(file).catch(fsError);
    if (!info.isFile()) throw new AssetError('File not found', 404);
    if (info.size > RAW_LIMIT) throw new AssetError('The image is too large to preview', 413);
    return readFile(file).catch(fsError);
  }
}
