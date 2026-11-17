import { randomUUID } from 'node:crypto';
import { enabledProvidersOf, isLocalHost, list, LOCAL_SERVER_ID, permissionModes, PROVIDER_LABELS, RELAY_UNAVAILABLE, remotePath, RemoteError } from '../core/domain.js';
import { connectionInput, JsonlPeer, LocalShellTransport, OpenSshTransport, quote } from '../core/ssh.js';
import { MACHINE_IDENTITY, serverIdOf } from '../core/remote-host.js';
import { CliSession, initializeAcp } from './runtime.js';
import { initializeCodex } from '../core/codex.js';
import { TaskHistory } from './history.js';
import { discoverAcpCatalog } from './acp.js';
import { attachmentPrompt, transferAttachments } from './attachments.js';
import { RelayClient, RelayLink } from './relay.js';
import { readAccountUsage } from '../core/usage.js';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { WorkspaceFiles } from '../workspace/files.js';
import { acpServers, sharedArguments } from '../sharing/sharing.js';
export { connectionInput } from '../core/ssh.js';
export const CLI_PROVIDERS = [
    { id: 'claude', label: PROVIDER_LABELS.claude, command: 'claude', protocol: 'claude', args: [] },
    { id: 'codex', label: PROVIDER_LABELS.codex, command: 'codex', protocol: 'codex', args: ['app-server'] },
    { id: 'dsh', label: PROVIDER_LABELS.dsh, command: 'dsh', protocol: 'acp', args: ['--profile', 'acp'] },
    { id: 'grok', label: PROVIDER_LABELS.grok, command: 'grok', protocol: 'acp', args: ['agent', '--no-leader', 'stdio'] },
    { id: 'codebuddy', label: PROVIDER_LABELS.codebuddy, command: 'codebuddy', protocol: 'acp', args: ['--acp'] },
    // `agy acp` (Antigravity CLI 1.5.0 and later). Over SSH it keeps its own login file, apart from the desktop's keychain, and
    // 1.5.8 and earlier answer every session with `Authentication required` even with that file in place.
    { id: 'antigravity', label: PROVIDER_LABELS.antigravity, command: 'agy', protocol: 'acp', args: ['acp'], signIn: 'Antigravity says it is not signed in on this machine. Over SSH it needs Antigravity CLI 1.5.9 or later (`agy update`) and a sign-in of its own (`agy acp --login`). Run them in a terminal on that machine, then refresh.' },
];
/** ACP's `auth_required` error, replaced by how to sign in when the CLI says how. */
export function signInHint(definition, message) {
    return definition.signIn && /^authentication required\.?$/i.test(message.trim()) ? definition.signIn : message;
}
/** Why a probed CLI cannot start a session: its own error when the probe got one, otherwise that it is not installed there. */
export function notReadyReason(provider) {
    if (provider.error)
        return `The selected CLI is not ready in this remote project: ${provider.error}`;
    const command = CLI_PROVIDERS.find(p => p.id === provider.id)?.command ?? provider.id;
    return `${command} was not found on this machine. Install it there, or put its directory on the PATH your login shell sets, then try again.`;
}
export const OLD_ANTIGRAVITY = 'This Antigravity session was started by Remote Agents 0.2.129 or earlier and cannot be continued. Start a new conversation.';
const SESSION_LIMIT = 8;
const DIRECTORY_LIMIT = 2000;
const ACCOUNT_TTL = 300_000;
/** Claude's `list_models` control response: `supportedEffortLevels` holds per-model reasoning choices. */
export function claudeModels(result) {
    return list(result?.models).filter(m => typeof m?.value === 'string').map(m => ({
        id: m.value, label: typeof m.displayName === 'string' ? m.displayName : m.value,
        inputModalities: ['text', 'image'],
        thinkingOptions: list(m.supportedEffortLevels ?? m.efforts).filter((e) => typeof e === 'string').map(id => ({ id, label: id })),
    }));
}
/** Codex speed tiers. `serviceTiers` carries request IDs such as `priority`; older CLIs only list `additionalSpeedTiers` names. */
export function codexServiceTiers(model) {
    const tiers = Array.isArray(model.serviceTiers)
        ? model.serviceTiers.filter(t => typeof t?.id === 'string' && t.id).map(t => ({ id: t.id, label: typeof t.name === 'string' && t.name ? t.name : t.id }))
        : list(model.additionalSpeedTiers).filter((id) => typeof id === 'string' && !!id).map(id => ({ id, label: id[0].toUpperCase() + id.slice(1) }));
    return tiers.length ? tiers : undefined;
}
/**
 * Nobody approves an unattended Claude task's commands. With workspace write it runs them in Claude Code's own sandbox,
 * which confines writes to the workspace like DSH's sandbox; without a sandbox on the host they are asked and denied.
 * Read-only gets no sandbox, since it would have to widen what a read-only task's commands can read while it can reach
 * the web; but searching and reading the web change nothing, and research would otherwise be refused every time.
 * Codex's read-only sandbox already allows web search.
 *
 * `confined` says the sandbox is known to work on this host (see {@link confinesCommands}). Claude Code then exits rather
 * than run without it and ignores a command's request to leave it, so its commands can be left to the sandbox.
 * Temporary files are allowed too: without them most real test suites fail with EPERM, which a model takes for a bug in
 * the code (measured on this repository: 8 of 20 and 4 of 71 tests passed, then all of them).
 */
