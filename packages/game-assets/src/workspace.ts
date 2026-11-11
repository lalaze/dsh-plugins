/**
 * Everything the plugin does in one workspace folder, as requests with JSON answers. The host runs them in its own
 * process for a local workspace and, for a remote one, inside the script it sends to that machine (remote-agent.ts).
 */
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { detectEngine } from './detect.js';
import { RAW_LIMIT, isImage, type ScanResult, type ScannedAsset } from './domain.js';
import type { Library, Moved } from './manage.js';
import type { Rules, Scanner } from './scan.js';

export class AssetError extends Error { constructor(message: string, readonly status = 400) { super(message); } }

export type WorkspaceRequest =
  | { op: 'scan'; rules: Rules; retireDir: string }
  | { op: 'detect' }
  | { op: 'retire' | 'restore'; retireDir: string; paths: string[] }
  | { op: 'tag'; paths: string[]; add: string[]; remove: string[] }
  | { op: 'note'; path: string; note: string }
  | { op: 'read'; paths: string[] };
/** One image of a `read` request: its bytes in base64, or why it could not be read. */
export interface ReadAnswer { path: string; data?: string; error?: string; status?: number }
export interface WorkspaceAnswers {
  scan: ScanResult<ScannedAsset>; detect: { engine: string | null }; retire: Moved; restore: Moved;
  tag: Record<string, string[]>; note: { note: string }; read: ReadAnswer[];
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
export async function handle(root: string, request: WorkspaceRequest, scanner: Scanner, library: Library): Promise<unknown> {
  switch (request.op) {
    case 'scan': return scanner.scan(root, request.rules, request.retireDir);
    case 'detect': return { engine: await detectEngine(root) ?? null };
    case 'retire': return library.retire(request.retireDir, request.paths);
    case 'restore': return library.restore(request.retireDir, request.paths);
    case 'tag': return library.tag(request.paths, request.add, request.remove);
    case 'note': return { note: await library.note(request.path, request.note) };
    case 'read': {
      const answers: ReadAnswer[] = [];
      for (const path of request.paths) {
        try { answers.push({ path, data: (await readImage(root, path)).toString('base64') }); }
        catch (error) { answers.push({ path, error: error instanceof Error ? error.message : String(error), status: error instanceof AssetError ? error.status : 500 }); }
      }
      return answers;
    }
  }
}
