import { createHash, randomUUID } from 'node:crypto';
import { chmod, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
/** Text the editor loads and saves; larger files can still be previewed by DSH. */
export const TEXT_LIMIT = 4 * 1024 * 1024;
/** Raw bytes served for previews. */
export const RAW_LIMIT = 50 * 1024 * 1024;
/** Workspaces whose files live on another machine: a local anchor folder under `remote-workspaces`. */
export const REMOTE_ANCHOR = /(?:^|[/\\])remote-workspaces(?:[/\\]|$)/;
export class FileError extends Error {
    status;
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}
const digest = (data) => createHash('sha256').update(data).digest('hex');
/** UTF-8 without NUL bytes. A BOM stays in the text, so saving keeps it. */
function textOf(data) {
    if (data.includes(0))
        return undefined;
    try {
        return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
    }
    catch {
        return undefined;
    }
}
const fsError = (error) => {
    const code = error?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR')
        throw new FileError('File not found', 404);
    if (code === 'EACCES' || code === 'EPERM')
        throw new FileError('Permission denied', 403);
    if (code === 'EISDIR')
        throw new FileError('Not a file');
    throw error;
};
/** Files of local workspaces, reached only through a conversation's working directory. */
export class LocalFiles {
    cwdOf;
    saving = new Map();
    constructor(cwdOf) {
        this.cwdOf = cwdOf;
    }
    /** A path relative to the workspace, or absolute inside it; symbolic links may not lead outside. */
    async resolve(sessionId, path) {
        if (!path || path.length > 4096 || path.includes('\0'))
            throw new FileError('Invalid file path');
        const cwd = await this.cwdOf(sessionId);
        if (!cwd)
            throw new FileError('This conversation has no workspace folder', 409);
        if (REMOTE_ANCHOR.test(cwd))
            throw new FileError('Files of a remote workspace open in Remote Agents', 409);
        const root = await realpath(cwd).catch(() => { throw new FileError('The workspace folder is not available', 404); });
        const file = await realpath(resolve(cwd, path)).catch(fsError);
        const inside = relative(root, file);
        if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside))
            throw new FileError('The file is outside this conversation’s workspace', 403);
        return { file, display: inside.split(sep).join('/') };
    }
    async regular(file) {
        const info = await stat(file).catch(fsError);
        if (!info.isFile())
            throw new FileError('Not a file');
        return info;
    }
    async stat(sessionId, path) {
        const { file, display } = await this.resolve(sessionId, path), info = await this.regular(file);
        return { path: display, size: info.size, mtimeMs: info.mtimeMs };
    }
    async read(sessionId, path) {
        const { file, display } = await this.resolve(sessionId, path), info = await this.regular(file);
        const state = { path: display, size: info.size, mtimeMs: info.mtimeMs };
        if (info.size > TEXT_LIMIT)
            return { ...state, kind: 'large' };
        const data = await readFile(file).catch(fsError), content = textOf(data);
        return content === undefined ? { ...state, size: data.length, kind: 'binary', revision: digest(data) } : { ...state, size: data.length, kind: 'text', content, revision: digest(data) };
    }
    async raw(sessionId, path) {
        const { file } = await this.resolve(sessionId, path), info = await this.regular(file);
        if (info.size > RAW_LIMIT)
            throw new FileError('The file is too large to preview', 413);
        return readFile(file).catch(fsError);
    }
    /** Replace a file read at `revision`, atomically and keeping its permissions; a file changed since is refused. */
    async write(sessionId, path, content, revision) {
        if (!/^[a-f0-9]{64}$/.test(revision))
            throw new FileError('A file revision is required');
        const data = Buffer.from(content, 'utf8');
        if (data.length > TEXT_LIMIT)
            throw new FileError('The file exceeds the 4 MB editor limit', 413);
        const { file, display } = await this.resolve(sessionId, path);
        // Saves of one file run one at a time, so two holding the same revision cannot both pass the check.
        const previous = this.saving.get(file) ?? Promise.resolve();
        const next = previous.catch(() => { }).then(async () => {
            const info = await this.regular(file);
            if (digest(await readFile(file).catch(fsError)) !== revision)
                throw new FileError('The file changed on disk. Reload it before saving.', 409);
            const temporary = join(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`);
            try {
                await writeFile(temporary, data, { flag: 'wx', mode: info.mode & 0o777 });
                await chmod(temporary, info.mode & 0o7777);
                await rename(temporary, file);
            }
            catch (error) {
                await rm(temporary, { force: true });
                fsError(error);
            }
            const saved = await stat(file);
            return { path: display, size: saved.size, mtimeMs: saved.mtimeMs, revision: digest(data) };
        });
        this.saving.set(file, next);
        try {
            return await next;
        }
        finally {
            if (this.saving.get(file) === next)
                this.saving.delete(file);
        }
    }
}