export const unattendedClaude = (task, confined = false) => {
    if (!task.unattended)
        return [];
    if (task.modeId === 'acceptEdits')
        return ['--settings', JSON.stringify({ sandbox: { enabled: true, autoAllowBashIfSandboxed: true, ...(confined ? { failIfUnavailable: true, allowUnsandboxedCommands: false, filesystem: { allowWrite: ['/tmp', '/private/tmp'] } } : {}) } })];
    return task.modeId === 'default' ? ['--allowedTools', 'WebSearch,WebFetch'] : [];
};
/** The oldest Claude Code measured to keep every command in the sandbox with these settings. */
const CONFINED_CLAUDE = [2, 1, 319];
/**
 * Whether an unattended Claude's commands can be left to its sandbox rather than refused. Only macOS has been measured:
 * on Linux it also needs bwrap and socat, and without them Claude Code runs commands unsandboxed.
 */
export function confinesCommands(system, version) {
    if (system.trim() !== 'Darwin')
        return false;
    const parts = /(\d+)\.(\d+)\.(\d+)/.exec(version)?.slice(1).map(Number);
    if (!parts)
        return false;
    for (const [index, floor] of CONFINED_CLAUDE.entries())
        if (parts[index] !== floor)
            return parts[index] > floor;
    return true;
}
/**
 * Claude Code refuses to skip permissions as root unless IS_SANDBOX says the machine is meant for it. Whoever connects as
 * root and picks Full access, or made it that account's default, has decided that, so these launches say so. The host is
 * asked because any account name can have uid 0. It is set around the launch rather than by a wrapper command: the relay
 * recognizes its CLI by the command it started.
 */
