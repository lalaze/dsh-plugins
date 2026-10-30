import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { TEXT_LIMIT, type WorkingFile } from './domain.js';
import { localFileOperation, type LocalFileOptions, type LocalFileRequest } from './local-files-worker.js';
import { GitError, remoteCall, type RemoteTarget, type RemoteWorkspaces } from './runner.js';

/** The working-tree files the diff view compares and saves; paths are relative to the workspace folder. */
export interface WorkspaceFiles {
  read(path: string, signal: AbortSignal): Promise<WorkingFile>;
  /** Replaces the file read at `revision`; a file changed since is refused. */
  write(path: string, content: string, revision: string, signal: AbortSignal): Promise<{ revision: string }>;
}
/** UTF-8 without NUL bytes. A BOM stays in the text, so saving keeps it. */
export function textOf(data: Uint8Array): string | undefined {
  if (data.includes(0)) return undefined;
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data); } catch { return undefined; }
}
export function workspacePath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0') || isAbsolute(value) || value.split(/[\\/]/).includes('..')) throw new GitError('Invalid file path');
  return value;
}
const fsError = (error: unknown): never => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') throw new GitError('File not found', 404);
  if (code === 'EACCES' || code === 'EPERM') throw new GitError('Permission denied', 403);
  if (code === 'EISDIR') throw new GitError('Not a file');
  throw error;
};

/**
 * Files of a local workspace. Operations use an isolated, directory-bound worker so swapped parent paths cannot
 * redirect data I/O. Revision and identity checks detect intervening changes; atomic rename is not cross-process CAS.
 */
export class LocalFiles implements WorkspaceFiles {
  private static readonly saving = new Map<string, Promise<unknown>>();
  constructor(private readonly root: string, private readonly options: LocalFileOptions = {}) {}
  private async request(path: string, missing = false): Promise<Omit<LocalFileRequest, 'action'> | undefined> {
    const rootInfo = await lstat(this.root, { bigint: true }).catch(fsError);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new GitError('The workspace folder is not available', 409);
    const requested = resolve(this.root, workspacePath(path));
    const file = await realpath(requested).catch(error => {
      if (missing && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      return fsError(error);
    });
    if (file === undefined) return;
    const inside = relative(this.root, file);
    if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new GitError('The file is outside this conversation’s workspace', 403);
    return { root: this.root, file, requested, rootIdentity: { dev: String(rootInfo.dev), ino: String(rootInfo.ino) }, limit: TEXT_LIMIT };
  }
  async read(path: string, signal?: AbortSignal): Promise<WorkingFile> {
    signal?.throwIfAborted();
    const request = await this.request(path, true);
    if (!request) return { kind: 'missing' };
    return localFileOperation<WorkingFile>({ ...request, action: 'read' }, this.options, signal);
  }
  async write(path: string, content: string, revision: string, signal?: AbortSignal): Promise<{ revision: string }> {
    signal?.throwIfAborted();
    if (Buffer.byteLength(content, 'utf8') > TEXT_LIMIT) throw new GitError('The file exceeds the 4 MB editor limit', 413);
    const request = (await this.request(path))!, key = request.file;
    // In-process saves through aliases of one canonical path cannot both consume the same revision.
    const previous = LocalFiles.saving.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => localFileOperation<{ revision: string }>({ ...request, action: 'write', content, revision }, this.options, signal));
    LocalFiles.saving.set(key, next);
    try { return await next; } finally { if (LocalFiles.saving.get(key) === next) LocalFiles.saving.delete(key); }
  }
}

/** Files of a remote workspace, through Remote Agents' revision-checked transfers. */
export class RemoteFiles implements WorkspaceFiles {
  constructor(private readonly service: RemoteWorkspaces, private readonly sessionId: string, private readonly target?: RemoteTarget) {}
  async read(path: string, signal: AbortSignal): Promise<WorkingFile> {
    const info = await remoteCall(() => this.service.stat(this.sessionId, workspacePath(path), signal, this.target)).catch(error => {
      if (error instanceof GitError && error.status === 404) return undefined;
      throw error;
    });
    if (!info) return { kind: 'missing' };
    if (info.size > TEXT_LIMIT) return { kind: 'large', size: info.size };
    const data = await remoteCall(() => this.service.download(this.sessionId, path, info.revision, signal, this.target)), content = textOf(data);
    return content === undefined ? { kind: 'binary', size: data.length } : { kind: 'text', content, revision: info.revision, size: data.length };
  }
  async write(path: string, content: string, revision: string, signal: AbortSignal): Promise<{ revision: string }> {
    const data = Buffer.from(content, 'utf8');
    if (data.length > TEXT_LIMIT) throw new GitError('The file exceeds the 4 MB editor limit', 413);
    const saved = await remoteCall(() => this.service.upload(this.sessionId, workspacePath(path), revision, data, signal, this.target)).catch(error => {
      if (error instanceof GitError && error.status === 409) throw new GitError('The file changed on disk. Reload it before saving.', 409);
      throw error;
    });
    return { revision: saved.revision };
  }
}
