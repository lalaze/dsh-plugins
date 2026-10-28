import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { homedir, hostname, userInfo } from 'node:os';
import { isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { remotePath } from './domain.js';
import { connectionInput } from './ssh.js';
/** DSH's home directory, which holds dsh-remote's workspace folders under `remote-workspaces`. */
export const dshHome = () => process.env.DSH_HOME?.trim() || join(homedir(), '.dsh');
/** dsh-oh-my-claude's state directory, which holds its workspace bindings and placeholder folders. */
export const omcStateDir = () => process.env.DSH_OMC_STATE_DIR || join(homedir(), '.local', 'state', 'dsh-oh-my-claude');
export const under = (root, path) => { const r = relative(root, path); return r === '' || r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r); };
const normalizeHost = (host) => host.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
export const sameEndpoint = (a, b) => normalizeHost(a.host) === normalizeHost(b.host) && a.username === b.username && a.port === b.port;
async function json(path) {
    try {
        if ((await stat(path)).size > 1_048_576)
            throw new Error('Remote workspace binding is too large');
        return JSON.parse(await readFile(path, 'utf8'));
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return undefined;
        throw error;
    }
}
/** Resolve SSH aliases locally; do not start a CLI or connect merely to list models. */
export function sshEndpoint(connection, signal) {
    const url = new URL(connectionInput(connection));
    return new Promise((accept, reject) => execFile('ssh', ['-G', ...(url.port ? ['-p', url.port] : []), '--', `${url.username ? `${decodeURIComponent(url.username)}@` : ''}${url.hostname}`], { timeout: 5000, maxBuffer: 262144, signal }, (error, stdout) => {
        if (error)
            return reject(error);
        const values = new Map(stdout.split(/\r?\n/).map(line => { const i = line.indexOf(' '); return [line.slice(0, i), line.slice(i + 1).trim()]; }));
        const host = values.get('hostname'), username = values.get('user'), port = Number(values.get('port'));
        if (!host || !username || !Number.isInteger(port) || port < 1 || port > 65535)
            return reject(new Error('Invalid workspace SSH endpoint'));
        accept({ host, username, port });
    }));
}
/** Admission is derived from the workspace origin, never a display name or a matching path alone. */
export class WorkspaceAccess {
    hosts;
    options;
    home;
    omc;
    constructor(hosts, options = {}) {
        this.hosts = hosts;
        this.options = options;
        this.home = options.home ?? dshHome();
        this.omc = options.omc ?? omcStateDir();
    }
    async binding(cwd) {
        const local = resolve(cwd), root = resolve(this.home, 'remote-workspaces');
        if (under(root, local)) {
            try {
                const parts = relative(root, local).split(sep);
                if (parts.length < 2 || !parts[0] || !parts[1])
                    throw new Error();
                const mirror = join(root, parts[0], parts[1]), file = join(mirror, '.dsh-remote-meta.json');
                const [realRoot, realMirror, realLocal, realFile] = await Promise.all([root, mirror, local, file].map(p => realpath(p)));
                if (!under(realRoot, realMirror) || !under(realMirror, realLocal) || !under(realMirror, realFile))
                    throw new Error();
                const meta = await json(file);
                if (!meta || typeof meta.host !== 'string' || typeof meta.username !== 'string' || !meta.username)
                    throw new Error();
                const port = meta.port ?? 22;
                if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535)
                    throw new Error();
                connectionInput(`ssh://${meta.username}@${meta.host.includes(':') && !meta.host.startsWith('[') ? `[${meta.host}]` : meta.host}:${port}`);
                const path = posix.join(remotePath(meta.remotePath), ...parts.slice(2));
                let alias;
                try {
                    alias = typeof meta.alias === 'string' && meta.alias ? connectionInput(meta.alias) : undefined;
                }
                catch {
                    alias = undefined;
                }
                return { endpoint: { host: meta.host, username: meta.username, port }, ...(alias ? { alias } : {}), cwd: path, revision: JSON.stringify([realMirror, meta, path]) };
            }
            catch {
                throw new Error('Cannot read a valid remote workspace binding');
            }
        }
        const rows = await json(join(this.omc, 'remote-workspaces.json'));
        if (rows !== undefined && !Array.isArray(rows))
            throw new Error('Invalid remote workspace binding');
        const row = (rows ?? []).filter((r) => {
            if (!r || typeof r !== 'object' || !('path' in r) || typeof r.path !== 'string')
                return false;
            return isAbsolute(r.path) && under(resolve(r.path), local);
        }).sort((a, b) => b.path.length - a.path.length)[0];
        if (!row)
            return undefined;
        if (typeof row.host !== 'string' || !row.workspaceId)
            throw new Error('Invalid remote workspace binding');
        connectionInput(row.host);
        if (!under(await realpath(row.path), await realpath(local)))
            throw new Error('Invalid remote workspace binding');
        return { connection: row.host, cwd: posix.join(remotePath(row.remoteCwd), ...relative(row.path, local).split(sep)), revision: JSON.stringify(row) };
    }
    async resolve(cwd, signal) {
        signal?.throwIfAborted();
        if (!cwd)
            return { hostIds: [] };
        const binding = await this.binding(cwd);
        if (!binding) {
            // Removed placeholder directories must never fall through to the local process provider.
            if (under(resolve(this.omc, 'remote-workspaces'), resolve(cwd)))
                return { hostIds: [] };
            return this.fromRuntime(cwd, signal);
        }
        const endpointFor = this.options.endpoint ?? sshEndpoint;
        const endpoints = [binding.endpoint ?? await endpointFor(binding.connection, signal)];
        if (binding.alias) {
            try {
                endpoints.push(await endpointFor(binding.alias, signal));
            }
            catch {
                signal?.throwIfAborted();
            }
        }
        const matches = await Promise.all(this.hosts().map(async (host) => {
            try {
                const candidate = await endpointFor(host.connection, signal);
                return endpoints.some(endpoint => sameEndpoint(endpoint, candidate)) ? host.id : undefined;
            }
            catch (error) {
                signal?.throwIfAborted();
                return undefined;
            }
        }));
        signal?.throwIfAborted();
        if ((await this.binding(cwd))?.revision !== binding.revision)
            throw new Error('Remote workspace binding changed during verification');
        return { hostIds: matches.filter((id) => !!id), cwd: binding.cwd };
    }
    async fromRuntime(cwd, signal) {
        const runtime = this.options.runtime?.();
        if (!runtime)
            return { hostIds: [] };
        const deadline = AbortSignal.timeout(5000), combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
        combined.throwIfAborted();
        const script = `dsh_machine_id="$(cat /etc/machine-id 2>/dev/null)"; if [ -z "$dsh_machine_id" ]; then dsh_machine_id="$(uname -s)"; fi; printf '%s\\0%s\\0%s\\0%s\\0' "$(uname -n)" "$(id -un)" "$dsh_machine_id" "$(pwd -P)"`;
        const handle = runtime.spawn({ argv: ['/bin/sh', '-c', script], cwd, stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }, graceMs: 1000, signal: combined });
        let output = '', oversized = false;
        const terminate = () => handle.terminate();
        combined.addEventListener('abort', terminate, { once: true });
        handle.stdout?.on('data', data => { output += String(data); if (output.length > 16384) {
            oversized = true;
            terminate();
        } });
        handle.stderr?.resume();
        try {
            const result = await handle.done;
            combined.throwIfAborted();
            if (result.exitCode !== 0 || oversized)
                throw new Error('Could not verify the workspace machine');
            const [machine, user, unique, path] = output.split('\0');
            if (!machine || !user || !unique || !path)
                throw new Error('Invalid workspace machine identity');
            if (machine === hostname() && user === userInfo().username)
                return { hostIds: [] };
            const serverId = `ssh-${createHash('sha256').update(JSON.stringify([machine, user, unique])).digest('hex')}`;
            return { hostIds: this.hosts().filter(host => host.serverId === serverId).map(host => host.id), cwd: remotePath(path) };
        }
        finally {
            combined.removeEventListener('abort', terminate);
        }
    }
}
