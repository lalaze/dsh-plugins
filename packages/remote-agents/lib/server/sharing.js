import { spawn } from 'node:child_process';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { basename, dirname, join, relative, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { BRIDGE_SCRIPT, BRIDGE_VERSION } from './bridge-script.js';
import { RemoteError } from './domain.js';
import { connectionInput, quote } from './ssh.js';
const BASE = '.dsh-remote-agents', SERVER = /^[A-Za-z0-9_-]{1,32}$/, SKILL = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SKIP = new Set(['.git', 'node_modules', '__pycache__', '.DS_Store', '.venv']);
const FILE_LIMIT = 4 * 1024 * 1024, SKILL_LIMIT = 16 * 1024 * 1024, TOTAL_LIMIT = 48 * 1024 * 1024, FILE_COUNT = 500;
/** How long a launch waits for the reverse forward, so the CLI's first tool listing reaches DSH. */
const FORWARD_WAIT = 10_000;
/** How long a host's install check is trusted. A deleted ~/.dsh-remote-agents is then installed again, as the relay is. */
const INSTALL_TTL = 60_000;
/** Project skills come from the local anchor directory, not the remote project; the remote CLI finds the project's own. */
const shareableSource = (source) => !source.startsWith('project-');
const toolSet = (tools) => tools ? JSON.stringify(tools) : '';
/** `mcp__<server>__<tool>`: DSH's MCP client names every tool after its configured server. */
export function mcpServerOf(name) {
    const match = /^mcp__([A-Za-z0-9_-]+?)__./.exec(name);
    return match && SERVER.test(match[1]) ? match[1] : undefined;
}
/**
 * Add the shared servers and skills to a CLI's own launch. Proxies are approved in the CLI, so DSH's permission
 * rules and approval prompts are the only gate: they run with the conversation's DSH agent.
 */
export function sharedArguments(protocol, launch, shared) {
    if (!shared)
        return launch;
    if (protocol === 'claude') {
        return [...launch, ...shared.pluginDir ? ['--plugin-dir', shared.pluginDir] : [],
            ...shared.servers.length ? ['--mcp-config', JSON.stringify({ mcpServers: Object.fromEntries(shared.servers.map(s => [s.name, { type: 'stdio', command: s.command, args: s.args }])) }),
                '--allowedTools', ...shared.servers.map(s => `mcp__${s.name}`)] : []];
    }
    if (protocol === 'codex') {
        // `-c` values are TOML; JSON strings and string arrays are valid TOML literals.
        const overrides = shared.servers.flatMap(s => ['-c', `mcp_servers.${s.name}.command=${JSON.stringify(s.command)}`, '-c', `mcp_servers.${s.name}.args=${JSON.stringify(s.args)}`,
            '-c', `mcp_servers.${s.name}.default_tools_approval_mode="approve"`]);
        return [launch[0], ...overrides, ...launch.slice(1)];
    }
    return launch;
}
/** ACP's standard stdio declarations for `session/new`, `session/load` and `session/resume`. */
export const acpServers = (shared) => (shared?.servers ?? []).map(s => ({ name: s.name, command: s.command, args: s.args, env: [] }));
export function bridgeForwardArguments(connection, remoteSocket, port) {
    const url = new URL(connectionInput(connection));
    const target = `${decodeURIComponent(url.username) ? `${decodeURIComponent(url.username)}@` : ''}${url.hostname}`;
    return ['-v', '-N', '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=10',
        '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', ...(url.port ? ['-p', url.port] : []), '-R', `${remoteSocket}:127.0.0.1:${port}`, '--', target];
}
/**
 * MCP content for a settled call: DSH's model-facing content, as its post-execute policies left it. Images are read
 * from DSH's attachment store by the reference in that content, so a replaced image is sent as its replacement. An
 * offloaded image, or one that cannot be read, is omitted.
 */
export async function mcpContent(result, attachments, signal) {
    return Promise.all(result.content.map(async (block) => {
        if (block.type === 'text')
            return { type: 'text', text: block.text ?? '' };
        const ref = block.attachment;
        if (block.type === 'image' && !block.offloaded && attachments && ref && typeof ref.width === 'number' && typeof ref.height === 'number' && typeof ref.bytes === 'number') {
            try {
                // At its stored dimensions and size.
                const image = await attachments.readImageRequest(ref, { width: ref.width, height: ref.height, maxBytes: ref.bytes }, signal);
                return { type: 'image', data: Buffer.from(image.data).toString('base64'), mimeType: image.mediaType };
            }
            catch { }
        }
        return { type: 'text', text: `[${block.type} omitted]` };
    }));
}
const contents = (file) => file.data ? Promise.resolve(file.data) : readFile(file.source);
async function sourceFile(source) { const info = await stat(source); return { path: 'SKILL.md', size: info.size, source, mtime: info.mtimeMs }; }
/** A directory bundle's files, or just its instruction file when the bundle is too large to copy. Only metadata is read. */
async function bundleFiles(directory) {
    const files = [];
    let total = 0;
    const walk = async (folder, depth) => {
        for (const entry of (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
            if (SKIP.has(entry.name))
                continue;
            const path = join(folder, entry.name), info = await stat(path).catch(() => undefined);
            if (!info)
                continue;
            if (info.isDirectory()) {
                if (depth < 6 && !await walk(path, depth + 1))
                    return false;
                continue;
            }
            if (!info.isFile())
                continue;
            if (info.size > FILE_LIMIT || (total += info.size) > SKILL_LIMIT || files.length >= FILE_COUNT)
                return false;
            files.push({ path: relative(directory, path).split(sep).join('/'), size: info.size, source: path, mtime: info.mtimeMs, ...(info.mode & 0o100 ? { executable: true } : {}) });
        }
        return true;
    };
    if (await walk(directory, 0))
        return files;
    return [await sourceFile(join(directory, 'SKILL.md'))];
}
function remoteSkills(text) {
    try {
        const value = JSON.parse(text?.trim() || '{}');
        const skills = value.skills && typeof value.skills === 'object' ? Object.fromEntries(Object.entries(value.skills).filter(([, hash]) => typeof hash === 'string')) : {};
        return { skills, ...(typeof value.fingerprint === 'string' ? { fingerprint: value.fingerprint } : {}) };
    }
    catch {
        return { skills: {} };
    }
}
class HostBridge {
    host;
    transport;
    info;
    checked = 0;
    remote;
    syncing = Promise.resolve();
    forward;
    retry;
    delay = 2000;
    error;
    /** Replaced or removed: it never starts a forward again. */
    stopped = false;
    constructor(host, transport) {
        this.host = host;
        this.transport = transport;
    }
}
/**
 * Shares DSH's MCP servers (through DSH, off by default) and skills (copied to the host, on by default) with
 * remote CLIs. MCP calls reach DSH over one reverse-forwarded Unix socket per host and run with the DSH agent of
 * the conversation that owns the CLI, so DSH's permissions, approvals and hooks apply and credentials stay in DSH.
 */
export class Sharing {
    store;
    launch;
    log;
    host = {};
    server;
    listening;
    bridges = new Map();
    connections = new Set();
    /** Content hashes of skill bundles by file metadata, so unchanged skills are not read again for every launch. */
    hashes = new Map();
    /** Each server's tools as its proxies last listed them, so only real changes are announced. */
    listed = new Map();
    toolsTimer;
    closed = false;
    constructor(store, launch = args => spawn('ssh', args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }), log = message => console.warn(`[remote-agents] ${message}`)) {
        this.store = store;
        this.launch = launch;
        this.log = log;
    }
    settings() { return this.store.sharing(); }
    /** MCP is shared only when switched on; skills unless switched off. */
    mcpShared(server) { return this.settings().mcp?.[server] === true; }
    skillShared(name) { return this.settings().skills?.[name] !== false; }
    mcpServers() {
        const servers = new Map();
        for (const tool of this.host.tools?.schemas() ?? []) {
            const server = mcpServerOf(tool.name);
            if (server)
                servers.set(server, [...servers.get(server) ?? [], tool]);
        }
        return servers;
    }
    async skillList(signal) {
        return [...await this.host.skills?.list({ signal }) ?? []].filter(s => s.invocation.modelInvocable && shareableSource(s.source) && SKILL.test(s.name));
    }
    async catalog(signal) {
        const skills = await this.skillList(signal).catch(error => { this.log(`Reading DSH skills failed: ${String(error)}`); return []; });
        return {
            available: { mcp: !!this.host.tools, skills: !!this.host.skills },
            mcp: [...this.mcpServers()].map(([name, tools]) => ({ name, tools: tools.length, shared: this.mcpShared(name) })).sort((a, b) => a.name.localeCompare(b.name)),
            skills: skills.map(s => ({ name: s.name, description: s.description, source: s.source, shared: this.skillShared(s.name) })),
        };
    }
    async set(kind, name, shared) {
        if (kind !== 'mcp' && kind !== 'skill')
            throw new RemoteError('Invalid share type');
        if (typeof name !== 'string' || !(kind === 'mcp' ? SERVER : SKILL).test(name) || typeof shared !== 'boolean')
            throw new RemoteError('Invalid share');
        await this.store.update(state => {
            const sharing = state.sharing ??= {}, table = kind === 'mcp' ? sharing.mcp ??= {} : sharing.skills ??= {};
            // Defaults are not stored, so a later change of default would apply to untouched entries.
            if (shared === (kind === 'skill'))
                delete table[name];
            else
                table[name] = shared;
        });
        if (kind === 'mcp')
            this.changed(name);
    }
    /** Ask the CLIs using a server to list its tools again. */
    changed(server) {
        for (const connection of this.connections)
            if (!server || connection.server === server)
                connection.socket.write(`${JSON.stringify({ event: 'changed' })}\n`);
    }
    /** DSH's tools changed, for example once an MCP server connected: the CLIs list the servers whose tools did again. */
    toolsChanged() {
        clearTimeout(this.toolsTimer);
        if (this.closed)
            return;
        this.toolsTimer = setTimeout(() => {
            const servers = this.mcpServers();
            for (const [name, seen] of this.listed) {
                const now = toolSet(servers.get(name));
                if (now !== seen) {
                    this.listed.set(name, now);
                    this.changed(name);
                }
            }
        }, 200);
    }
    async secret() {
        let value = this.settings().secret;
        if (!value) {
            const created = randomBytes(32).toString('hex');
            await this.store.update(state => { (state.sharing ??= {}).secret ??= created; });
            value = this.settings().secret;
        }
        return Buffer.from(value, 'hex');
    }
    async token(taskId) { return createHmac('sha256', await this.secret()).update(taskId).digest('hex'); }
    /** The conversation whose DSH agent runs the CLI's MCP calls: the main chat, or the agent that delegated it. */
    owner(task) { return task.chat?.sessionId ?? task.owner?.sessionId; }
    /** Names this DSH's socket pointer and tool cache on a host: one remote account may be used from several computers. */
    async instance() { return createHmac('sha256', await this.secret()).update('instance').digest('hex').slice(0, 16); }
    listen() {
        if (this.closed)
            return Promise.reject(new Error('Sharing has stopped'));
        this.listening ??= new Promise((resolve, reject) => {
            const server = createServer(socket => this.accept(socket));
            server.on('error', reject);
            server.listen(0, '127.0.0.1', () => { this.server = server; resolve(server.address().port); });
        });
        return this.listening;
    }
    accept(socket) {
        if (this.closed) {
            socket.destroy();
            return;
        }
        let buffer = '', connection;
        const write = (value) => { if (!socket.destroyed)
            socket.write(`${JSON.stringify(value)}\n`); };
        socket.setEncoding('utf8');
        const timer = setTimeout(() => socket.destroy(), 10_000);
        socket.on('data', chunk => {
            buffer += chunk;
            if (buffer.length > 8 * 1024 * 1024) {
                socket.destroy();
                return;
            }
            for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
                const line = buffer.slice(0, index);
                buffer = buffer.slice(index + 1);
                let message;
                try {
                    message = JSON.parse(line);
                }
                catch {
                    continue;
                }
                if (!connection) {
                    clearTimeout(timer);
                    void this.hello(message).then(hello => {
                        if (!hello) {
                            write({ hello: 'refused', error: 'DSH did not recognize this remote CLI' });
                            socket.end();
                            return;
                        }
                        connection = { socket, ...hello, calls: new Map() };
                        this.connections.add(connection);
                        write({ hello: 'ok' });
                    }, () => socket.destroy());
                    continue;
                }
                const current = connection;
                if (message.op === 'cancel') {
                    current.calls.get(message.id)?.abort();
                    continue;
                }
                if (typeof message.id !== 'number')
                    continue;
                void this.handle(current, message).then(result => write({ id: message.id, result }), error => write({ id: message.id, error: error instanceof Error ? error.message : String(error) }));
            }
        });
        socket.on('error', () => { });
        socket.on('close', () => {
            clearTimeout(timer);
            if (connection) {
                for (const call of connection.calls.values())
                    call.abort();
                this.connections.delete(connection);
            }
        });
    }
    async hello(message) {
        if (message.op !== 'hello' || typeof message.task !== 'string' || typeof message.token !== 'string' || typeof message.server !== 'string' || !SERVER.test(message.server))
            return;
        const expected = Buffer.from(await this.token(message.task), 'hex'), given = Buffer.from(/^[a-f0-9]{64}$/.test(message.token) ? message.token : '', 'hex');
        if (given.length !== expected.length || !timingSafeEqual(given, expected))
            return;
        return this.store.task(t => t.id === message.task) ? { server: message.server, task: message.task } : undefined;
    }
    async handle(connection, message) {
        const { server } = connection, tools = this.mcpServers().get(server), prefix = `mcp__${server}__`;
        if (message.op === 'list') {
            if (!this.mcpShared(server))
                return { tools: [] };
            this.listed.set(server, toolSet(tools));
            // Still connecting, or no longer configured: the proxy keeps the tools it saw last and lists again on `changed`.
            if (!tools)
                throw new Error(`DSH has not loaded the "${server}" MCP server`);
            return { tools: tools.map(tool => ({ name: tool.name.slice(prefix.length), description: tool.description,
                    inputSchema: tool.parameters && typeof tool.parameters === 'object' ? tool.parameters : { type: 'object', properties: {} } })) };
        }
        if (message.op !== 'call')
            throw new Error('Unknown bridge request');
        const failure = (text) => ({ content: [{ type: 'text', text }], isError: true });
        if (!this.mcpShared(server))
            return failure(`The "${server}" MCP server is no longer shared from DSH.`);
        const tool = tools?.find(t => t.name === prefix + String(message.name));
        if (!tool || !this.host.tools)
            return failure(`DSH has no tool named "${String(message.name)}" on the "${server}" MCP server.`);
        const task = this.store.task(t => t.id === connection.task), owner = task && this.owner(task), agent = owner ? this.host.agent?.(owner) : undefined;
        if (!agent)
            return failure('DSH runs shared tools with the conversation that started this CLI. Open that conversation in DSH, then retry.');
        const controller = new AbortController();
        connection.calls.set(message.id, controller);
        try {
            const input = message.arguments && typeof message.arguments === 'object' && !Array.isArray(message.arguments) ? message.arguments : {};
            const result = await this.host.tools.execute({ callId: `remote-mcp-${randomBytes(8).toString('hex')}`, name: tool.name, arguments: input, agent, signal: controller.signal });
            return { content: await mcpContent(result, this.host.attachments, controller.signal), ...(result.isError ? { isError: true } : {}) };
        }
        finally {
            connection.calls.delete(message.id);
        }
    }
    bridge(host, transport) {
        let bridge = this.bridges.get(host.id);
        if (!bridge || bridge.host.connection !== host.connection) {
            if (bridge)
                this.stop(bridge);
            bridge = new HostBridge(host, transport);
            this.bridges.set(host.id, bridge);
        }
        bridge.transport = transport;
        return bridge;
    }
    /**
     * Install the bridge script once per version; report the remote home, the absolute Node.js path ACP needs and the
     * synced skills. Checked again after a while, so a deleted ~/.dsh-remote-agents is installed again. Each DSH instance
     * copies its skills to its own directory: another one sharing the remote account may share different skills.
     * A forward that is up is checked too: deleting ~/.dsh-remote-agents takes its socket and pointer with it.
     */
    install(bridge) {
        if (bridge.info && Date.now() - bridge.checked < INSTALL_TTL)
            return bridge.info;
        const live = bridge.forward?.up ? bridge.forward : undefined;
        const check = live ? `[ -S ${quote(live.socket)} ] && [ "$(cat ${quote(live.pointer ?? '')} 2>/dev/null)" = ${quote(live.socket)} ] && dsh_forward=up || dsh_forward=gone` : 'dsh_forward=';
        const info = this.instance().then(instance => bridge.transport.exec(`umask 077
mkdir -p "$HOME/${BASE}/bridge/tasks" "$HOME/${BASE}/bridge/cache" "$HOME/${BASE}/shared-${instance}"
chmod 700 "$HOME/${BASE}" "$HOME/${BASE}/bridge" "$HOME/${BASE}/bridge/tasks" "$HOME/${BASE}/bridge/cache" "$HOME/${BASE}/shared-${instance}"
if [ ! -f "$HOME/${BASE}/bridge/bridge-${BRIDGE_VERSION}.mjs" ]; then
  dsh_bridge_tmp="$(mktemp "$HOME/${BASE}/bridge/.bridge.XXXXXXXXXX")"
  cat > "$dsh_bridge_tmp" <<'DSH_BRIDGE_SCRIPT_END'
${BRIDGE_SCRIPT}
DSH_BRIDGE_SCRIPT_END
  mv -f "$dsh_bridge_tmp" "$HOME/${BASE}/bridge/bridge-${BRIDGE_VERSION}.mjs"
fi
${check}
printf '%s\\0%s\\0%s\\0' "$HOME" "$(command -v node)" "$dsh_forward"
node "$HOME/${BASE}/bridge/bridge-${BRIDGE_VERSION}.mjs" manifest "$HOME/${BASE}/shared-${instance}" 2>/dev/null || true`).then(output => {
            const [home, node, forward, synced] = output.split('\0');
            if (!home?.startsWith('/') || !node?.startsWith('/'))
                throw new Error('The SSH host did not report its home directory and Node.js');
            bridge.remote = remoteSkills(synced);
            if (forward === 'gone' && live && bridge.forward === live)
                this.replace(bridge, live);
            return { home, node, shared: `${home}/${BASE}/shared-${instance}` };
        }));
        bridge.info = info;
        bridge.checked = Date.now();
        info.catch(() => { if (bridge.info === info)
            bridge.info = undefined; });
        return info;
    }
    /** A skill bundle's content hash; recomputed only when its files' metadata changed. */
    async hashOf(name, files) {
        const key = JSON.stringify(files.map(f => [f.path, f.source, f.size, f.mtime, !!f.executable]));
        const generated = files.some(f => f.data), cached = this.hashes.get(name);
        if (!generated && cached?.key === key)
            return cached.hash;
        const hash = createHash('sha256');
        for (const file of files)
            hash.update(file.path).update('\0').update(await contents(file)).update(file.executable ? '\u0001' : '\0');
        const digest = hash.digest('hex');
        if (!generated)
            this.hashes.set(name, { key, hash: digest });
        return digest;
    }
    /** Copy the shared skills; unchanged skills are not sent again. */
    async syncSkills(bridge, info, signal) {
        const packages = [];
        let total = 0;
        for (const summary of await this.skillList(signal)) {
            if (!this.skillShared(summary.name))
                continue;
            try {
                let files;
                if (summary.path && basename(summary.path) === 'SKILL.md')
                    files = await bundleFiles(dirname(summary.path));
                else if (summary.path?.endsWith('.md'))
                    files = [await sourceFile(summary.path)];
                else {
                    const definition = await this.host.skills.get(summary.name, { signal });
                    if (!definition)
                        continue;
                    const data = Buffer.from(`---\nname: ${summary.name}\ndescription: ${JSON.stringify(summary.description)}\n---\n\n${definition.content}`);
                    files = [{ path: 'SKILL.md', size: data.length, data }];
                }
                const size = files.reduce((sum, file) => sum + file.size, 0);
                if (total + size > TOTAL_LIMIT) {
                    this.log(`Skipped skill ${summary.name}: the shared skills exceed ${TOTAL_LIMIT / 1024 / 1024} MB`);
                    continue;
                }
                const hash = await this.hashOf(summary.name, files);
                total += size;
                packages.push({ name: summary.name, description: summary.description, ...(summary.whenToUse ? { whenToUse: summary.whenToUse } : {}), hash, files });
            }
            catch (error) {
                this.log(`Skipped skill ${summary.name}: ${String(error)}`);
            }
        }
        for (const name of this.hashes.keys())
            if (!packages.some(p => p.name === name))
                this.hashes.delete(name);
        const manifest = Object.fromEntries(packages.map(p => [p.name, p.hash]));
        const catalog = packages.map(({ name, description, whenToUse }) => ({ name, description, ...(whenToUse ? { whenToUse } : {}) }));
        const fingerprint = createHash('sha256').update(JSON.stringify([manifest, catalog])).digest('hex');
        const run = bridge.syncing.then(async () => {
            let remote = bridge.remote ?? { skills: {} };
            if (remote.fingerprint === fingerprint)
                return;
            const transfer = bridge.transport.transfer?.bind(bridge.transport);
            if (!transfer)
                throw new Error('This connection cannot copy skills');
            const command = `node ${quote(`${info.home}/${BASE}/bridge/bridge-${BRIDGE_VERSION}.mjs`)} sync ${quote(info.shared)}`;
            // A skill the host lost since it was last checked is reported missing and sent once more.
            for (let attempt = 0;; attempt++) {
                const sent = remote.skills;
                const files = Object.fromEntries(await Promise.all(packages.filter(p => sent[p.name] !== p.hash).map(async (p) => [p.name,
                    await Promise.all(p.files.map(async (f) => ({ path: f.path, data: (await contents(f)).toString('base64'), ...(f.executable ? { executable: true } : {}) })))])));
                const payload = Buffer.from(JSON.stringify({ manifest, catalog, fingerprint, files }));
                const output = (await transfer(command, { input: (async function* () { yield payload; })(), maxBytes: 64 * 1024, signal })).toString('utf8');
                let reply = {};
                try {
                    reply = JSON.parse(output.trim().split('\n').at(-1) || '{}');
                }
                catch { }
                if (reply.ok !== true)
                    throw new Error('The SSH host did not confirm the skill copy');
                const missing = new Set(Array.isArray(reply.missing) ? reply.missing : []);
                remote = bridge.remote = missing.size ? { skills: Object.fromEntries(Object.entries(manifest).filter(([name]) => !missing.has(name))) } : { skills: manifest, fingerprint };
                if (!missing.size)
                    return;
                if (attempt)
                    throw new Error(`The SSH host did not keep the skills ${[...missing].join(', ')}`);
            }
        });
        // After a failed copy the host is checked again: its files may be gone.
        bridge.syncing = run.catch(() => { bridge.info = undefined; });
        await run;
        return packages.map(p => p.name);
    }
    /** One reverse-forwarded socket per host; a fresh name each time, since sshd may not unlink a stale one. */
    ensureForward(bridge, info) {
        if (bridge.forward)
            return bridge.forward.ready;
        if (this.closed || bridge.stopped)
            return Promise.reject(new Error('Sharing has stopped'));
        clearTimeout(bridge.retry);
        bridge.retry = undefined;
        const directory = `${info.home}/${BASE}/bridge`, socket = `${directory}/s-${randomBytes(4).toString('hex')}.sock`, started = Date.now();
        const forward = { stopped: false, socket, ready: Promise.resolve() };
        forward.ready = Promise.all([this.listen(), this.instance()]).then(([port, instance]) => new Promise((resolve, reject) => {
            // Stopped while DSH's port was opening.
            if (forward.stopped)
                throw new Error('Sharing has stopped');
            const child = forward.child = this.launch(bridgeForwardArguments(bridge.host.connection, socket, port));
            let stderr = '', state = 'starting';
            const fail = (error) => { if (state === 'up' || state === 'failed')
                return; state = 'failed'; clearTimeout(timer); reject(error); child.kill(); };
            const timer = setTimeout(() => fail(new Error('The reverse forward did not start')), 20_000);
            child.stderr?.setEncoding('utf8');
            child.stderr?.on('data', (chunk) => {
                stderr = (stderr + chunk).slice(-4000);
                // Only the server's reply confirms the socket is bound; OpenSSH logs it at debug level, hence `-v`.
                if (state !== 'starting' || !/remote forward success/i.test(stderr))
                    return;
                state = 'confirmed';
                clearTimeout(timer);
                // Point this DSH's proxies, new and running, at the socket. Proxies started by an earlier version read the
                // shared `current`; it exists only where one ran, and is updated as that version did.
                const pointer = forward.pointer = `${directory}/current-${instance}`, legacy = `${directory}/current`;
                void bridge.transport.exec(`printf '%s' ${quote(socket)} > ${quote(`${pointer}.tmp`)} && mv -f ${quote(`${pointer}.tmp`)} ${quote(pointer)} || exit 1
if [ -e ${quote(legacy)} ]; then printf '%s' ${quote(socket)} > ${quote(`${legacy}.tmp`)} && mv -f ${quote(`${legacy}.tmp`)} ${quote(legacy)} || exit 1; fi
find ${quote(directory)} -maxdepth 1 -name 's-*.sock' -mtime +7 -exec rm -f {} + 2>/dev/null || true`, 20_000, { login: false })
                    .then(() => { if (state !== 'confirmed')
                    return; state = 'up'; forward.up = true; bridge.error = undefined; resolve(); }, fail);
            });
            child.on('error', fail);
            child.on('close', code => {
                const lines = stderr.split('\n').filter(line => line && !line.startsWith('debug1:'));
                const error = new Error(lines.at(-1) ?? `The reverse forward ended (${code})`);
                if (state === 'up')
                    this.ended(bridge, forward, error, started);
                else
                    fail(error);
            });
        }));
        forward.ready.catch(error => this.ended(bridge, forward, error, started));
        bridge.forward = forward;
        return forward.ready;
    }
    /** A forward did not start or dropped. Keep one while DSH runs: a reattached CLI may call a shared tool at any time. */
    ended(bridge, forward, error, started) {
        if (bridge.forward !== forward)
            return;
        bridge.forward = undefined;
        bridge.error = error instanceof Error ? error.message : String(error);
        this.schedule(bridge, Date.now() - started);
    }
    schedule(bridge, lasted = 0) {
        if (this.closed || bridge.stopped || bridge.forward || bridge.retry)
            return;
        bridge.delay = lasted > 60_000 ? 2000 : Math.min(bridge.delay * 2, 60_000);
        bridge.retry = setTimeout(() => { bridge.retry = undefined; this.keep(bridge); }, bridge.delay);
    }
    /** The host lost a live forward's socket or pointer: end it and bring up another. */
    replace(bridge, forward) {
        bridge.forward = undefined;
        bridge.error = 'The shared socket was removed from the SSH host';
        forward.stopped = true;
        forward.child?.kill();
        this.keep(bridge);
    }
    /** Bring a host's forward up, retrying with backoff until it is. */
    keep(bridge) {
        if (this.closed || bridge.stopped || bridge.forward)
            return;
        void this.install(bridge).then(info => this.ensureForward(bridge, info)).catch(error => {
            // A failed forward has scheduled its retry; a failed install schedules one here.
            bridge.error = error instanceof Error ? error.message : String(error);
            this.schedule(bridge);
        });
    }
    /** Replaced or removed: end the forward and never start another. */
    stop(bridge) {
        bridge.stopped = true;
        clearTimeout(bridge.retry);
        bridge.retry = undefined;
        const forward = bridge.forward;
        bridge.forward = undefined;
        if (forward) {
            forward.stopped = true;
            forward.child?.kill();
        }
    }
    async prepare(host, transport, task, protocol, signal) {
        const servers = [], launch = { servers };
        if (protocol === 'antigravity' || this.closed)
            return launch;
        const owner = this.owner(task);
        const proxies = owner && this.host.agent ? [...this.mcpServers().keys()].filter(name => this.mcpShared(name)) : [];
        const wantsSkills = !!this.host.skills;
        if (!proxies.length && !wantsSkills)
            return launch;
        const bridge = this.bridge(host, transport);
        let info;
        try {
            info = await this.install(bridge);
        }
        catch (error) {
            signal?.throwIfAborted();
            this.log(`Sharing with ${host.label} is unavailable: ${String(error)}`);
            return launch;
        }
        const script = `${info.home}/${BASE}/bridge/bridge-${BRIDGE_VERSION}.mjs`, shared = info.shared;
        if (wantsSkills) {
            try {
                const names = await this.syncSkills(bridge, info, signal);
                if (names.length) {
                    if (protocol === 'claude')
                        launch.pluginDir = shared;
                    else
                        servers.push({ name: 'dsh', command: info.node, args: [script, 'skills', shared] });
                }
            }
            catch (error) {
                signal?.throwIfAborted();
                this.log(`Copying skills to ${host.label} failed: ${String(error)}`);
            }
        }
        if (proxies.length) {
            try {
                if (!transport.transfer)
                    throw new Error('This connection cannot pass the bridge token privately');
                const directory = `${info.home}/${BASE}/bridge`, instance = await this.instance(), file = `${directory}/tasks/${task.id}.json`, cache = `${directory}/cache/${instance}`;
                const content = Buffer.from(JSON.stringify({ task: task.id, token: await this.token(task.id), pointer: `${directory}/current-${instance}`, cache }));
                // Through stdin: a command line is visible to other users of either machine.
                await transport.transfer(`umask 077; mkdir -p ${quote(`${directory}/tasks`)} ${quote(cache)} && cat > ${quote(`${file}.tmp`)} && mv -f ${quote(`${file}.tmp`)} ${quote(file)}`, { input: (async function* () { yield content; })(), maxBytes: 4096, signal, login: false });
                // Wait a little for the forward, so the CLI's first tool listing reaches DSH; a slow host does not hold up the launch.
                const forward = this.ensureForward(bridge, info).catch(error => this.log(`Sharing DSH MCP servers with ${host.label} failed: ${String(error)}`));
                const timeout = delay(FORWARD_WAIT, undefined, { signal, ref: false });
                timeout.catch(() => { });
                await Promise.race([forward, timeout]);
                for (const name of proxies)
                    servers.push({ name: `dsh-${name}`, command: info.node, args: [script, 'proxy', file, name] });
            }
            catch (error) {
                signal?.throwIfAborted();
                this.log(`Sharing DSH MCP servers with ${host.label} failed: ${String(error)}`);
            }
        }
        return launch;
    }
    attached(host, transport, task) {
        try {
            // The settings decide, not DSH's tools: its MCP servers may still be connecting while CLIs are reattached.
            if (this.closed || !this.owner(task) || !Object.values(this.settings().mcp ?? {}).some(Boolean))
                return;
            this.keep(this.bridge(host, transport));
        }
        catch (error) {
            this.log(`Sharing DSH MCP servers with ${host.label} failed: ${String(error)}`);
        }
    }
    forget(hostId) {
        const bridge = this.bridges.get(hostId);
        if (bridge) {
            this.bridges.delete(hostId);
            this.stop(bridge);
        }
    }
    /** Per-host forward problems, for the settings page. */
    status() { return Object.fromEntries([...this.bridges].filter(([, b]) => b.error).map(([id, b]) => [id, b.error])); }
    async close() {
        this.closed = true;
        clearTimeout(this.toolsTimer);
        for (const bridge of this.bridges.values())
            this.stop(bridge);
        for (const connection of this.connections) {
            for (const call of connection.calls.values())
                call.abort();
            connection.socket.destroy();
        }
        // A listen still under way finishes first, so its server is closed too.
        await this.listening?.catch(() => { });
        const server = this.server;
        this.server = undefined;
        await new Promise(resolve => server ? server.close(() => resolve()) : resolve());
    }
}
