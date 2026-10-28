/**
 * Node program that starts and stops a managed remote `dsh web` over the existing authenticated SSH transport.
 * Remote DSH is itself a Node application; workspace files and commands use the POSIX shell program instead.
 */
export const REMOTE_DSH_RUNNER = String.raw`
const fs = require('node:fs/promises'), path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const request = JSON.parse(process.argv[1]);
const fail = (message, status = 400) => { const error = new Error(message); error.status = status; throw error; };
async function main() {
  const root = await fs.realpath(request.cwd);
  if (!(await fs.stat(root)).isDirectory()) fail('Not a readable directory');
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
  fail('Unknown workspace operation');
}
main().then(result => process.stdout.write(JSON.stringify({ result }))).catch(error => {
  process.stdout.write(JSON.stringify({ error: error.message, status: error.status || (error.code === 'ENOENT' ? 404 : 400) }));
});
`;