export const CLAUDE_ROOT_ENV = 'if [ "$(id -u)" = 0 ]; then export IS_SANDBOX=1; fi; ';
/** Full access, or inheriting the host's settings, which can ask for it. Other modes keep Claude Code's check. */
const maySkipPermissions = (modeId) => !modeId || modeId === 'inherit' || modeId === 'bypassPermissions';
/** A short-lived CLI that only answers questions; it reads the same settings as a session. */
const claudeProbe = (path) => [path, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence'];
export class SshBackend {
    host;
    store;
    sharing;
    workspaceFiles;
    transport;
    closed = false;
    probes = new Set();
    identity;
    catalogs = new Map();
    confining = new Map();
    /** One CLI's probe for the start path, keyed by `cwd\0provider`, so `create` and `open` do not probe twice. */
    targets = new Map();
    sessions = new Map();
    /** Admitted starts/restores, including work not yet registered in sessions. */
    reservations = new Set();
    histories = new Map();
    /** When each loaded history was last used, so idle ones (no live session) are freed from memory. */
    historyUsed = new Map();
    historySweep;
    /** How long a history with no live session is kept in memory after its last read, before it is reloaded on demand. */
    historyTtl = 300_000;
    starting = new Map();
    accounts = new Map();
    /** The plan each CLI's account last showed, for answers that cannot tell it. */
    plans = new Map();
    /** Tasks with an operation in flight; their sessions are never evicted. */
    leases = new Map();
    relayClient;
    /** Why the last relay check failed; CLIs are not started until it succeeds. */
    relayUnavailable;
    ending = new Map();
    restoring = new Map();
    cleaning;
    ownTurnListeners = new Set();
    constructor(host, store, transport, sharing = () => undefined) {
        this.host = host;
        this.store = store;
        this.sharing = sharing;
        // Commands to the host share one SSH connection; its sockets live in this plugin's private state directory.
        // The local machine runs the same commands in a local shell.
        this.transport = transport ?? (isLocalHost(host) ? new LocalShellTransport()
            : new OpenSshTransport(connectionInput(host.connection), 'ssh', { controlDirectory: join(store.directory, 'ssh') }));
        this.workspaceFiles = new WorkspaceFiles(this.transport);
    }
    onOwnTurn(listener) {
        this.ownTurnListeners.add(listener);
        return () => { this.ownTurnListeners.delete(listener); };
    }
    assertOpen() { if (this.closed)
        throw new Error('SSH agent backend has stopped'); }
    async homeDirectory() {
        this.assertOpen();
        // $HOME is set by the system, so this never needs the remote login shell, which costs ~0.5s to load.
        const path = await this.transport.exec('printf \'%s\' "$HOME"', 20_000, { login: false });
        this.assertOpen();
        return remotePath(path);
    }
    async listDirectory(path, options = {}) {
        this.assertOpen();
        // NUL-separated: directory names may contain any byte except '/' and NUL. `+` marks a truncated listing.
        const output = await this.transport.exec(`dsh_target=${quote(path ?? '~')}
case "$dsh_target" in '~') dsh_target="$HOME" ;; '~/'*) dsh_target="$HOME/\${dsh_target#??}" ;; esac
cd -- "$dsh_target" 2>/dev/null || { printf '%s\\n' 'Not a readable directory' >&2; exit 3; }
printf '%s\\0%s\\0' "$(pwd -P)" "$(cd -- "$HOME" 2>/dev/null && pwd -P || printf '%s' "$HOME")"
${options.entries === false ? '' : `dsh_count=0
for dsh_entry in * .[!.]* ..?*; do
  [ -d "$dsh_entry" ] || continue
  dsh_count=$((dsh_count + 1))
  [ "$dsh_count" -le ${DIRECTORY_LIMIT} ] || { printf '+\\0'; break; }
  printf 'd%s\\0' "$dsh_entry"
done`}`, 15_000, { login: false });
        this.assertOpen();
        const [cwd, home, ...rest] = output.split('\0'), canonical = remotePath(cwd);
        const entries = rest.filter(item => item.startsWith('d') && item.length > 1 && !item.includes('\n')).map(item => item.slice(1))
            .sort((a, b) => a.localeCompare(b)).map(name => ({ name, path: canonical === '/' ? `/${name}` : `${canonical}/${name}` }));
        return { path: canonical, home: remotePath(home), entries, truncated: rest.includes('+') };
    }
    async connect() {
        this.assertOpen();
        // This computer stays itself when it is renamed; there is no connection to check either.
        if (isLocalHost(this.host))
            return LOCAL_SERVER_ID;
        if (this.identity && Date.now() - this.identity.at < 15_000)
            return this.identity.id;
        // The identity is cat/uname/id only; skip the login shell, which `use()` would otherwise pay on every recheck.
        const [machine, user, unique] = (await this.transport.exec(MACHINE_IDENTITY, 20_000, { login: false })).split('\0');
        if (!machine || !user || !unique)
            throw new Error('SSH did not report a valid machine identity');
        const id = serverIdOf(machine, user, unique);
        this.identity = { id, at: Date.now() };
        return id;
    }
    async history(id) {
        this.historyUsed.set(id, Date.now());
        let promise = this.histories.get(id);
        if (!promise) {
            const history = new TaskHistory(this.store.directory, id);
            promise = history.open().then(() => history);
            this.histories.set(id, promise);
            // Reload-on-demand means a history nothing reads need not stay in memory; a hub opens many over its lifetime.
            if (!this.historySweep && !this.closed) {
                this.historySweep = setInterval(() => this.sweepHistories(), 60_000);
                this.historySweep.unref?.();
            }
        }
        return promise;
    }
    /**
     * Drop histories no live session uses and nothing has read for a while; a later read reopens them from disk.
     * A history an attached, restoring or starting session holds is kept: a second instance of the same file would
     * append or read out of step with the one that session holds.
     */
    sweepHistories() {
        if (this.closed)
            return;
        const now = Date.now();
        for (const id of [...this.histories.keys()]) {
            if (this.sessions.has(id) || this.restoring.has(id) || this.starting.has(id))
                continue;
            if (now - (this.historyUsed.get(id) ?? 0) < this.historyTtl)
                continue;
            this.histories.delete(id);
            this.historyUsed.delete(id);
        }
        for (const id of [...this.historyUsed.keys()])
            if (!this.histories.has(id))
                this.historyUsed.delete(id);
    }
    /** Canonical cwd and the installed path of each probed CLI, in one SSH round trip. */
    async canonicalize(cwd, definitions) {
        const output = await this.transport.exec(`cd ${quote(cwd)} && printf '%s\\0' "$(pwd -P)" && ${definitions.map(p => `printf '%s\\0%s\\0' ${quote(p.id)} "$(command -v ${quote(p.command)} 2>/dev/null || true)"`).join(' && ')}`);
        const [canonical, ...parts] = output.split('\0');
        this.assertOpen();
        if (!canonical?.startsWith('/'))
            throw new Error('Remote project does not exist or is not accessible');
        const installed = new Map();
        for (let i = 0; i + 1 < parts.length; i += 2)
            if (parts[i + 1])
                installed.set(parts[i], parts[i + 1]);
        return { canonical, installed };
    }
    /** Probe one CLI in its canonical cwd: its models and modes, and the launch profile when it is ready. */
    async probeDefinition(definition, canonical, path) {
        const unavailable = { id: definition.id, label: definition.label, status: 'unavailable', models: [], modes: [] };
        if (!path)
            return { provider: unavailable };
        let peer;
        try {
            const argv = [path, ...definition.args];
            const launch = definition.protocol === 'claude' ? claudeProbe(path) : argv;
            this.assertOpen();
            peer = new JsonlPeer(this.transport.start(canonical, launch, { endWithSession: true, ...(definition.protocol === 'claude' ? { prefix: CLAUDE_ROOT_ENV } : {}) }));
            this.probes.add(peer);
            peer.onMessage(message => { if (message.method && message.id !== undefined)
                peer?.send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Discovery does not execute tools' } }); });
            let models = [], modes = [], defaultModeId;
            if (definition.protocol === 'codex') {
                await initializeCodex(peer);
                let cursor;
                for (let page = 0; page < 20; page++) {
                    const result = await peer.request('model/list', { limit: 100, ...(cursor ? { cursor } : {}) });
                    models.push(...list(result?.data).filter(m => !m.hidden).map(m => ({ id: String(m.model ?? m.id), label: String(m.displayName ?? m.model ?? m.id), inputModalities: (Array.isArray(m.inputModalities) && !m.inputModalities.includes('image') ? ['text'] : ['text', 'image']), isDefault: m.isDefault === true, defaultThinkingOptionId: m.defaultReasoningEffort, thinkingOptions: list(m.supportedReasoningEfforts).map(e => ({ id: String(e.reasoningEffort), label: String(e.reasoningEffort) })), serviceTiers: codexServiceTiers(m) })));
                    cursor = result?.nextCursor;
                    if (!cursor)
                        break;
                }
                modes = permissionModes('codex', [{ id: 'workspace-write', label: 'Workspace write · ask on request' }, { id: 'auto-review', label: 'Workspace write · auto review' }, { id: 'read-only', label: 'Read only' }, { id: 'full-access', label: 'Full access' }]);
                defaultModeId = 'inherit';
            }
            else if (definition.protocol === 'claude') {
                await peer.control({ subtype: 'initialize' });
                models = claudeModels(await peer.control({ subtype: 'list_models' }));
                modes = permissionModes('claude', [{ id: 'default', label: 'Ask before tools' }, { id: 'plan', label: 'Plan' }, { id: 'acceptEdits', label: 'Accept edits' }, { id: 'bypassPermissions', label: 'Full access' }]);
                defaultModeId = 'inherit';
            }
            else {
                const capabilities = await initializeAcp(peer);
                const session = await peer.request('session/new', { cwd: canonical, mcpServers: [] });
                ({ models, modes, defaultModeId } = await discoverAcpCatalog(peer, session));
                for (const model of models)
                    model.inputModalities = capabilities.agentCapabilities?.promptCapabilities?.image === true ? ['text', 'image'] : ['text'];
                if (capabilities.agentCapabilities?.sessionCapabilities?.close)
                    await peer.request('session/close', { sessionId: session.sessionId });
            }
            models = [...new Map(models.filter(m => m.id && m.id !== 'undefined').map(m => [m.id, m])).values()];
            if (!models.length)
                throw new Error('The remote CLI returned no models. Check its login and version.');
            const provider = { ...unavailable, status: 'ready', models, modes, defaultModeId };
            return { provider, profile: { argv, protocol: definition.protocol, cwd: canonical, provider } };
        }
        catch (error) {
            return { provider: { ...unavailable, status: 'error', error: signInHint(definition, error instanceof Error ? error.message : String(error)) } };
        }
        finally {
            if (peer) {
                this.probes.delete(peer);
                peer.close();
            }
        }
    }
    async providers(cwd, refresh) {
        this.assertOpen();
        const enabled = enabledProvidersOf(this.store.hosts().find(h => h.id === this.host.id) ?? this.host);
        const selection = [...enabled].sort().join(','), definitions = CLI_PROVIDERS.filter(p => enabled.includes(p.id));
        if (!definitions.length)
            return [];
        const cached = this.catalogs.get(cwd);
        if (!refresh && cached?.selection === selection && Date.now() - cached.at < 30_000)
            return structuredClone(cached.providers);
        const { canonical, installed } = await this.canonicalize(cwd, definitions);
        const probed = await Promise.all(definitions.map(definition => this.probeDefinition(definition, canonical, installed.get(definition.id))));
        const providers = probed.map(({ provider }) => provider);
        this.assertOpen();
        this.catalogs.set(cwd, { at: Date.now(), selection, providers });
        return structuredClone(providers);
    }
    /**
     * Probe only the one CLI a session needs, rather than launching every enabled CLI to list its models.
     * Cached briefly so a session's validation (`create`) and its launch (`open`) share a single probe.
     */
    async resolveTarget(cwd, providerId, refresh = false) {
        this.assertOpen();
        const key = `${cwd}\0${providerId}`, cached = this.targets.get(key);
        if (!refresh && cached && Date.now() - cached.at < 30_000)
            return { provider: cached.provider, ...(cached.profile ? { profile: cached.profile } : {}) };
        const enabled = enabledProvidersOf(this.store.hosts().find(h => h.id === this.host.id) ?? this.host);
        const definition = CLI_PROVIDERS.find(p => p.id === providerId);
        if (!definition || !enabled.includes(providerId))
            return { provider: { id: providerId, label: PROVIDER_LABELS[providerId] ?? providerId, status: 'unavailable', models: [], modes: [] } };
        const { canonical, installed } = await this.canonicalize(cwd, [definition]);
        const result = await this.probeDefinition(definition, canonical, installed.get(providerId));
        this.assertOpen();
        // Only a ready CLI is kept: `open` needs nothing from a failed probe, and once the user fixes the CLI the next message should probe again.
        if (result.provider.status === 'ready')
            this.targets.set(key, { at: Date.now(), provider: result.provider, profile: result.profile });
        else
            this.targets.delete(key);
        return result;
    }
    /** The one CLI a session targets, probed in its own cwd, for `create` to validate the model, mode and speed. */
    async target(cwd, providerId) { return structuredClone((await this.resolveTarget(cwd, providerId)).provider); }
    task(id) {
        const task = this.store.task(t => t.agentId === id && t.hostId === this.host.id);
        if (!task)
            throw new RemoteError('Remote agent not found', 404);
        return task;
    }
    /** Hosts with Node.js 18+ run CLIs under a relay; transports without relay support keep a direct SSH pipe. */
    relays(reinstall = false) {
        if (!this.transport.relays)
            return Promise.resolve(undefined);
        const cached = this.relayClient;
        if (cached && !reinstall && Date.now() - cached.at < 60_000)
            return cached.value;
        const value = RelayClient.open(this.transport).then(result => {
            this.relayUnavailable = typeof result === 'string' ? result : undefined;
            return typeof result === 'string' ? undefined : result;
        });
        this.relayClient = { at: Date.now(), value };
        // A missing relay is checked again on the next start, so installing Node.js takes effect on retry.
        value.then(client => { if (this.relayClient?.value === value) {
            if (client)
                this.relayClient.at = Infinity;
            else
                this.relayClient = undefined;
        } }, () => { if (this.relayClient?.value === value)
            this.relayClient = undefined; });
        return value;
    }
    /** Forget a relay locally and remove it remotely now, or once the host is reachable. */
    relayEnded(taskId, relayId) {
        const ending = (async () => {
            await (await this.histories.get(taskId)?.catch(() => undefined))?.flush().catch(() => { });
            await this.store.update(state => {
                const saved = state.tasks.find(t => t.id === taskId);
                if (saved?.relay?.id === relayId)
                    delete saved.relay;
                state.relayCleanups = [...(state.relayCleanups ?? []).filter(c => c.relayId !== relayId), { hostId: this.host.id, relayId }];
            });
            void this.cleanup();
        })().finally(() => { if (this.ending.get(taskId) === ending)
            this.ending.delete(taskId); });
        this.ending.set(taskId, ending);
        return ending;
    }
    /** Stop and delete relays queued for this host. Never blocks local deletion or archiving. */
    cleanup() {
        if (this.cleaning || this.closed || !this.store.relayCleanups(this.host.id).length)
            return this.cleaning ?? Promise.resolve();
        const cleaning = (async () => {
            const ids = this.store.relayCleanups(this.host.id).map(c => c.relayId);
            const relay = await this.relays();
            if (!relay || this.closed)
                return;
            // A relay whose CLI could not be confirmed stopped stays queued for the next attempt.
            const removed = await relay.remove(ids);
            // After a shutdown the next instance owns the state; it retries the queued removal, which is idempotent.
            if (this.closed)
                return;
            await this.store.update(state => {
                state.relayCleanups = state.relayCleanups?.filter(c => c.hostId !== this.host.id || !removed.includes(c.relayId));
                if (!state.relayCleanups?.length)
                    delete state.relayCleanups;
            });
        })().catch(() => { }).finally(() => { this.cleaning = undefined; });
        this.cleaning = cleaning;
        return cleaning;
    }
    /** A link to a relay, installing the current relay script on the host before attaching. */
    link(id, offset, onState) {
        return new RelayLink(this.transport, id, offset, async (reinstall) => {
            this.assertOpen();
            if (!await this.relays(reinstall))
                throw new Error('Node.js 18 or newer is no longer available on this SSH host');
        }, onState);
    }
    session(task, peer, history, relay) {
        // A turn the CLI runs by itself grows the history without a message from here.
        const historyChanged = () => { for (const listener of this.ownTurnListeners) {
            try {
                listener(task.id);
            }
            catch { /* A listener must not stop the session. */ }
        } };
        return new CliSession(peer, task, history, this.store, { goalFailed: (messageId, reason) => this.sharing()?.goalFailed?.(task, messageId, reason), ownTurnStarted: historyChanged, turnEnded: ({ unprompted }) => {
                // A finished turn changed the account's usage; read it again when it is next shown.
                this.accounts.delete(task.provider);
                if (unprompted)
                    historyChanged();
            },
            usage: (usage, turn) => { for (const listener of this.store.usageListeners) {
                try {
                    listener(task.id, usage, turn);
                }
                catch { /* Statistics must not break a session. */ }
            } }, ...(relay ? { ended: () => void this.relayEnded(task.id, relay.id).catch(() => { }) } : {}) }, relay);
    }
    /**
     * Reattach to the relay still running this task's CLI. Needs no SSH connection: the link keeps
     * reconnecting, and the turn, tools and pending permissions are rebuilt from the saved history.
     */
    restore(task) {
        if (this.closed)
            return Promise.reject(new Error('SSH agent backend has stopped'));
        const pending = this.restoring.get(task.id);
        if (pending)
            return pending;
        const restoring = this.reconnect(task).finally(() => { if (this.restoring.get(task.id) === restoring)
            this.restoring.delete(task.id); });
        this.restoring.set(task.id, restoring);
        return restoring;
    }
    async reconnect(task) {
        this.assertOpen();
        const existing = this.sessions.get(task.id);
        if (existing?.alive)
            return structuredClone(existing.agent);
        if (!task.relay || !task.native)
            return null;
        const release = this.reserve(task.id);
        let session;
        try {
            const history = await this.history(task.id);
            const at = (await history.checkpoint(task.relay.id))?.at ?? 0;
            this.assertOpen();
            const link = this.link(task.relay.id, at, state => { if (session)
                session.agent.reconnecting = !state.connected; });
            session = this.session({ ...task, executionCwd: task.executionCwd ?? task.cwd }, new JsonlPeer(link), history, link);
            await session.restore();
            // close() may have released all registered sessions while history was still loading.
            this.assertOpen();
            session.agent.reconnecting = true;
            this.sessions.set(task.id, session);
            link.open();
            // Its MCP proxies reach DSH again once the reverse forward is back.
            this.sharing()?.attached(this.store.hosts().find(h => h.id === this.host.id) ?? this.host, this.transport, task);
            return structuredClone(session.agent);
        }
        catch (error) {
            // Release the local attachment only: a persistent CLI must survive shutdown or a failed restore.
            session?.release();
            if (session && this.sessions.get(task.id) === session)
                this.sessions.delete(task.id);
            throw error;
        }
        finally {
            release();
        }
    }
    /** Synchronous admission: no async launch/restore can pass the same last free slot. */
    reserve(id) {
        this.assertOpen();
        if (this.reservations.has(id))
            throw new Error('This CLI session is already being attached');
        const occupied = () => this.reservations.size + [...this.sessions].filter(([id, session]) => session.alive && !this.reservations.has(id)).length;
        while (occupied() >= SESSION_LIMIT) {
            const idle = [...this.sessions].find(([id, session]) => !this.reservations.has(id) && !this.starting.has(id) && !this.restoring.has(id) && !this.leases.has(id) && session.evictable);
            if (!idle)
                throw new Error(`This SSH host already has ${SESSION_LIMIT} working CLI sessions. Wait for one to finish, or archive an idle agent.`);
            idle[1].close();
            this.sessions.delete(idle[0]);
        }
        this.reservations.add(id);
        return () => { this.reservations.delete(id); };
    }
    lease(id) {
        this.leases.set(id, (this.leases.get(id) ?? 0) + 1);
        let released = false;
        return () => {
            if (released)
                return;
            released = true;
            const count = this.leases.get(id) - 1;
            if (count)
                this.leases.set(id, count);
            else
                this.leases.delete(id);
        };
    }
    async create(task, signal) { return this.start(task, false, signal); }
    async recover(task, signal) { return this.start(task, true, signal); }
    async start(task, resume, signal) {
        this.assertOpen();
        const existing = this.sessions.get(task.id);
        if (existing?.alive && existing.agent.status !== 'closed')
            return structuredClone(existing.agent);
        const pending = this.starting.get(task.id);
        if (pending)
            return pending;
        const operation = this.open(task, resume, signal);
        this.starting.set(task.id, operation);
        try {
            return await operation;
        }
        finally {
            this.starting.delete(task.id);
        }
    }
    /** Asked once per CLI: what the host is and which Claude Code it runs. Anything unclear keeps commands refused. */
    confines(cli) {
        let known = this.confining.get(cli);
        if (!known) {
            known = this.transport.exec(`uname -s; ${quote(cli)} --version`, 20_000, { login: false })
                .then(output => { const [system = '', version = ''] = output.split('\n'); return confinesCommands(system, version); }, () => false);
            this.confining.set(cli, known);
        }
        return known;
    }
    async open(task, resume, signal) {
        if (!CLI_PROVIDERS.some(provider => provider.id === task.provider))
            throw new Error('This CLI provider is no longer supported. Saved output remains available.');
        const saved = this.store.task(t => t.id === task.id) ?? task;
        if (saved.relay && saved.native) {
            // The CLI may still be running remotely: reattach instead of starting or resuming another one.
            const restored = await this.reattach(saved);
            if (restored) {
                const history = await this.history(task.id);
                if (!resume && !(await history.hasMessage(task.id))) {
                    const attachments = await transferAttachments(this.transport, this.store.directory, task.id, task.id, restored.agent.cwd, task.attachments ?? [], signal);
                    await restored.send(attachmentPrompt(task.prompt, attachments), task.id, attachments);
                }
                return structuredClone(restored.agent);
            }
        }
        this.sessions.get(task.id)?.close();
        let profile;
        if (resume) {
            if (!task.native)
                throw new Error('No saved native CLI session exists. The task will not be replayed.');
            // 0.2.129 and earlier drove Antigravity through its stream-json mode, which this version no longer speaks.
            if (!['codex', 'claude', 'acp'].includes(task.native.protocol))
                throw new RemoteError(OLD_ANTIGRAVITY, 409);
            profile = { protocol: task.native.protocol, argv: task.native.argv, cwd: task.executionCwd ?? task.cwd, provider: { id: task.provider, label: task.provider, status: 'ready', models: [], modes: [] } };
        }
        else {
            // Reuses the probe `create` just ran for this task, so starting a session launches only the one CLI it needs.
            const resolved = await this.resolveTarget(task.cwd, task.provider);
            if (!resolved.profile)
                throw new Error(notReadyReason(resolved.provider));
            profile = resolved.profile;
        }
        let argv = [...profile.argv];
        // Only this mode gets the sandbox settings; the task's record must never say more than its CLI was told.
        const confined = profile.protocol === 'claude' && task.unattended === true && task.modeId === 'acceptEdits' && await this.confines(argv[0]);
        signal?.throwIfAborted();
        if (!!this.store.task(t => t.id === task.id)?.sandboxed !== !!confined)
            await this.store.update(state => {
                const saved = state.tasks.find(t => t.id === task.id);
                if (saved && confined)
                    saved.sandboxed = true;
                else if (saved)
                    delete saved.sandboxed;
            });
        if (profile.protocol === 'claude')
            argv = [argv[0], '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-prompt-tool', 'stdio', '--model', task.model, ...(resume ? ['--resume', task.native.sessionId] : ['--session-id', randomUUID()]), ...(task.modeId && task.modeId !== 'inherit' ? ['--permission-mode', task.modeId] : []), ...(task.thinkingOptionId ? ['--effort', task.thinkingOptionId] : []), ...unattendedClaude(task, confined)];
        const relay = await this.relays();
        this.assertOpen();
        signal?.throwIfAborted();
        // A direct pipe would end silently with DSH; refuse and say why before touching the host.
        if (!relay && this.transport.relays)
            throw new RemoteError(RELAY_UNAVAILABLE[this.relayUnavailable ?? 'install-failed'], 409);
        const history = await this.history(task.id);
        // Upload before creating a native session, so a failed upload can be retried safely.
        const attachments = !resume ? await transferAttachments(this.transport, this.store.directory, task.id, task.id, profile.cwd, task.attachments ?? [], signal) : [];
        signal?.throwIfAborted();
        this.assertOpen();
        const release = this.reserve(task.id);
        try {
            // DSH's shared MCP servers and skills are launch options only; the saved argv stays the CLI's own.
            // Sharing never blocks a launch: the CLI starts without what could not be prepared.
            const shared = await this.sharing()?.prepare(this.store.hosts().find(h => h.id === this.host.id) ?? this.host, this.transport, saved, profile.protocol, signal)
                .catch(error => { signal?.throwIfAborted(); console.warn(`[remote-agents] Sharing with ${this.host.label} failed: ${String(error)}`); return undefined; });
            signal?.throwIfAborted();
            this.assertOpen();
            const launch = sharedArguments(profile.protocol, argv, shared);
            const prefix = profile.protocol === 'claude' && maySkipPermissions(task.modeId) ? CLAUDE_ROOT_ENV : undefined;
            let link;
            if (relay) {
                // Record the relay before it exists, so an interrupted start is cleaned up rather than leaked.
                const relayId = randomUUID(), previous = this.store.task(t => t.id === task.id)?.relay;
                await this.store.update(state => {
                    const saved = state.tasks.find(t => t.id === task.id);
                    if (!saved)
                        throw new RemoteError('Remote agent was deleted', 409);
                    saved.relay = { id: relayId };
                    if (previous)
                        state.relayCleanups = [...(state.relayCleanups ?? []), { hostId: this.host.id, relayId: previous.id }];
                });
                if (previous)
                    void this.cleanup();
                try {
                    await relay.launch(relayId, profile.cwd, launch, prefix);
                }
                catch (error) {
                    await this.relayEnded(task.id, relayId).catch(() => { });
                    throw error;
                }
                link = this.link(relayId, 0, state => { if (this.sessions.get(task.id)?.relay === link)
                    this.sessions.get(task.id).agent.reconnecting = !state.connected; });
            }
            this.assertOpen();
            const session = this.session({ ...task, executionCwd: profile.cwd }, new JsonlPeer(link ?? this.transport.start(profile.cwd, launch, { prefix, endWithSession: true })), history, link);
            this.sessions.set(task.id, session);
            link?.open();
            try {
                await session.initialize(profile.protocol, argv, resume, acpServers(shared), shared?.goalIdentity);
                this.assertOpen();
                if (!resume)
                    await session.send(attachmentPrompt(task.prompt, attachments), task.id, attachments);
                return structuredClone(session.agent);
            }
            catch (error) {
                session.close();
                throw error;
            }
        }
        finally {
            release();
        }
    }
    async agent(id) {
        const task = this.task(id), session = this.sessions.get(task.id);
        if (session)
            return structuredClone(session.agent);
        return { id, cwd: task.executionCwd ?? task.cwd, provider: task.provider, model: task.model, title: task.title, status: 'closed', pendingPermissions: [], nativeSessionId: task.native?.sessionId, resumable: task.native?.resumable };
    }
    read(id) { return this.history(this.task(id).id); }
    async timeline(id, cursor, direction) { return (await this.read(id)).page(cursor, direction); }
    async messageTimeline(id, messageId, cursor) { return (await this.read(id)).messagePage(messageId, cursor); }
    async reply(id) { return (await this.read(id)).lastReply(); }
    /** A restored relay session once it is connected, or undefined when its CLI has ended. */
    async reattach(task) {
        if (!this.sessions.get(task.id)?.alive)
            await this.restore(task);
        const session = this.sessions.get(task.id);
        // An idle CLI may have ended while DSH was away; then the native session is resumed instead.
        if (session?.relay)
            await session.relay.ready(30_000).catch(() => { });
        if (session?.alive)
            return session;
        await this.ending.get(task.id);
    }
    /** The live session, resuming the saved native session when the process is gone. */
    async attached(task) {
        const saved = this.store.task(t => t.id === task.id) ?? task;
        const session = saved.relay && saved.native ? await this.reattach(saved) : this.sessions.get(task.id);
        if (session?.alive)
            return session;
        if (task.native?.resumable === false)
            throw new RemoteError('This CLI session has ended and cannot be resumed. Its output is kept.', 409);
        await this.start(task, true);
        return this.sessions.get(task.id);
    }
    async send(id, text, messageId, attachments = [], signal) {
        const task = this.task(id), release = this.lease(task.id);
        try {
            if (await (await this.history(task.id)).hasMessage(messageId))
                return; // Durable at-most-once admission.
            let session = await this.attached(this.store.task(t => t.id === task.id) ?? task);
            if (session.busy) {
                await session.stop();
                session = await this.attached(this.store.task(t => t.id === task.id) ?? task);
            }
            const files = await transferAttachments(this.transport, this.store.directory, task.id, messageId, task.executionCwd ?? task.cwd, attachments, signal);
            await session.send(attachmentPrompt(text, files), messageId, files);
        }
        finally {
            release();
        }
    }
    async stop(id) {
        const task = this.task(id);
        const session = this.sessions.get(task.id);
        if (session?.alive)
            await session.stop();
    }
    async respond(id, requestId, answer) {
        const task = this.task(id);
        const session = this.sessions.get(task.id);
        if (!session?.alive)
            throw new RemoteError('This permission request is no longer pending', 409);
        await session.respond(requestId, answer);
    }
    async detach(task) {
        const session = this.sessions.get(task.id);
        if (session) {
            // Interrupting needs a connection; an unreachable relay is stopped by its queued cleanup instead.
            if (session.alive && session.busy && (!session.relay || session.relay.connected))
                await session.stop();
            session.close();
            this.sessions.delete(task.id);
        }
        const relay = this.store.task(t => t.id === task.id)?.relay;
        if (relay)
            await this.relayEnded(task.id, relay.id);
        await this.ending.get(task.id);
    }
    async forget(task) {
        await this.detach(task);
        await this.removeFiles(task.id);
    }
    async removeFiles(id) {
        const history = this.histories.get(id) ?? this.history(id);
        this.histories.delete(id);
        await (await history.catch(() => new TaskHistory(this.store.directory, id))).remove();
        await rm(join(this.store.directory, 'attachments', id), { recursive: true, force: true });
    }
    async account(provider, cwd, refresh) {
        this.assertOpen();
        const definition = CLI_PROVIDERS.find(p => p.id === provider);
        if (definition?.protocol !== 'codex' && definition?.protocol !== 'claude')
            return null;
        const cached = this.accounts.get(provider);
        if (cached && !refresh && Date.now() - cached.at < ACCOUNT_TTL)
            return cached.value;
        const value = this.readAccount(definition, cwd, this.plans.get(provider)).then(usage => {
            if (usage.plan)
                this.plans.set(provider, usage.plan);
            return usage;
        });
        this.accounts.set(provider, { at: Date.now(), value });
        value.catch(() => { if (this.accounts.get(provider)?.value === value)
            this.accounts.delete(provider); });
        return value;
    }
    /** Ask a running session of this CLI, or briefly start one without a prompt. */
    async readAccount(definition, cwd, lastPlan) {
        const live = [...this.sessions.values()].find(s => s.alive && s.task.provider === definition.id && s.agent.status !== 'initializing');
        if (live)
            return readAccountUsage(live.peer, definition.protocol, live.account, lastPlan);
        const path = await this.transport.exec(`printf '%s' "$(command -v ${quote(definition.command)} 2>/dev/null || true)"`);
        this.assertOpen();
        if (!path.startsWith('/'))
            throw new Error(`${definition.label} is not installed on this SSH host`);
        const argv = definition.protocol === 'claude' ? claudeProbe(path) : [path, ...definition.args];
        const peer = new JsonlPeer(this.transport.start(cwd ?? await this.homeDirectory(), argv, { endWithSession: true, ...(definition.protocol === 'claude' ? { prefix: CLAUDE_ROOT_ENV } : {}) }));
        this.probes.add(peer);
        try {
            peer.onMessage(message => { if (message.method && message.id !== undefined)
                peer.send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Usage checks do not execute tools' } }); });
            if (definition.protocol === 'codex') {
                await initializeCodex(peer);
                return await readAccountUsage(peer, 'codex');
            }
            const init = await peer.control({ subtype: 'initialize' });
            return await readAccountUsage(peer, 'claude', init?.account, lastPlan);
        }
        finally {
            this.probes.delete(peer);
            peer.close();
        }
    }
    /** Shutdown releases persistent sessions, which keep running and are restored on the next start. */
    async close() {
        this.closed = true;
        clearInterval(this.historySweep);
        this.historySweep = undefined;
        for (const probe of this.probes)
            probe.close();
        for (const session of this.sessions.values())
            session.release();
        // Restores never wait for starts, so a start awaiting restore cannot form a shutdown cycle.
        await Promise.allSettled([...this.starting.values(), ...this.restoring.values(), ...this.ending.values()]);
        this.probes.clear();
        this.sessions.clear();
        for (const history of this.histories.values())
            await (await history.catch(() => undefined))?.flush();
    }
}
