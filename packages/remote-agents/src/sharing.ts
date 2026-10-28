import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { basename, dirname, join, relative, sep } from 'node:path';
import { BRIDGE_SCRIPT, BRIDGE_VERSION } from './bridge-script.js';
import { RemoteError, type HostConfig, type NativeProtocol, type Task } from './domain.js';
import { connectionInput, quote, type SshTransport } from './ssh.js';
import type { Store } from './store.js';

/** One stdio MCP server a remote CLI starts: the bridge script in proxy or skills mode. */
export interface SharedServer { name: string; command: string; args: string[] }
/** What one CLI launch receives. Claude loads `pluginDir` natively; other CLIs get skills as the `dsh` server. */
export interface SharedLaunch { pluginDir?: string; servers: SharedServer[] }
export interface LaunchSharing {
  /** Prepare the host for one CLI launch. Never fails the launch: what cannot be shared is left out. */
  prepare(host: HostConfig, transport: SshTransport, task: Task, protocol: NativeProtocol, signal?: AbortSignal): Promise<SharedLaunch>;
  /** A CLI kept running while DSH was away was reattached: its proxies need the reverse forward again. */
  attached(host: HostConfig, transport: SshTransport, task: Task): void;
}

/** The parts of DSH's tool registry and skill registry the bridge uses. */
export interface SharedTool { name: string; description: string; parameters?: unknown }
export interface ToolBatch { results: readonly { result: { isError: boolean; value?: unknown; content: readonly { type: string; text?: string }[] } }[] }
export interface SharingTools {
  definitions(): readonly SharedTool[];
  execute(input: { calls: { type: 'tool-call'; id: string; name: string; arguments: string }[]; signal: AbortSignal; agent?: unknown }): Promise<ToolBatch>;
}
export interface SkillSummary { name: string; description: string; whenToUse?: string; path?: string; source: string; invocation: { modelInvocable: boolean } }
export interface SharingSkills {
  list(options?: { signal?: AbortSignal }): Promise<readonly SkillSummary[]>;
  get(name: string, options?: { signal?: AbortSignal }): Promise<{ content: string } | undefined>;
}
export interface SharingHost { tools?: SharingTools; skills?: SharingSkills; agent?(sessionId: string): unknown }

export interface SharingCatalog {
  /** Whether DSH's tool and skill registries are loaded; without them nothing can be shared. */
  available: { mcp: boolean; skills: boolean };
  mcp: { name: string; tools: number; shared: boolean }[];
  skills: { name: string; description: string; source: string; shared: boolean }[];
}

const BASE = '.dsh-remote-agents', SERVER = /^[A-Za-z0-9_-]{1,32}$/, SKILL = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SKIP = new Set(['.git', 'node_modules', '__pycache__', '.DS_Store', '.venv']);
const FILE_LIMIT = 4 * 1024 * 1024, SKILL_LIMIT = 16 * 1024 * 1024, TOTAL_LIMIT = 48 * 1024 * 1024, FILE_COUNT = 500;
/** Project skills come from the local anchor directory, not the remote project; the remote CLI finds the project's own. */
const shareableSource = (source: string) => !source.startsWith('project-');

/** `mcp__<server>__<tool>`: DSH's MCP client names every tool after its configured server. */
export function mcpServerOf(name: string): string | undefined {
  const match = /^mcp__([A-Za-z0-9_-]+?)__./.exec(name);
  return match && SERVER.test(match[1]) ? match[1] : undefined;
}

/**
 * Add the shared servers and skills to a CLI's own launch. Proxies are approved in the CLI, so DSH's permission
 * rules and approval prompts are the only gate: they run with the conversation's DSH agent.
 */
