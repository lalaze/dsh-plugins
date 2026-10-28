/** Node program executed over the existing authenticated SSH transport; no resident file server. */
export const WORKSPACE_RUNNER = String.raw `
const fs = require('node:fs/promises'), path = require('node:path'), crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { execFileSync } = require('node:child_process');
const request = JSON.parse(process.argv[1]);
const LIMIT = 50 * 1024 * 1024, TEXT = 256 * 1024;
const ignored = new Set(['.git', 'node_modules', 'dist', 'build', 'target', '.dsh-remote-agents', '.dsh-remote-meta.json']);
// Containment by relative path: a prefix test would demand "//" below a workspace at "/".
const under = (root, file) => { const r = path.relative(root, file); return r === '' || r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r); };
const digest = data => crypto.createHash('sha256').update(data).digest('hex');
const fail = (message, status = 400) => { const error = new Error(message); error.status = status; throw error; };
async function main() {
  const root = await fs.realpath(request.cwd);
  if (!(await fs.stat(root)).isDirectory()) fail('Not a readable directory');
  const resolve = async (value, missing = false) => {
    if (typeof value !== 'string' || value.includes('\0') || value.includes('\\')) fail('Invalid workspace path');
    const file = path.resolve(root, value || '.');
    if (!under(root, file)) fail('Path is outside the remote workspace', 403);
    const parent = file === root ? root : await fs.realpath(path.dirname(file));
    if (!under(root, parent)) fail('Path is outside the remote workspace', 403);
    try { if (!under(root, await fs.realpath(file))) fail('Path is outside the remote workspace', 403); }
    catch (error) { if (!missing || error.code !== 'ENOENT') throw error; }
    return file;
  };
  const relative = file => path.relative(root, file).split(path.sep).join('/');
  const file = await resolve(request.path, ['write', 'mkdir', 'upload'].includes(request.op));
  const stat = async p => { try { return await fs.lstat(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
  const bytes = async p => {
    await resolve(p);
    const s = await fs.lstat(p);
    if (!s.isFile() || s.isSymbolicLink()) fail('Select a regular file');
    if (s.size > LIMIT) fail('File exceeds the 50 MB transfer limit', 413);
    return fs.readFile(p);
  };
  const revision = async p => {
    const s = await stat(p);
    if (!s) return null;
    if (!s.isFile() || s.isSymbolicLink()) fail('Select a regular file');
    return digest(await bytes(p));
  };
  const check = async (p, expected) => {
    if (expected !== null && (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected))) fail('A file revision is required');
    if (await revision(p) !== expected) fail('The file changed. Reload it before saving.', 409);
  };
  // Revision checks and the replacements they guard run under a per-file lock shared by every runner process,
  // so two requests holding the same revision cannot both succeed. Each contender announces itself with a uniquely
  // named entry and proceeds only while no other live entry exists. Entries are never reused, so removing a dead
  // holder's entry (for example one whose SSH session ended) can never remove a live one.
  const exclusive = async (p, action) => {
    const locks = path.join(require('node:os').homedir(), '.dsh-remote-agents', 'locks');
    await fs.mkdir(locks, { recursive: true, mode: 448 });
    const key = digest(path.join(await fs.realpath(path.dirname(p)), path.basename(p))) + '.';
    let mine;
    const live = async name => {
      let alive = true;
      try { process.kill(Number(name.slice(key.length).split('.')[0]), 0); } catch (error) { alive = error.code === 'EPERM'; }
      const held = await stat(path.join(locks, name));
      return !!held && alive && Date.now() - held.mtimeMs <= 120000;
    };
    // Contenders that saw each other all withdraw; randomized exponential backoff lets one of them through.
    for (let end = Date.now() + 30000, attempt = 0; ; await new Promise(r => setTimeout(r, Math.random() * Math.min(1000, 20 * 2 ** attempt++)))) {
      // A fresh name per attempt: a removal aimed at an abandoned attempt must never hit a later one.
      mine = path.join(locks, key + process.pid + '.' + crypto.randomUUID());
      await fs.writeFile(mine, '', { flag: 'wx', mode: 384 });
      let contended = false;
      for (const name of await fs.readdir(locks)) {
        if (!name.startsWith(key) || path.join(locks, name) === mine) continue;
        if (await live(name)) contended = true;
        else await fs.rm(path.join(locks, name), { force: true });
      }
      if (!contended) break;
      await fs.rm(mine, { force: true });
      if (Date.now() > end) fail('Another save to this file is still running. Try again.', 409);
    }
    try { return await action(); } finally { await fs.rm(mine, { force: true }); }
  };
  const atomic = async (p, data, expected) => {
    await check(p, expected);
    const previous = await stat(p), temporary = path.join(path.dirname(p), '.dsh-ra-upload-' + crypto.randomUUID());
    try {
      await fs.writeFile(temporary, data, { flag: 'wx', mode: previous ? previous.mode & 511 : 384 });
      await exclusive(p, async () => {
        await check(p, expected);
        if (expected === null) { await fs.link(temporary, p); await fs.unlink(temporary); }
        else await fs.rename(temporary, p);
      });
    } finally { await fs.rm(temporary, { force: true }); }
    return { path: relative(p), revision: digest(data), size: data.length };
  };
  if (request.op === 'list') {
    const names = await fs.readdir(file); if (names.length > 10000) fail('Directory has too many entries');
    const entries = [];
    for (const name of names) {
      if (name === '.dsh-remote-meta.json' || name.startsWith('.dsh-ra-upload-')) continue;
      const p = path.join(file, name), s = await fs.lstat(p);
      entries.push({ name, path: relative(p), kind: s.isSymbolicLink() ? 'symlink' : s.isDirectory() ? 'directory' : s.isFile() ? 'file' : 'other', size: s.size, modified: s.mtime.toISOString() });
    }
    entries.sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name));
    return { path: relative(file), entries };
  }
  if (request.op === 'read') {
    const data = await bytes(file); if (data.length > TEXT) fail('File exceeds the 256 KB editor limit. Download it instead.', 413);
    if (data.includes(0)) fail('This is a binary file. Download it instead.');
    let content; try { content = new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { fail('File is not UTF-8 text. Download it instead.'); }
    return { path: relative(file), content, revision: digest(data), size: data.length };
  }
  if (request.op === 'stat') return { path: relative(file), revision: await revision(file), size: (await fs.stat(file)).size };
  if (request.op === 'webStart' || request.op === 'webStop') {
    const port = request.port;
    if (!Number.isInteger(port) || port < 1024 || port > 65535) fail('Invalid remote DSH port');
    const base = path.join(require('node:os').homedir(), '.dsh-remote-agents', 'web-ui', String(port));
    await fs.mkdir(base, { recursive: true, mode: 448 });
    if ((await fs.lstat(base)).isSymbolicLink()) fail('Invalid remote DSH directory');
    const metaFile = path.join(base, 'process.json'), logFile = path.join(base, 'output.log');
    const stamp = pid => { try { return execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' }).trim(); } catch { return ''; } };
    let meta; try { meta = JSON.parse(await fs.readFile(metaFile, 'utf8')); } catch {}
    const owned = meta && Number.isSafeInteger(meta.pid) && meta.pid > 1 && meta.cwd === root && meta.stamp && stamp(meta.pid) === meta.stamp;
    if (request.op === 'webStop') {
      if (!owned) fail('No managed remote DSH process is running for this workspace', 409);
      try { process.kill(-meta.pid, 'SIGTERM'); } catch {}
      await fs.rm(metaFile, { force: true }); return { stopped: true };
    }
    if (meta && meta.cwd !== root && stamp(meta.pid) === meta.stamp) fail('This remote DSH port belongs to another workspace', 409);
    // The browser reaches the instance through a tunnel on the access address; SSH keeps that Host header,
    // which dsh rejects unless it is trusted.
    const host = request.host;
    if (typeof host !== 'string' || !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(host)) fail('Invalid remote DSH access address');
    if (owned && meta.trustedHost !== host) fail('The running remote DSH does not trust this access address. Stop the managed instance and start it again.', 409);
    let started = false;
    if (!owned) {
      const log = await fs.open(logFile, 'w', 384);
      try {
        const child = spawn('dsh', ['web', '--port', String(port), '--no-open', '--trusted-host', host], { cwd: root, detached: true, stdio: ['ignore', log.fd, log.fd], env: { ...process.env, DSH_HOME: path.join(base, 'home') } });
        await new Promise((accept, reject) => { child.once('spawn', accept); child.once('error', reject); });
        child.unref();
        meta = { pid: child.pid, cwd: root, stamp: stamp(child.pid), trustedHost: host };
        await fs.writeFile(metaFile, JSON.stringify(meta), { mode: 384 }); started = true;
      } finally { await log.close(); }
    }
    let ready = false;
    try { for (const end = Date.now() + 20000; Date.now() < end; await new Promise(r => setTimeout(r, 150))) {
      const s = await fs.stat(logFile); if (s.size > 2 * 1024 * 1024) fail('Remote DSH startup log is too large');
      const text = (await fs.readFile(logFile, 'utf8')).replace(/\x1b\[[0-9;]*m/g, '');
      const urls = text.match(/https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/[^\s"'<>]*/g) || [];
      for (const value of urls) {
        try { const url = new URL(value); if (Number(url.port) === port && url.searchParams.has('token')) { ready = true; return { url: url.href, managed: true }; } } catch {}
      }
      if (stamp(meta.pid) !== meta.stamp) fail(text.slice(-2000) || 'Remote DSH stopped during startup');
    }
      fail('Remote DSH did not return a login URL. Install a compatible dsh on the remote login PATH, or connect to an existing instance.');
    } finally { if (started && !ready && stamp(meta.pid) === meta.stamp) { try { process.kill(-meta.pid, 'SIGTERM'); } catch {} } }
  }
  if (request.op === 'download') { await check(file, request.revision); process.stdout.write(await bytes(file)); return; }
  if (request.op === 'upload') {
    if (!Number.isSafeInteger(request.size) || request.size < 0 || request.size > LIMIT) fail('File exceeds the 50 MB transfer limit', 413);
    const chunks = []; let size = 0;
    for await (const chunk of process.stdin) { size += chunk.length; if (size > request.size) fail('Upload byte count mismatch'); chunks.push(chunk); }
    if (size !== request.size) fail('Upload byte count mismatch');
    return atomic(file, Buffer.concat(chunks), request.revision);
  }
  if (request.op === 'write') {
    if (typeof request.content !== 'string' || Buffer.byteLength(request.content) > TEXT) fail('File exceeds the 256 KB editor limit', 413);
    return atomic(file, Buffer.from(request.content), request.revision);
  }
  if (request.op === 'mkdir') { await fs.mkdir(file); return { path: relative(file) }; }
  if (request.op === 'remove' || request.op === 'move') {
    if (file === root) fail('Cannot remove or move the workspace root');
    const destination = request.op === 'move' ? await resolve(request.destination, true) : undefined;
    return exclusive(file, async () => {
      await check(file, request.revision);
      if (!destination) { await fs.unlink(file); return { path: relative(file) }; }
      // link/unlink never overwrites an existing destination and preserves the inode.
      await fs.link(file, destination); await check(file, request.revision); await fs.unlink(file);
      return { path: relative(destination) };
    });
  }
  if (request.op === 'manifest' || request.op === 'search') {
    const files = Object.create(null), skipped = [], matches = []; let count = 0, total = 0;
    if (request.op === 'search' && (typeof request.query !== 'string' || !request.query || request.query.length > 200)) fail('Enter a search string of 1–200 characters');
    const walk = async dir => {
      await resolve(dir);
      for (const name of await fs.readdir(dir)) {
        if (++count > 20000) fail('Workspace contains too many files for one operation');
        const p = path.join(dir, name), rel = relative(p);
        if (ignored.has(name) || name.startsWith('.dsh-ra-upload-')) continue;
        const s = await fs.lstat(p);
        if (s.isSymbolicLink()) { skipped.push(rel); continue; }
        if (s.isDirectory()) { await walk(p); continue; }
        if (!s.isFile() || s.size > (request.op === 'search' ? TEXT : LIMIT)) { skipped.push(rel); continue; }
        total += s.size; if (total > 512 * 1024 * 1024) fail('Workspace scan exceeds 512 MB');
        const data = await bytes(p);
        if (request.op === 'manifest') files[rel] = { hash: digest(data), size: data.length };
        else if (!data.includes(0) && matches.length < 200) {
          const lines = data.toString('utf8').split('\n');
          for (let i = 0; i < lines.length && matches.length < 200; i++) if (lines[i].includes(request.query)) matches.push({ path: rel, line: i + 1, text: lines[i].slice(0, 500) });
        }
      }
    };
    await walk(file);
    return request.op === 'manifest' ? { files, skipped } : { matches, truncated: matches.length >= 200, skipped };
  }
  if (request.op === 'command') {
    if (typeof request.command !== 'string' || !request.command.trim() || request.command.length > 32000) fail('Invalid remote command');
    const timeout = Math.min(120000, Math.max(1000, request.timeoutMs || 30000));
    return new Promise((accept, reject) => {
      const child = spawn('/bin/sh', ['-c', request.command], { cwd: file, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '', length = 0, timedOut = false, truncated = false;
      const stop = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
      const abort = () => { stop(); process.exit(1); };
      process.once('SIGHUP', abort); process.once('SIGTERM', abort);
      const timer = setTimeout(() => { timedOut = true; stop(); }, timeout);
      const collect = kind => data => { length += data.length; if (length > TEXT) { truncated = true; stop(); } else if (kind === 'out') stdout += data; else stderr += data; };
      child.stdout.on('data', collect('out')); child.stderr.on('data', collect('err'));
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', code => { clearTimeout(timer); process.removeListener('SIGHUP', abort); process.removeListener('SIGTERM', abort); accept({ stdout, stderr, exitCode: code, timedOut, truncated }); });
    });
  }
  fail('Unknown workspace operation');
}
main().then(result => { if (result !== undefined) process.stdout.write(JSON.stringify({ result })); }).catch(error => {
  if (request.op === 'download') { process.stderr.write(error.message); process.exitCode = 1; }
  else process.stdout.write(JSON.stringify({ error: error.message, status: error.status || (error.code === 'ENOENT' ? 404 : error.code === 'EEXIST' ? 409 : 400) }));
});
`;
