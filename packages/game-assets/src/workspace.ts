/**
 * Everything the plugin does in one workspace folder, as requests with JSON answers. The host runs them in its own
 * process for a local workspace and, for a remote one, inside the script it sends to that machine (remote-agent.ts).
 */
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, rm, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { runCodex } from './codex.js';
import { detectEngine } from './detect.js';
import { IMAGE_BATCH_BYTES, RAW_LIMIT, isImage, isReference, type Aspect, type ImageAnswer, type ProjectSourceStatus, type ScanResult, type ScannedAsset } from './domain.js';
import type { Library, Moved, Placed } from './manage.js';
import { readProjectSource, writeProjectSource, type ProjectBundle } from './project.js';
import type { Rules, Scanner } from './scan.js';

export class AssetError extends Error { constructor(message: string, readonly status = 400) { super(message); } }

export type WorkspaceRequest =
  | { op: 'scan'; rules: Rules; retireDir: string }
  | { op: 'detect' }
  | { op: 'retire' | 'restore'; retireDir: string; paths: string[] }
  | { op: 'tag'; paths: string[]; add: string[]; remove: string[] }
  | { op: 'note'; path: string; note: string }
  | { op: 'read'; paths: string[] }
  /**
   * Writes a picture to `path`, replacing the image there if `replace`. Its bytes come in `data` (base64) or, on a remote
   * machine, were uploaded beforehand to `staged`, relative to the workspace, with the digest `sha256`.
   */
  | { op: 'place'; path: string; replace: boolean; retireDir: string; data?: string; staged?: string; sha256?: string }
  /** Generates a picture with the Codex CLI signed in on this machine; `references` are workspace paths. */
  | { op: 'codex'; prompt: string; references: string[]; aspect: Aspect; transparent: boolean; model?: string; loginShell?: boolean }
  | { op: 'projectSource' }
  /** Records an image source for the project's agents, or removes it with `bundle: null`. A remote bundle comes `staged`. */
  | { op: 'setProjectSource'; bundle?: ProjectBundle | null; staged?: string; sha256?: string };
/** The picture of a `codex` request, its bytes in base64. */
export interface CodexAnswer { data: string; mediaType: string; width?: number; height?: number; text?: string }
export type ReadAnswer = ImageAnswer;
export interface WorkspaceAnswers {
  scan: ScanResult<ScannedAsset>; detect: { engine: string | null }; retire: Moved; restore: Moved;
  tag: Record<string, string[]>; note: { note: string }; read: ReadAnswer[]; place: Placed;
  codex: CodexAnswer; projectSource: ProjectSourceStatus; setProjectSource: ProjectSourceStatus;
}
/** What a request may be given besides itself, in the process that runs it. */
export interface HandleExtras { signal?: AbortSignal; codexCommand?: string }

/** Where Remote Agents' upload leaves a picture on a remote machine before the script puts it in place. */
export const STAGING_DIR = '.dsh-remote-agents/attachments/game-assets';
const STAGED = /^[a-f0-9]{64}\.(?:png|webp|jpe?g|json)$/;

/** The bytes of an uploaded picture, checked against its digest; the upload is removed either way. */
async function takeStaged(root: string, staged: string | undefined, sha256: string | undefined): Promise<Buffer> {
  const name = staged?.startsWith(`${STAGING_DIR}/`) ? staged.slice(STAGING_DIR.length + 1) : '';
  if (!STAGED.test(name) || !sha256 || !name.startsWith(sha256)) throw new AssetError('Invalid upload');
  const file = join(root, STAGING_DIR, name);
  try {
    const info = await lstat(file).catch(fsError);
    if (!info.isFile() || info.size > RAW_LIMIT) throw new AssetError('Invalid upload');
    const data = await readFile(file);
    if (createHash('sha256').update(data).digest('hex') !== sha256) throw new AssetError('The upload arrived damaged', 502);
    return data;
  } finally { await rm(file, { force: true }); }
}

const fsError = (error: unknown): never => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') throw new AssetError('File not found', 404);
  if (code === 'EACCES' || code === 'EPERM') throw new AssetError('Permission denied', 403);
  throw error;
};

/** An image's bytes. The path is relative to the workspace `root`; symbolic links may not lead outside it. */
export async function readImage(root: string, path: string): Promise<Buffer> {
  if (!path || path.length > 4096 || path.includes('\0') || isAbsolute(path)) throw new AssetError('Invalid file path');
  if (!isImage(path)) throw new AssetError('Not an image', 415);
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

/** Answers one request about the folder `root`, an existing directory with symbolic links resolved. */
export async function handle(root: string, request: WorkspaceRequest, scanner: Scanner, library: Library, extras: HandleExtras = {}): Promise<unknown> {
  switch (request.op) {
    case 'scan': return scanner.scan(root, request.rules, request.retireDir);
    case 'detect': return { engine: await detectEngine(root) ?? null };
    case 'retire': return library.retire(request.retireDir, request.paths);
    case 'restore': return library.restore(request.retireDir, request.paths);
    case 'tag': return library.tag(request.paths, request.add, request.remove);
    case 'note': return { note: await library.note(request.path, request.note) };
    case 'place': {
      const data = request.data !== undefined ? Buffer.from(request.data, 'base64') : await takeStaged(root, request.staged, request.sha256);
      try { return await library.place(request.path, data, request.replace, request.retireDir); }
      catch (error) { throw error instanceof AssetError ? error : new AssetError(error instanceof Error ? error.message : String(error), 409); }
    }
    case 'codex': {
      const references: string[] = [];
      for (const path of request.references) {
        if (!isReference(path)) throw new AssetError('Only PNG, WebP and JPEG images can be sent to an image API');
        await readImage(root, path);
        references.push(await realpath(resolve(root, path)));
      }
      const picture = await runCodex({ prompt: request.prompt, references, aspect: request.aspect, transparent: request.transparent, model: request.model },
        { loginShell: request.loginShell, signal: extras.signal, command: extras.codexCommand });
      return { data: picture.data.toString('base64'), mediaType: picture.mediaType, ...(picture.width ? { width: picture.width, height: picture.height } : {}), ...(picture.text ? { text: picture.text } : {}) };
    }
    case 'projectSource': return readProjectSource(root);
    case 'setProjectSource': {
      const bundle = request.staged ? JSON.parse((await takeStaged(root, request.staged, request.sha256)).toString('utf8')) as ProjectBundle : request.bundle ?? null;
      try { return await writeProjectSource(root, bundle); }
      catch (error) { throw error instanceof AssetError ? error : new AssetError(error instanceof Error ? error.message : String(error), 409); }
    }
    case 'read': {
      const answers: ReadAnswer[] = [];
      let bytes = 0;
      for (const path of request.paths) {
        // One answer stays a size a browser and an SSH channel take in stride; what is left is asked for again.
        if (bytes >= IMAGE_BATCH_BYTES) { answers.push({ path, error: 'Ask for this image in another request', status: 413 }); continue; }
        try { const data = await readImage(root, path); bytes += data.length; answers.push({ path, data: data.toString('base64') }); }
        catch (error) { answers.push({ path, error: error instanceof Error ? error.message : String(error), status: error instanceof AssetError ? error.status : 500 }); }
      }
      return answers;
    }
  }
}