export function sharedArguments(protocol: NativeProtocol, launch: string[], shared: SharedLaunch | undefined): string[] {
  if (!shared) return launch;
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
export const acpServers = (shared: SharedLaunch | undefined) => (shared?.servers ?? []).map(s => ({ name: s.name, command: s.command, args: s.args, env: [] as { name: string; value: string }[] }));

export function bridgeForwardArguments(connection: string, remoteSocket: string, port: number): string[] {
  const url = new URL(connectionInput(connection));
  const target = `${decodeURIComponent(url.username) ? `${decodeURIComponent(url.username)}@` : ''}${url.hostname}`;
  return ['-v', '-N', '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', ...(url.port ? ['-p', url.port] : []), '-R', `${remoteSocket}:127.0.0.1:${port}`, '--', target];
}

interface SkillPackage { name: string; description: string; whenToUse?: string; hash: string; files: { path: string; data: Buffer; executable?: boolean }[] }

/** A directory bundle's files, or just its instruction file when the bundle is too large to copy. */
async function bundleFiles(directory: string): Promise<SkillPackage['files']> {
  const files: SkillPackage['files'] = []; let total = 0;
  const walk = async (folder: string, depth: number): Promise<boolean> => {
    for (const entry of (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIP.has(entry.name)) continue;
      const path = join(folder, entry.name), info = await stat(path).catch(() => undefined);
      if (!info) continue;
      if (info.isDirectory()) { if (depth < 6 && !await walk(path, depth + 1)) return false; continue; }
      if (!info.isFile()) continue;
      if (info.size > FILE_LIMIT || (total += info.size) > SKILL_LIMIT || files.length >= FILE_COUNT) return false;
      files.push({ path: relative(directory, path).split(sep).join('/'), data: await readFile(path), ...(info.mode & 0o100 ? { executable: true } : {}) });
    }
    return true;
  };
  if (await walk(directory, 0)) return files;
  return [{ path: 'SKILL.md', data: await readFile(join(directory, 'SKILL.md')) }];
}

class HostBridge {
  info?: Promise<{ home: string; node: string }>;
  manifest?: string;
  syncing = Promise.resolve();
  forward?: { child: ChildProcess; ready: Promise<void> };
  retry?: ReturnType<typeof setTimeout>;
  delay = 2000;
  error?: string;
  constructor(public host: HostConfig, public transport: SshTransport) {}
}

/**
 * Shares DSH's MCP servers (through DSH, off by default) and skills (copied to the host, on by default) with
 * remote CLIs. MCP calls reach DSH over one reverse-forwarded Unix socket per host and run with the DSH agent of
 * the conversation that owns the CLI, so DSH's permissions, approvals and hooks apply and credentials stay in DSH.
 */
export class Sharing implements LaunchSharing {
  readonly host: SharingHost = {};
  private server?: Server;
  private listening?: Promise<number>;
  private readonly bridges = new Map<string, HostBridge>();
  private readonly connections = new Set<{ socket: Socket; server: string; task: string; calls: Map<number, AbortController> }>();
  private closed = false;
  constructor(private readonly store: Store, private readonly launch: (args: string[]) => ChildProcess = args => spawn('ssh', args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }),
    private readonly log: (message: string) => void = message => console.warn(`[remote-agents] ${message}`)) {}

  private settings() { return this.store.snapshot().sharing ?? {}; }
  /** MCP is shared only when switched on; skills unless switched off. */
  mcpShared(server: string): boolean { return this.settings().mcp?.[server] === true; }
  skillShared(name: string): boolean { return this.settings().skills?.[name] !== false; }
  private mcpServers(): Map<string, SharedTool[]> {
    const servers = new Map<string, SharedTool[]>();
    for (const tool of this.host.tools?.definitions() ?? []) {
      const server = mcpServerOf(tool.name);
      if (server) servers.set(server, [...servers.get(server) ?? [], tool]);
    }
    return servers;
  }
  private async skillList(signal?: AbortSignal): Promise<SkillSummary[]> {
    return [...await this.host.skills?.list({ signal }) ?? []].filter(s => s.invocation.modelInvocable && shareableSource(s.source) && SKILL.test(s.name));
  }
  async catalog(signal?: AbortSignal): Promise<SharingCatalog> {
    const skills = await this.skillList(signal).catch(error => { this.log(`Reading DSH skills failed: ${String(error)}`); return []; });
    return {
      available: { mcp: !!this.host.tools, skills: !!this.host.skills },
      mcp: [...this.mcpServers()].map(([name, tools]) => ({ name, tools: tools.length, shared: this.mcpShared(name) })).sort((a, b) => a.name.localeCompare(b.name)),
      skills: skills.map(s => ({ name: s.name, description: s.description, source: s.source, shared: this.skillShared(s.name) })),
    };
  }
  async set(kind: unknown, name: unknown, shared: unknown): Promise<void> {
    if (kind !== 'mcp' && kind !== 'skill') throw new RemoteError('Invalid share type');
    if (typeof name !== 'string' || !(kind === 'mcp' ? SERVER : SKILL).test(name) || typeof shared !== 'boolean') throw new RemoteError('Invalid share');
    await this.store.update(state => {
      const sharing = state.sharing ??= {}, table = kind === 'mcp' ? sharing.mcp ??= {} : sharing.skills ??= {};
      // Defaults are not stored, so a later change of default would apply to untouched entries.
      if (shared === (kind === 'skill')) delete table[name]; else table[name] = shared;
    });
    if (kind === 'mcp') this.changed(name);
  }
  /** Ask the CLIs using a server to list its tools again. */
  changed(server?: string): void {
    for (const connection of this.connections) if (!server || connection.server === server) connection.socket.write(`${JSON.stringify({ event: 'changed' })}\n`);
  }

  private async secret(): Promise<Buffer> {
    let value = this.settings().secret;
    if (!value) {
      const created = randomBytes(32).toString('hex');
      await this.store.update(state => { (state.sharing ??= {}).secret ??= created; });
      value = this.settings().secret!;
    }
    return Buffer.from(value, 'hex');
  }
  private async token(taskId: string): Promise<string> { return createHmac('sha256', await this.secret()).update(taskId).digest('hex'); }
  /** The conversation whose DSH agent runs the CLI's MCP calls: the main chat, or the agent that delegated it. */
  private owner(task: Task): string | undefined { return task.chat?.sessionId ?? task.owner?.sessionId; }

  private listen(): Promise<number> {
    this.listening ??= new Promise<number>((resolve, reject) => {
      const server = createServer(socket => this.accept(socket));
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => { this.server = server; resolve((server.address() as AddressInfo).port); });
    });
    return this.listening;
  }
  private accept(socket: Socket): void {
    let buffer = '', connection: { socket: Socket; server: string; task: string; calls: Map<number, AbortController> } | undefined;
    const write = (value: unknown) => { if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`); };
    socket.setEncoding('utf8');
    const timer = setTimeout(() => socket.destroy(), 10_000);
    socket.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 8 * 1024 * 1024) { socket.destroy(); return; }
      for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        let message: Record<string, any>;
        try { message = JSON.parse(line); } catch { continue; }
        if (!connection) {
          clearTimeout(timer);
          void this.hello(message).then(hello => {
            if (!hello) { write({ hello: 'refused', error: 'DSH did not recognize this remote CLI' }); socket.end(); return; }
            connection = { socket, ...hello, calls: new Map() }; this.connections.add(connection); write({ hello: 'ok' });
          }, () => socket.destroy());
          continue;
        }
        const current = connection;
        if (message.op === 'cancel') { current.calls.get(message.id)?.abort(); continue; }
        if (typeof message.id !== 'number') continue;
        void this.handle(current, message).then(result => write({ id: message.id, result }), error => write({ id: message.id, error: error instanceof Error ? error.message : String(error) }));
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      clearTimeout(timer);
      if (connection) { for (const call of connection.calls.values()) call.abort(); this.connections.delete(connection); }
    });
  }
  private async hello(message: Record<string, any>): Promise<{ server: string; task: string } | undefined> {
    if (message.op !== 'hello' || typeof message.task !== 'string' || typeof message.token !== 'string' || typeof message.server !== 'string' || !SERVER.test(message.server)) return;
    const expected = Buffer.from(await this.token(message.task), 'hex'), given = Buffer.from(/^[a-f0-9]{64}$/.test(message.token) ? message.token : '', 'hex');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return;
    return this.store.task(t => t.id === message.task) ? { server: message.server, task: message.task } : undefined;
  }
  private async handle(connection: { server: string; task: string; calls: Map<number, AbortController> }, message: Record<string, any>): Promise<unknown> {
    const { server } = connection, tools = this.mcpServers().get(server) ?? [], prefix = `mcp__${server}__`;
    if (message.op === 'list') {
      if (!this.mcpShared(server)) return { tools: [] };
      return { tools: tools.map(tool => ({ name: tool.name.slice(prefix.length), description: tool.description,
        inputSchema: tool.parameters && typeof tool.parameters === 'object' ? tool.parameters : { type: 'object', properties: {} } })) };
    }
    if (message.op !== 'call') throw new Error('Unknown bridge request');
    const failure = (text: string) => ({ content: [{ type: 'text', text }], isError: true });
    if (!this.mcpShared(server)) return failure(`The "${server}" MCP server is no longer shared from DSH.`);
    const tool = tools.find(t => t.name === prefix + String(message.name));
    if (!tool || !this.host.tools) return failure(`DSH has no tool named "${String(message.name)}" on the "${server}" MCP server.`);
    const task = this.store.task(t => t.id === connection.task), owner = task && this.owner(task), agent = owner ? this.host.agent?.(owner) : undefined;
    if (!agent) return failure('DSH runs shared tools with the conversation that started this CLI. Open that conversation in DSH, then retry.');
    const controller = new AbortController(); connection.calls.set(message.id, controller);
    try {
      const batch = await this.host.tools.execute({ calls: [{ type: 'tool-call', id: `remote-mcp-${randomBytes(8).toString('hex')}`, name: tool.name, arguments: JSON.stringify(message.arguments ?? {}) }], signal: controller.signal, agent });
      const result = batch.results[0]?.result;
      if (!result) return failure('DSH did not run this tool.');
      // DSH's MCP client keeps the server's own result as the canonical value, images included.
      const value = result.value as { content?: unknown } | undefined;
      if (!result.isError && value && typeof value === 'object' && Array.isArray(value.content)) return value;
      return { content: result.content.map(block => ({ type: 'text', text: block.type === 'text' ? block.text ?? '' : `[${block.type} omitted]` })), ...(result.isError ? { isError: true } : {}) };
    } finally { connection.calls.delete(message.id); }
  }

  private bridge(host: HostConfig, transport: SshTransport): HostBridge {
    let bridge = this.bridges.get(host.id);
    if (!bridge || bridge.host.connection !== host.connection) { if (bridge) this.stopForward(bridge); bridge = new HostBridge(host, transport); this.bridges.set(host.id, bridge); }
    bridge.transport = transport;
    return bridge;
  }
  /** Install the bridge script once per version; report the remote home and the absolute Node.js path ACP needs. */
  private install(bridge: HostBridge): Promise<{ home: string; node: string }> {
    bridge.info ??= bridge.transport.exec(`umask 077
mkdir -p "$HOME/${BASE}/bridge/tasks" "$HOME/${BASE}/bridge/cache" "$HOME/${BASE}/shared"
chmod 700 "$HOME/${BASE}" "$HOME/${BASE}/bridge" "$HOME/${BASE}/bridge/tasks" "$HOME/${BASE}/bridge/cache" "$HOME/${BASE}/shared"
if [ ! -f "$HOME/${BASE}/bridge/bridge-${BRIDGE_VERSION}.mjs" ]; then
  dsh_bridge_tmp="$(mktemp "$HOME/${BASE}/bridge/.bridge.XXXXXXXXXX")"
  cat > "$dsh_bridge_tmp" <<'DSH_BRIDGE_SCRIPT_END'
${BRIDGE_SCRIPT}
DSH_BRIDGE_SCRIPT_END
  mv -f "$dsh_bridge_tmp" "$HOME/${BASE}/bridge/bridge-${BRIDGE_VERSION}.mjs"
fi
printf '%s\\0%s\\0' "$HOME" "$(command -v node)"`).then(output => {
      const [home, node] = output.split('\0');
      if (!home?.startsWith('/') || !node?.startsWith('/')) throw new Error('The SSH host did not report its home directory and Node.js');
      return { home, node };
    });
    bridge.info.catch(() => { bridge.info = undefined; });
    return bridge.info;
  }

  /** Copy the shared skills; unchanged skills are not sent again. */
  private async syncSkills(bridge: HostBridge, info: { home: string; node: string }, signal?: AbortSignal): Promise<string[]> {
    const packages: SkillPackage[] = [];
    let total = 0;
    for (const summary of await this.skillList(signal)) {
      if (!this.skillShared(summary.name)) continue;
      try {
        let files: SkillPackage['files'];
        if (summary.path && basename(summary.path) === 'SKILL.md') files = await bundleFiles(dirname(summary.path));
        else if (summary.path?.endsWith('.md')) files = [{ path: 'SKILL.md', data: await readFile(summary.path) }];
        else {
          const definition = await this.host.skills!.get(summary.name, { signal });
          if (!definition) continue;
          files = [{ path: 'SKILL.md', data: Buffer.from(`---\nname: ${summary.name}\ndescription: ${JSON.stringify(summary.description)}\n---\n\n${definition.content}`) }];
        }
        const size = files.reduce((sum, file) => sum + file.data.length, 0);
        if ((total += size) > TOTAL_LIMIT) { this.log(`Skipped skill ${summary.name}: the shared skills exceed ${TOTAL_LIMIT / 1024 / 1024} MB`); continue; }
        const hash = createHash('sha256');
        for (const file of files) hash.update(file.path).update('\0').update(file.data).update(file.executable ? '\u0001' : '\0');
        packages.push({ name: summary.name, description: summary.description, ...(summary.whenToUse ? { whenToUse: summary.whenToUse } : {}), hash: hash.digest('hex'), files });
      } catch (error) { this.log(`Skipped skill ${summary.name}: ${String(error)}`); }
    }
    const manifest = Object.fromEntries(packages.map(p => [p.name, p.hash]));
    const catalog = packages.map(({ name, description, whenToUse }) => ({ name, description, ...(whenToUse ? { whenToUse } : {}) }));
    const fingerprint = JSON.stringify([manifest, catalog]);
    const run = bridge.syncing.then(async () => {
      if (bridge.manifest === fingerprint) return;
      if (!bridge.transport.transfer) throw new Error('This connection cannot copy skills');
      const script = `node "$HOME/${BASE}/bridge/bridge-${BRIDGE_VERSION}.mjs"`, shared = `"$HOME/${BASE}/shared"`;
      const remote = JSON.parse((await bridge.transport.exec(`${script} manifest ${shared}`)).trim().split('\n').at(-1) || '{}') as Record<string, string>;
      const files = Object.fromEntries(packages.filter(p => remote[p.name] !== p.hash).map(p => [p.name, p.files.map(f => ({ path: f.path, data: f.data.toString('base64'), ...(f.executable ? { executable: true } : {}) }))]));
      const payload = Buffer.from(JSON.stringify({ manifest, catalog, files }));
      const output = (await bridge.transport.transfer(`${script} sync ${shared}`, { input: (async function* () { yield payload; })(), maxBytes: 64 * 1024, signal })).toString('utf8');
      if (!output.includes('"ok":true')) throw new Error('The SSH host did not confirm the skill copy');
      bridge.manifest = fingerprint;
    });
    bridge.syncing = run.catch(() => {});
    await run;
    return packages.map(p => p.name);
  }

  /** One reverse-forwarded socket per host; a fresh name each time, since sshd may not unlink a stale one. */
  private ensureForward(bridge: HostBridge, info: { home: string }): Promise<void> {
    if (bridge.forward) return bridge.forward.ready;
    if (this.closed) return Promise.reject(new Error('Sharing has stopped'));
    clearTimeout(bridge.retry); bridge.retry = undefined;
    const directory = `${info.home}/${BASE}/bridge`, socket = `${directory}/s-${randomBytes(4).toString('hex')}.sock`;
    let child: ChildProcess | undefined;
    const ready = this.listen().then(port => new Promise<void>((resolve, reject) => {
      child = this.launch(bridgeForwardArguments(bridge.host.connection, socket, port));
      const started = Date.now(); let stderr = '', confirmed = false;
      const timer = setTimeout(() => { child?.kill(); reject(new Error('The reverse forward did not start')); }, 20_000);
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        stderr = (stderr + chunk).slice(-4000);
        if (!confirmed && /remote forward success|Entering interactive session/i.test(stderr)) {
          confirmed = true; clearTimeout(timer);
          // Point new and running proxies at this socket.
          void bridge.transport.exec(`printf '%s' ${quote(socket)} > ${quote(`${directory}/current.tmp`)} && mv -f ${quote(`${directory}/current.tmp`)} ${quote(`${directory}/current`)}
find ${quote(directory)} -maxdepth 1 -name 's-*.sock' -mtime +7 -exec rm -f {} + 2>/dev/null || true`, 20_000, { login: false })
            .then(() => { bridge.error = undefined; resolve(); }, error => { child?.kill(); reject(error); });
        }
      });
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', code => {
        clearTimeout(timer);
        const lines = stderr.split('\n').filter(line => line && !line.startsWith('debug1:'));
        const error = new Error(lines.at(-1) ?? `The reverse forward ended (${code})`);
        if (!confirmed) reject(error);
        if (bridge.forward?.ready !== ready) return;
        bridge.forward = undefined; bridge.error = error.message;
        if (this.closed) return;
        // Keep the forward while DSH runs: a reattached CLI may call a shared tool at any time.
        bridge.delay = Date.now() - started > 60_000 ? 2000 : Math.min(bridge.delay * 2, 60_000);
        bridge.retry = setTimeout(() => { void this.install(bridge).then(next => this.ensureForward(bridge, next)).catch(() => {}); }, bridge.delay);
      });
    }));
    bridge.forward = { get child() { return child!; }, ready };
    ready.catch(error => { bridge.error = String(error instanceof Error ? error.message : error); if (bridge.forward?.ready === ready) { bridge.forward = undefined; } child?.kill(); });
    return ready;
  }
  private stopForward(bridge: HostBridge): void { clearTimeout(bridge.retry); const forward = bridge.forward; bridge.forward = undefined; forward?.child?.kill(); }

  async prepare(host: HostConfig, transport: SshTransport, task: Task, protocol: NativeProtocol, signal?: AbortSignal): Promise<SharedLaunch> {
    const servers: SharedServer[] = [], launch: SharedLaunch = { servers };
    if (protocol === 'antigravity' || this.closed) return launch;
    const owner = this.owner(task);
    const proxies = owner && this.host.agent ? [...this.mcpServers().keys()].filter(name => this.mcpShared(name)) : [];
    const wantsSkills = !!this.host.skills;
    if (!proxies.length && !wantsSkills) return launch;
    const bridge = this.bridge(host, transport);
    let info: { home: string; node: string };
    try { info = await this.install(bridge); } catch (error) { this.log(`Sharing with ${host.label} is unavailable: ${String(error)}`); return launch; }
    const script = `${info.home}/${BASE}/bridge/bridge-${BRIDGE_VERSION}.mjs`, shared = `${info.home}/${BASE}/shared`;
    if (wantsSkills) {
      try {
        const names = await this.syncSkills(bridge, info, signal);
        if (names.length) {
          if (protocol === 'claude') launch.pluginDir = shared;
          else servers.push({ name: 'dsh', command: info.node, args: [script, 'skills', shared] });
        }
      } catch (error) { signal?.throwIfAborted(); this.log(`Copying skills to ${host.label} failed: ${String(error)}`); }
    }
    if (proxies.length) {
      try {
        const directory = `${info.home}/${BASE}/bridge`, file = `${directory}/tasks/${task.id}.json`;
        const content = JSON.stringify({ task: task.id, token: await this.token(task.id), pointer: `${directory}/current`, cache: `${directory}/cache` });
        await transport.exec(`umask 077; printf '%s' ${quote(content)} > ${quote(`${file}.tmp`)} && mv -f ${quote(`${file}.tmp`)} ${quote(file)}`, 20_000, { login: false });
        // A CLI may start before the forward is up: its proxies connect once it is.
        void this.ensureForward(bridge, info).catch(error => this.log(`Sharing DSH MCP servers with ${host.label} failed: ${String(error)}`));
        for (const name of proxies) servers.push({ name: `dsh-${name}`, command: info.node, args: [script, 'proxy', file, name] });
      } catch (error) { signal?.throwIfAborted(); this.log(`Sharing DSH MCP servers with ${host.label} failed: ${String(error)}`); }
    }
    return launch;
  }
  attached(host: HostConfig, transport: SshTransport, task: Task): void {
    if (this.closed || !this.owner(task) || ![...this.mcpServers().keys()].some(name => this.mcpShared(name))) return;
    const bridge = this.bridge(host, transport);
    void this.install(bridge).then(info => this.ensureForward(bridge, info)).catch(error => this.log(`Sharing DSH MCP servers with ${host.label} failed: ${String(error)}`));
  }
  /** Per-host forward problems, for the settings page. */
  status(): Record<string, string> { return Object.fromEntries([...this.bridges].filter(([, b]) => b.error).map(([id, b]) => [id, b.error!])); }
  async close(): Promise<void> {
    this.closed = true;
    for (const bridge of this.bridges.values()) this.stopForward(bridge);
    for (const connection of this.connections) { for (const call of connection.calls.values()) call.abort(); connection.socket.destroy(); }
    const server = this.server; this.server = undefined;
    await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve());
  }
}
