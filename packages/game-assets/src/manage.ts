/**
 * The changes the plugin makes to a workspace, and the only ones: moving images into the retired folder and back,
 * keeping tags and notes in one JSON file, and writing generated pictures to free paths. Nothing is deleted or
 * overwritten: a picture that replaces an image takes its place only after that image has been retired.
 */
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, link, lstat, mkdir, readFile, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { RETIRED_LIST, TAGS_FILE, extensionOf, isImage, isReference } from './domain.js';

export interface RetiredEntry { from: string; to: string; at: string }
export interface Failure { path: string; error: string }
export interface Moved { moved: { from: string; to: string }[]; failed: Failure[] }
/** Where a picture was written, and where the image it replaced was retired to. */
export interface Placed { path: string; retired?: string }
export interface TagFile { tags: Record<string, string[]>; notes: Record<string, string> }

export const TAG_LIMIT = 40, TAGS_PER_IMAGE = 20, NOTE_LIMIT = 2000;
/** A tag as kept: trimmed, single-spaced, without commas or control characters; undefined when nothing usable is left. */
export function cleanTag(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const tag = value.replace(/[\u0000-\u001f\u007f,]/g, ' ').replace(/\s+/g, ' ').trim();
  return tag && tag.length <= TAG_LIMIT ? tag : undefined;
}
/**
 * A retired folder as the user may set it: a plain relative path of visible names, such as `_retired` or
 * `assets/art-retired`. Hidden folders are not scanned, so retired images there could not be listed or restored.
 */
export function cleanRetireDir(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 200) return undefined;
  const parts = value.replace(/\\/g, '/').split('/').map(part => part.trim()).filter(Boolean);
  return parts.length && parts.every(part => /^[^.\u0000-\u001f:*?"<>|][^\u0000-\u001f:*?"<>|]*$/.test(part) && part !== 'node_modules') ? parts.join('/') : undefined;
}

/**
 * A path a generated picture may be saved at: relative, of visible names, ending in a PNG, WebP or JPEG file name.
 * Hidden folders are not scanned, so a picture there would not be listed.
 */
export function cleanImagePath(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 1024) return undefined;
  const parts = value.replace(/\\/g, '/').split('/').map(part => part.trim()).filter(Boolean);
  const plain = parts.length && parts.every(part => /^[^.\u0000-\u001f:*?"<>|][^\u0000-\u001f:*?"<>|]*$/.test(part) && part !== 'node_modules');
  return plain && isReference(parts[parts.length - 1]) ? parts.join('/') : undefined;
}

/** Puts the finished file `from` at `to`, failing if something is already there. */
async function placeFile(from: string, to: string): Promise<void> {
  const taken = (error: unknown) => (error as NodeJS.ErrnoException).code === 'EEXIST' ? new Error('A file of that name is already there') : error;
  try { await link(from, to); }
  catch (error) {
    // Some file systems have no hard links; an exclusive copy still never overwrites.
    if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EMLINK', 'EXDEV'].includes(String((error as NodeJS.ErrnoException).code))) throw taken(error);
    await copyFile(from, to, constants.COPYFILE_EXCL).catch(failure => { throw taken(failure); });
  }
}

