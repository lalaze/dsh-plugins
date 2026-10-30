import { spawn } from 'node:child_process';
import { GitError } from './runner.js';
/**
 * Node has no openat/renameat, and macOS does not support directory-fd paths through /dev/fd. A short-lived process
 * gives each operation its own cwd: walk one verified directory at a time, then use basenames only. A replaced parent
 * pathname cannot redirect an opened directory. No process-wide chdir is performed in the DSH host.
 */
const WORKER = String.raw `
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const changed = () => Object.assign(new Error('The file changed on disk. Reload it before saving.'), { status: 409 });
const denied = () => Object.assign(new Error('The file is outside this conversation’s workspace'), { status: 403 });
const fail = message => Object.assign(new Error(message), { status: 400 });
const identity = stat => ({ dev: String(stat.dev), ino: String(stat.ino) });
const same = (a, b) => String(a.dev) === String(b.dev) && String(a.ino) === String(b.ino);
const fingerprint = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode].map(String).join(':');
const digest = data => crypto.createHash('sha256').update(data).digest('hex');
const send = value => new Promise((resolve, reject) => process.send(value, error => error ? reject(error) : resolve()));
const lstat = name => fs.lstatSync(name, { bigint: true });
const stat = name => fs.statSync(name, { bigint: true });
let sequence = 0, checkpointing = false;
const checkpoint = stage => !checkpointing ? Promise.resolve() : new Promise((resolve, reject) => {
  const id = ++sequence;
  process.once('message', message => message && message.continue === id ? resolve() : reject(changed()));
  process.send({ checkpoint: stage, id });
});
const readBounded = (fd, limit) => {
  const buffer = Buffer.alloc(limit + 1);
  let used = 0;
  while (used < buffer.length) {
    const n = fs.readSync(fd, buffer, used, buffer.length - used, used);
    if (!n) break;
    used += n;
  }
  return buffer.subarray(0, used);
};
process.once('message', async request => {
  checkpointing = request.checkpoints === true;
  let fd, temporary, temporaryFd;
  const cleanup = () => {
    if (temporaryFd !== undefined) { try { fs.closeSync(temporaryFd); } catch {} temporaryFd = undefined; }
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} fd = undefined; }
    if (temporary) { try { fs.unlinkSync(temporary); } catch {} temporary = undefined; }
  };
  const stop = () => { cleanup(); process.exit(1); };
  process.once('SIGTERM', stop);
  try {
    const rootStat = stat('.');
    if (!rootStat.isDirectory() || !same(rootStat, request.rootIdentity)) throw changed();
    const relative = path.relative(request.root, request.file);
    if (!relative || path.isAbsolute(relative) || relative.split(path.sep).includes('..')) throw denied();
    const parts = relative.split(path.sep), name = parts.pop();
    // Each successful chdir pins a directory object. A symlink swap between lstat and chdir is caught by identity.
    for (const part of parts) {
      const before = lstat(part);
      if (before.isSymbolicLink()) throw changed();
      if (!before.isDirectory()) throw fail('Not a file');
      await checkpoint('directory-observed');
      process.chdir(part);
      if (!same(before, stat('.'))) throw changed();
    }
    const directory = stat('.');
    const verifyPath = () => {
      if (!same(rootStat, stat(request.root)) || !same(directory, stat(path.dirname(request.file)))) throw changed();
      if (fs.realpathSync(request.requested) !== request.file) throw changed();
    };
    verifyPath();
    await checkpoint('directory-bound');
    verifyPath();
    const before = lstat(name);
    if (!before.isFile() || before.isSymbolicLink()) throw fail('Not a file');
    // O_NONBLOCK prevents a substituted FIFO from hanging. No bytes are read until fstat matches the regular file.
    fd = fs.openSync(name, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || !same(before, opened)) throw changed();
    await checkpoint('file-opened');
    verifyPath();
    if (!same(opened, lstat(name)) || fingerprint(opened) !== fingerprint(fs.fstatSync(fd, { bigint: true }))) throw changed();
    if (opened.size > BigInt(request.limit)) {
      if (request.action !== 'read') throw changed();
      await send({ result: { kind: 'large', size: Number(opened.size) } }); return;
    }
    const bytes = readBounded(fd, request.limit);
    if (fingerprint(opened) !== fingerprint(fs.fstatSync(fd, { bigint: true })) || !same(opened, lstat(name))) throw changed();
    if (bytes.length > request.limit) throw changed();
    if (request.action === 'read') {
      verifyPath();
      let content;
      if (!bytes.includes(0)) try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch {}
      await send({ result: content === undefined ? { kind: 'binary', size: bytes.length } : { kind: 'text', content, revision: digest(bytes), size: bytes.length } });
      return;
    }
    if (digest(bytes) !== request.revision) throw changed();
    const data = Buffer.from(request.content, 'utf8');
    if (data.length > request.limit) throw Object.assign(new Error('The file exceeds the 4 MB editor limit'), { status: 413 });
    temporary = '.' + name + '.' + crypto.randomUUID() + '.tmp';
    temporaryFd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    fs.writeFileSync(temporaryFd, data);
    fs.fchmodSync(temporaryFd, Number(opened.mode & 0o7777n));
    fs.fsyncSync(temporaryFd);
    const tempIdentity = fs.fstatSync(temporaryFd, { bigint: true });
    await checkpoint('temporary-written');
    await checkpoint('before-commit');
    // Last check includes file identity, metadata and bytes, not merely the hash captured before writing the temp file.
    // This is deliberately synchronous through rename, but is not OS-level CAS against noncooperating external writers.
    verifyPath();
    if (!same(opened, lstat(name)) || fingerprint(opened) !== fingerprint(fs.fstatSync(fd, { bigint: true })) ||
        digest(readBounded(fd, request.limit)) !== request.revision || !same(tempIdentity, lstat(temporary)) ||
        fingerprint(tempIdentity) !== fingerprint(fs.fstatSync(temporaryFd, { bigint: true }))) throw changed();
    fs.closeSync(temporaryFd); temporaryFd = undefined;
    fs.renameSync(temporary, name); temporary = undefined;
    await send({ result: { revision: digest(data) } });
  } catch (error) {
    const status = error.status || (error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 409 : error.code === 'EACCES' || error.code === 'EPERM' ? 403 : 409);
    const message = error.status ? error.message : status === 403 ? 'Permission denied' : 'The file changed on disk. Reload it before saving.';
    await send({ error: { message, status } });
  } finally {
    // Relative cleanup remains in the pinned directory and never follows a replaced ancestor or symlink.
    cleanup(); process.removeListener('SIGTERM', stop);
    process.disconnect();
  }
});
`;
/** Runs the worker with a bounded lifetime and without shell interpolation or host-global working-directory changes. */
export function localFileOperation(request, options, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(signal.reason);
            return;
        }
        const child = spawn(process.execPath, ['-e', WORKER], {
            cwd: request.root, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        });
        let settled = false, response;
        let stopError, killTimer;
        const finish = (error, value) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timeout);
            if (killTimer)
                clearTimeout(killTimer);
            signal?.removeEventListener('abort', abort);
            if (error)
                reject(error);
            else
                resolve(value);
        };
        const stop = (error) => {
            if (settled || stopError)
                return;
            stopError = error;
            child.kill('SIGTERM');
            killTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
        };
        const abort = () => stop(signal?.reason ?? new GitError('The Git operation was cancelled', 409));
        const timeout = setTimeout(() => stop(new GitError('The workspace folder is not available', 503)), 30_000);
        signal?.addEventListener('abort', abort, { once: true });
        child.on('error', error => finish(error));
        child.on('message', async (message) => {
            if (message?.checkpoint) {
                try {
                    await options.checkpoint?.(message.checkpoint);
                    if (child.connected)
                        child.send({ continue: message.id });
                }
                catch (error) {
                    stop(error);
                }
            }
            else
                response = message;
        });
        child.on('close', code => {
            if (stopError)
                finish(stopError);
            else if (response?.error)
                finish(new GitError(response.error.message, response.error.status));
            else if (code === 0 && response && Object.hasOwn(response, 'result'))
                finish(undefined, response.result);
            else
                finish(new GitError('The workspace folder is not available', 503));
        });
        if (signal?.aborted)
            abort();
        else
            child.send({ ...request, checkpoints: !!options.checkpoint }, error => { if (error)
                stop(error); });
    });
}
