import { RemoteError, remotePath } from '../core/domain.js';
import { FILE_LIMIT, GIT_LIMITS, TEXT_LIMIT, type FileOperation, type GitBatch, type GitRun, type WorkspaceEntry, type WorkspaceFile, type WorkspaceManifest } from './domain.js';
import { createHash, randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { REMOTE_DSH_RUNNER } from './runner.js';
import { WORKSPACE_SHELL } from './shell.js';
import { quote, type SshTransport } from '../core/ssh.js';

interface Location { path: string; parent: string; base: string }
interface Match { path: string; line: number; text: string }
const digest = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const KINDS: Record<string, WorkspaceEntry['kind']> = { d: 'directory', f: 'file', l: 'symlink', o: 'other' };
/** A workspace path, normalized relative to the workspace. Containment of links is checked on the host. */
function locate(cwd: string, value: string): Location {
  if (value.includes('\0') || value.includes('\\')) throw new RemoteError('Invalid workspace path');
  if (!cwd.startsWith('/')) throw new RemoteError('Enter an absolute remote project path');
  const path = posix.relative(cwd, posix.resolve(cwd, value || '.'));
  if (path === '..' || path.startsWith('../') || posix.isAbsolute(path)) throw new RemoteError('Path is outside the remote workspace', 403);
  const parent = posix.dirname(path);
  return { path, parent: parent === '.' ? '' : parent, base: posix.basename(path) };
}
const nulSplit = (text: string) => text.split('\0').filter(Boolean);
/** A Git request's ID, which also names its job file on the SSH host. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class WorkspaceFiles {
  constructor(private readonly transport: SshTransport) {}
  /** Runs one shell operation and returns its data; the program reports handled failures with their status. */
  private async run(op: string, cwd: string, at: Location, values: Record<string, string>, options: { input?: AsyncIterable<Uint8Array>; maxBytes: number; signal?: AbortSignal }): Promise<Buffer> {
    if (!this.transport.transfer) throw new RemoteError('File transfers are unavailable on this host', 501);
    const assignments = Object.entries({ op, cwd: remotePath(cwd), path: at.path, parent: at.parent, base: at.base, id: randomUUID(), ...values })
      .map(([name, value]) => `dsh_${name}=${quote(value)}\n`).join('');
    const output = await this.transport.transfer(assignments + WORKSPACE_SHELL, { ...options, maxBytes: options.maxBytes + 4096 });
    if (output.subarray(0, 3).toString('latin1') === 'ok\n') return output.subarray(3);
    const failure = /^error (\d{3}) ([\s\S]*)$/.exec(output.subarray(0, 8192).toString('utf8'));
    if (failure) throw new RemoteError(failure[2].trim() || 'Remote workspace operation failed', Number(failure[1]));
    throw new RemoteError('The SSH host returned an unexpected workspace response', 502);
  }
  /** Remote DSH runs on Node.js, so only its own operations need it on the host. */
  private async remoteDsh(cwd: string, operation: FileOperation, signal?: AbortSignal): Promise<unknown> {
    if (!this.transport.transfer) throw new RemoteError('File transfers are unavailable on this host', 501);
    const request = quote(JSON.stringify({ ...operation, cwd: remotePath(cwd) }));
    const command = `command -v node >/dev/null 2>&1 || { printf '%s' '{"error":"Remote DSH needs Node.js on the SSH host login PATH","status":501}'; exit 0; }
node -e ${quote(REMOTE_DSH_RUNNER)} ${request}`;
    const response = JSON.parse((await this.transport.transfer(command, { maxBytes: 2_000_000, signal })).toString('utf8')) as { result?: unknown; error?: string; status?: number };
    if (response.error) throw new RemoteError(response.error, response.status ?? 400);
    return response.result;
  }
  async operate(cwd: string, operation: FileOperation, signal?: AbortSignal): Promise<unknown> {
    if (operation.op === 'write') {
      const data = Buffer.from(operation.content);
      if (data.length > TEXT_LIMIT) throw new RemoteError('File exceeds the 256 KB editor limit', 413);
      return this.upload(cwd, operation.path, operation.revision, data.length, (async function* () { yield data; })(), signal);
    }
    if (operation.op === 'webStart' || operation.op === 'webStop') return this.remoteDsh(cwd, operation, signal);
    const at = locate(remotePath(cwd), operation.path), under = (name: string) => at.path ? `${at.path}/${name}` : name;
    switch (operation.op) {
      case 'list': {
        const text = (await this.run('list', cwd, at, {}, { maxBytes: 4_000_000, signal })).toString('utf8');
        // "<kind><name>" records up to an empty one, then one "size mtime" line per entry when stat is available.
        const names: string[] = []; let index = 0;
        for (let end = text.indexOf('\0'); end > index; end = text.indexOf('\0', index)) { names.push(text.slice(index, end)); index = end + 1; }
        const stats = text.slice(index + 1).split('\n').filter(Boolean).map(line => line.split(' ').map(Number));
        const entries: WorkspaceEntry[] = names.map((record, i) => {
          const [size, modified] = stats.length === names.length ? stats[i] : [0, 0];
          return { name: record.slice(1), path: under(record.slice(1)), kind: KINDS[record[0]] ?? 'other', size: size || 0, modified: new Date((modified || 0) * 1000).toISOString() };
        });
        entries.sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name));
        return { path: at.path, entries };
      }
      case 'read': {
        const data = await this.run('read', cwd, at, {}, { maxBytes: TEXT_LIMIT, signal });
        if (data.length > TEXT_LIMIT) throw new RemoteError('File exceeds the 256 KB editor limit. Download it instead.', 413);
        if (data.includes(0)) throw new RemoteError('This is a binary file. Download it instead.');
        let content: string;
        try { content = new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { throw new RemoteError('File is not UTF-8 text. Download it instead.'); }
        return { path: at.path, content, revision: digest(data), size: data.length } satisfies WorkspaceFile;
      }
      case 'stat': {
        const [revision, size] = (await this.run('stat', cwd, at, {}, { maxBytes: 200, signal })).toString('utf8').trim().split(' ');
        return { path: at.path, revision, size: Number(size) };
      }
      case 'mkdir':
        await this.run('mkdir', cwd, at, {}, { maxBytes: 0, signal });
        return { path: at.path };
      case 'remove': case 'move': {
        if (!at.path) throw new RemoteError('Cannot remove or move the workspace root');
        const to = operation.op === 'move' ? locate(remotePath(cwd), operation.destination) : undefined;
        if (to && !to.path) throw new RemoteError('A file or folder with this name already exists', 409);
        await this.run(operation.op, cwd, at, { revision: operation.revision, ...(to ? { destination: to.path, destination_parent: to.parent, destination_base: to.base } : {}) }, { maxBytes: 0, signal });
        return { path: (to ?? at).path };
      }
      case 'manifest': {
        // "size path" lines, the digest lines in the same order, then the skipped paths.
        const text = (await this.run('manifest', cwd, at, {}, { maxBytes: 16_000_000, signal })).toString('utf8');
        const first = text.indexOf('\0'), second = text.indexOf('\0', first + 1);
        const kept = text.slice(0, first).split('\n').filter(Boolean), digests = text.slice(first + 1, second).split('\n').filter(Boolean);
        if (first < 0 || second < 0 || kept.length !== digests.length) throw new RemoteError('Files changed during the scan. Try again.', 409);
        const files: WorkspaceManifest['files'] = Object.create(null);
        kept.forEach((line, i) => {
          // GNU tools mark a line whose name they escaped with a leading backslash.
          const space = line.indexOf(' '), hash = digests[i].replace(/^\\/, '').slice(0, 64);
          if (!/^[a-f0-9]{64}$/.test(hash)) throw new RemoteError('The SSH host returned an unexpected workspace response', 502);
          files[under(line.slice(space + 1))] = { hash, size: Number(line.slice(0, space)) };
        });
        return { files, skipped: nulSplit(text.slice(second + 1)).map(under) } satisfies WorkspaceManifest;
      }
      case 'search': {
        // A line never contains a newline, so such a query matches nothing.
        if (operation.query.includes('\n')) return { matches: [], truncated: false, skipped: [] };
        const parts = (await this.run('search', cwd, at, { query: operation.query }, { maxBytes: 16_000_000, signal })).toString('utf8').split('\0');
        const matches: Match[] = []; let index = 0;
        for (; index < parts.length && parts[index]; index++) {
          const [file, ...lines] = parts[index].split('\n');
          for (const line of lines) {
            const colon = line.indexOf(':');
            if (colon > 0 && matches.length < 200) matches.push({ path: under(file), line: Number(line.slice(0, colon)), text: line.slice(colon + 1).slice(0, 500) });
          }
        }
        return { matches, truncated: matches.length >= 200, skipped: parts.slice(index + 1).filter(Boolean).map(under) };
      }
      case 'command': {
        const data = await this.run('command', cwd, at, { command: operation.command, timeout: String(Math.min(120_000, Math.max(1000, operation.timeoutMs ?? 30_000))) }, { maxBytes: 2 * (TEXT_LIMIT + 1), signal });
        const newline = data.indexOf(10), [code, timedOut, outBytes, errBytes] = data.subarray(0, newline).toString('latin1').split(' ');
        const out = data.subarray(newline + 1, newline + 1 + Number(outBytes)), err = data.subarray(newline + 1 + Number(outBytes), newline + 1 + Number(outBytes) + Number(errBytes));
        const truncated = out.length + err.length > TEXT_LIMIT, stdout = out.subarray(0, TEXT_LIMIT);
        // A command stopped for its timeout or output limit has no exit code.
        return { stdout: stdout.toString('utf8'), stderr: err.subarray(0, TEXT_LIMIT - stdout.length).toString('utf8'),
          exitCode: timedOut === '1' || truncated || !/^\d+$/.test(code) ? null : Number(code), timedOut: timedOut === '1', truncated };
      }
    }
    throw new RemoteError('Unknown workspace operation');
  }
  async download(cwd: string, path: string, revision: string, signal?: AbortSignal): Promise<Buffer> {
    const data = await this.run('download', cwd, locate(remotePath(cwd), path), {}, { maxBytes: FILE_LIMIT, signal });
    if (digest(data) !== revision) throw new RemoteError('The file changed. Reload it before saving.', 409);
    return data;
  }
  async upload(cwd: string, path: string, revision: string | null, size: number, input: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<unknown> {
    if (!Number.isSafeInteger(size) || size < 0 || size > FILE_LIMIT) throw new RemoteError('File exceeds the 50 MB transfer limit', 413);
    if (revision !== null && !/^[a-f0-9]{64}$/.test(revision)) throw new RemoteError('A file revision is required');
    const at = locate(remotePath(cwd), path);
    const [written, bytes] = (await this.run('upload', cwd, at, { revision: revision ?? '', size: String(size) }, { input, maxBytes: 200, signal })).toString('utf8').trim().split(' ');
    return { path: at.path, revision: written, size: Number(bytes) };
  }
  /** Runs Git commands in one round trip. The SSH host passes the whole program as one argument, so arguments stay small. */
  async git(cwd: string, batch: GitBatch, signal?: AbortSignal): Promise<GitRun[]> {
    const { commands } = batch, values: Record<string, string> = {};
    if (!UUID.test(batch.id)) throw new RemoteError('Invalid Git request');
    if (!Array.isArray(commands) || !commands.length || commands.length > GIT_LIMITS.commands) throw new RemoteError('Invalid Git request');
    if (!Number.isSafeInteger(batch.maxBytes) || batch.maxBytes < 1 || batch.maxBytes > GIT_LIMITS.output) throw new RemoteError('Invalid Git output limit');
    let bytes = 0, time = 0;
    commands.forEach(({ argv, timeoutMs }, i) => {
      if (!Array.isArray(argv) || !argv.length || argv.length > GIT_LIMITS.arguments || argv.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new RemoteError('Invalid Git arguments');
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > GIT_LIMITS.timeoutMs) throw new RemoteError('Invalid Git timeout');
      time += timeoutMs;
      values[`argc_${i}`] = String(argv.length); values[`timeout_${i}`] = String(timeoutMs);
      argv.forEach((arg, j) => { values[`arg_${i}_${j}`] = arg; bytes += Buffer.byteLength(arg); });
    });
    if (bytes > GIT_LIMITS.bytes) throw new RemoteError('Git arguments are too long', 413);
    if (time > GIT_LIMITS.totalMs) throw new RemoteError('Invalid Git timeout');
    const at = locate(remotePath(cwd), batch.path ?? '');
    const data = await this.run('git', cwd, at, { ...values, id: batch.id, count: String(commands.length), limit: String(batch.maxBytes),
      stop: batch.stopOnError ? '1' : '', optional_locks: batch.optionalLocks === false ? '0' : '1' }, { maxBytes: commands.length * (batch.maxBytes + 65_600), signal });
    const runs: GitRun[] = [];
    for (let offset = 0; runs.length < commands.length;) {
      const newline = data.indexOf(10, offset);
      if (newline < 0) throw new RemoteError('The SSH host returned an unexpected workspace response', 502);
      const [code, timedOut, outBytes, errBytes] = data.subarray(offset, newline).toString('latin1').split(' ');
      const out = data.subarray(newline + 1, newline + 1 + Number(outBytes)), end = newline + 1 + Number(outBytes) + Number(errBytes);
      const truncated = out.length > batch.maxBytes;
      runs.push({ exitCode: /^\d+$/.test(code) && timedOut !== '1' && !truncated ? Number(code) : null, timedOut: timedOut === '1', truncated, skipped: code === 'skip',
        stdout: out.subarray(0, batch.maxBytes).toString('utf8'), stderr: data.subarray(newline + 1 + Number(outBytes), end).subarray(0, 65_536).toString('utf8') });
      offset = end;
    }
    return runs;
  }
  /** Stops a running `git` request and the commands it has not started. */
  async cancelGit(cwd: string, id: string, signal?: AbortSignal): Promise<void> {
    if (!UUID.test(id)) throw new RemoteError('Invalid Git request');
    await this.run('gitCancel', cwd, locate(remotePath(cwd), ''), { job_id: id }, { maxBytes: 0, signal });
  }
}