const inside = (root: string, file: string) => { const rel = relative(root, file); return !!rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
const exists = (file: string) => lstat(file).then(() => true, () => false);
async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`); await rename(temporary, file); }
  catch (error) { await rm(temporary, { force: true }); throw error; }
}
const sorted = <T>(record: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(record).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));

export async function readRetired(root: string, retireDir: string): Promise<RetiredEntry[]> {
  try {
    const entries = (JSON.parse(await readFile(join(root, retireDir, RETIRED_LIST), 'utf8')) as { entries?: unknown }).entries;
    return Array.isArray(entries) ? entries.filter((entry): entry is RetiredEntry => !!entry && typeof entry.from === 'string' && typeof entry.to === 'string') : [];
  } catch { return []; }
}
export async function readTags(root: string): Promise<TagFile> {
  const file: TagFile = { tags: {}, notes: {} };
  try {
    const raw = JSON.parse(await readFile(join(root, TAGS_FILE), 'utf8')) as { tags?: unknown; notes?: unknown };
    for (const [path, tags] of Object.entries(raw.tags && typeof raw.tags === 'object' ? raw.tags : {})) {
      const clean = Array.isArray(tags) ? [...new Set(tags.map(cleanTag).filter((tag): tag is string => !!tag))] : [];
      if (clean.length) file.tags[path] = clean;
    }
    for (const [path, note] of Object.entries(raw.notes && typeof raw.notes === 'object' ? raw.notes : {})) if (typeof note === 'string' && note.trim()) file.notes[path] = note.slice(0, NOTE_LIMIT);
  } catch { /* no file yet, or one a person broke: start from nothing rather than refuse to tag */ }
  return file;
}
const writeTags = (root: string, file: TagFile) => writeJson(join(root, TAGS_FILE), { version: 1, tags: sorted(file.tags), notes: sorted(file.notes) });

/** Changes to one workspace, one at a time, so two requests cannot both rewrite the retired list or the tag file. */
export class Library {
  private last: Promise<unknown> = Promise.resolve();
  /** `root` is the workspace folder with symbolic links resolved. */
  constructor(private readonly root: string) {}
  private queue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.last.catch(() => {}).then(task);
    this.last = next;
    return next;
  }

  /**
   * Moves one file. The source must be a regular image inside the workspace and the target free; folders on either
   * side may not be links leading out of the workspace.
   */
  private async move(from: string, to: string): Promise<void> {
    const source = join(this.root, from), target = join(this.root, to);
    if (!inside(this.root, source) || !inside(this.root, target) || !isImage(from)) throw new Error('Not an image of this workspace');
    const info = await lstat(source).catch(() => undefined);
    if (!info?.isFile()) throw new Error('File not found');
    if (!inside(this.root, join(await realpath(dirname(source)), 'x'))) throw new Error('The file is outside this conversation’s workspace');
    if (await exists(target)) throw new Error('A file of that name is already there');
    await mkdir(dirname(target), { recursive: true });
    if (!inside(this.root, join(await realpath(dirname(target)), 'x'))) throw new Error('The file is outside this conversation’s workspace');
    await rename(source, target);
  }
  private async moveTags(pairs: { from: string; to: string }[]): Promise<void> {
    const file = await readTags(this.root);
    let changed = false;
    for (const { from, to } of pairs) {
      if (file.tags[from]) { file.tags[to] = file.tags[from]; delete file.tags[from]; changed = true; }
      if (file.notes[from]) { file.notes[to] = file.notes[from]; delete file.notes[from]; changed = true; }
    }
    if (changed) await writeTags(this.root, file);
  }
  private async moveAll(pairs: { from: string; to: string }[], record: (entries: RetiredEntry[], done: { from: string; to: string }[]) => RetiredEntry[], retireDir: string): Promise<Moved> {
    const result: Moved = { moved: [], failed: [] };
    for (const pair of pairs) {
      try { await this.move(pair.from, pair.to); result.moved.push(pair); }
      catch (error) { result.failed.push({ path: pair.from, error: error instanceof Error ? error.message : String(error) }); }
    }
    if (result.moved.length) {
      await this.writeRetired(retireDir, record(await readRetired(this.root, retireDir), result.moved));
      await this.moveTags(result.moved);
    }
    return result;
  }
  private writeRetired(retireDir: string, entries: RetiredEntry[]): Promise<void> {
    return writeJson(join(this.root, retireDir, RETIRED_LIST), { version: 1, entries: [...entries].sort((a, b) => a.to < b.to ? -1 : 1) });
  }
  /** Creates `dir`, refusing when an existing folder on the way is a link that leads out of the workspace. */
  private async folder(dir: string): Promise<void> {
    let existing = dir;
    while (!await exists(existing) && inside(this.root, existing)) existing = dirname(existing);
    const within = async (folder: string) => folder === this.root || inside(this.root, join(await realpath(folder), 'x'));
    if (!await within(existing)) throw new Error('The file is outside this conversation’s workspace');
    await mkdir(dir, { recursive: true });
    if (!await within(dir)) throw new Error('The file is outside this conversation’s workspace');
  }
  /** A free place for `path` in the retired folder: under its own path, or numbered beside an earlier retired copy. */
  private async freeRetired(retireDir: string, path: string): Promise<string> {
    const plain = `${retireDir}/${path}`;
    if (!await exists(join(this.root, plain))) return plain;
    const extension = extensionOf(path), stem = plain.slice(0, plain.length - extension.length - 1);
    for (let n = 2; n < 1000; n++) if (!await exists(join(this.root, `${stem}.${n}.${extension}`))) return `${stem}.${n}.${extension}`;
    throw new Error('The retired folder has too many copies of this image');
  }

  /** Removes the folders a move left empty, from each given file's folder up to, but not including, `top`. */
  private async prune(files: readonly string[], top: string): Promise<void> {
    for (const file of files) for (let dir = dirname(join(this.root, file)); inside(top, dir); dir = dirname(dir)) if (!await rmdir(dir).then(() => true, () => false)) break;
  }
  /** Moves images into the retired folder, each under its own path, and records where it came from. */
  retire(retireDir: string, paths: readonly string[]): Promise<Moved> {
    return this.queue(async () => {
      const at = new Date().toISOString();
      const result = await this.moveAll(paths.map(from => ({ from, to: `${retireDir}/${from}` })),
        (entries, done) => [...entries.filter(entry => !done.some(pair => pair.to === entry.to)), ...done.map(pair => ({ ...pair, at }))], retireDir);
      // A version retired whole should not leave its empty folder behind in the game's art.
      await this.prune(result.moved.map(pair => pair.from), this.root);
      return result;
    });
  }
  /** Moves retired images back where the list says they came from, and removes the folders this leaves empty. */
  restore(retireDir: string, paths: readonly string[]): Promise<Moved> {
    return this.queue(async () => {
      const origins = new Map((await readRetired(this.root, retireDir)).map(entry => [entry.to, entry.from]));
      const known = paths.filter(path => origins.has(path)), unknown = paths.filter(path => !origins.has(path));
      const result = await this.moveAll(known.map(path => ({ from: path, to: origins.get(path)! })), (entries, done) => entries.filter(entry => !done.some(pair => pair.from === entry.to)), retireDir);
      result.failed.push(...unknown.map(path => ({ path, error: 'Where this image came from was not recorded' })));
      await this.prune(result.moved.map(pair => pair.from), join(this.root, retireDir));
      return result;
    });
  }

  /** Adds and removes tags on each path; answers the tags those paths have afterwards. */
  tag(paths: readonly string[], add: readonly string[], remove: readonly string[]): Promise<Record<string, string[]>> {
    return this.queue(async () => {
      const file = await readTags(this.root), result: Record<string, string[]> = {};
      for (const path of paths) {
        const tags = [...new Set([...(file.tags[path] ?? []).filter(tag => !remove.includes(tag)), ...add])].slice(0, TAGS_PER_IMAGE);
        if (tags.length) file.tags[path] = tags; else delete file.tags[path];
        result[path] = tags;
      }
      await writeTags(this.root, file);
      return result;
    });
  }
  /** Sets an image's note; an empty note removes it. */
  note(path: string, note: string): Promise<string> {
    return this.queue(async () => {
      const file = await readTags(this.root), text = note.trim().slice(0, NOTE_LIMIT);
      if (text) file.notes[path] = text; else delete file.notes[path];
      await writeTags(this.root, file);
      return text;
    });
  }

  /**
   * Writes a new picture at `path`, which must be free. With `replace`, the image at `path` is retired first, to a free
   * name in the retired folder, and moved back if the picture cannot be written; its tags and note stay with the path,
   * as the new picture takes over its role in the game.
   */
  place(path: string, data: Buffer, replace: boolean, retireDir: string): Promise<Placed> {
    return this.queue(async () => {
      const target = join(this.root, path);
      if (!inside(this.root, target) || !isImage(path)) throw new Error('Not an image of this workspace');
      if (replace) {
        const info = await lstat(target).catch(() => undefined);
        if (!info?.isFile()) throw new Error('File not found');
      } else if (await exists(target)) throw new Error('A file of that name is already there');
      await this.folder(dirname(target));
      // Written beside its place first, under a hidden name, so the picture appears whole or not at all.
      const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
      await writeFile(temporary, data, { flag: 'wx' });
      let retired: string | undefined;
      try {
        if (replace) {
          const to = await this.freeRetired(retireDir, path);
          await this.move(path, to);
          retired = to;
        }
        try {
          if (retired) await this.writeRetired(retireDir, [...(await readRetired(this.root, retireDir)).filter(entry => entry.to !== retired), { from: path, to: retired, at: new Date().toISOString() }]);
          await placeFile(temporary, target);
        } catch (error) {
          if (retired) {
            const back = retired;
            await this.move(back, path).then(async () => this.writeRetired(retireDir, (await readRetired(this.root, retireDir)).filter(entry => entry.to !== back))).catch(() => {});
          }
          throw error;
        }
      } finally { await rm(temporary, { force: true }); }
      return { path, ...(retired ? { retired } : {}) };
    });
  }
}
