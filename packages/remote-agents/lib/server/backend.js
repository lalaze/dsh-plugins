import { createHash, randomUUID } from 'node:crypto';
import { enabledProvidersOf, permissionModes, PROVIDER_LABELS, remotePath, RemoteError } from './domain.js';
import { connectionInput, JsonlPeer, OpenSshTransport, quote } from './ssh.js';
import { CliSession, initializeAcp, initializeCodex } from './runtime.js';
import { TaskHistory } from './history.js';
import { discoverAcpCatalog } from './acp.js';
import { antigravityArguments, ANTIGRAVITY_NOTICE, ANTIGRAVITY_RUNNER, decodeAntigravityModels } from './antigravity.js';
import { attachmentPrompt, transferAttachments } from './attachments.js';
import { readAccountUsage } from './usage.js';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
export { connectionInput } from './ssh.js';
export const CLI_PROVIDERS = [
    { id: 'claude', label: PROVIDER_LABELS.claude, command: 'claude', protocol: 'claude', args: [] },
    { id: 'codex', label: PROVIDER_LABELS.codex, command: 'codex', protocol: 'codex', args: ['app-server'] },
    { id: 'dsh', label: PROVIDER_LABELS.dsh, command: 'dsh', protocol: 'acp', args: ['--profile', 'acp'] },
    { id: 'antigravity', label: PROVIDER_LABELS.antigravity, command: 'agy', protocol: 'antigravity', args: [] },
    { id: 'grok', label: PROVIDER_LABELS.grok, command: 'grok', protocol: 'acp', args: ['agent', '--no-leader', 'stdio'] },
    { id: 'codebuddy', label: PROVIDER_LABELS.codebuddy, command: 'codebuddy', protocol: 'acp', args: ['--acp'] },
];
const SESSION_LIMIT = 8;
const ACCOUNT_TTL = 300_000;
const list = (value) => Array.isArray(value) ? value : [];
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
export class SshBackend {
    host;
    store;
    transport;
    closed = false;
    probes = new Set();
    identity;
    catalogs = new Map();
    sessions = new Map();
    histories = new Map();
    starting = new Map();
    accounts = new Map();
    /** Tasks with an operation in flight; their sessions are never evicted. */
    leases = new Map();
    constructor(host, store, transport) {
        this.host = host;
        this.store = store;
        this.transport = transport ?? new OpenSshTransport(connectionInput(host.connection));
    }
    assertOpen() { if (this.closed)
        throw new Error('SSH agent backend has stopped'); }
    async homeDirectory() {
        this.assertOpen();
        const path = await this.transport.exec('printf \'%s\' "$HOME"');
        this.assertOpen();
        return remotePath(path);
    }
    async connect() {
        this.assertOpen();
        if (this.identity && Date.now() - this.identity.at < 15_000)
            return this.identity.id;
        // Empty machine-id files are readable, so fall back on empty content as well as read failure.
        const identity = await this.transport.exec(`dsh_machine_id="$(cat /etc/machine-id 2>/dev/null)"; if [ -z "$dsh_machine_id" ]; then dsh_machine_id="$(uname -s)"; fi; printf '%s\\0%s\\0%s\\0' "$(uname -n)" "$(id -un)" "$dsh_machine_id"`);
        const [machine, user, unique] = identity.split('\0');
        if (!machine || !user || !unique)
            throw new Error('SSH did not report a valid machine identity');
        const id = `ssh-${createHash('sha256').update(JSON.stringify([machine, user, unique])).digest('hex')}`;
        this.identity = { id, at: Date.now() };
        return id;
    }
    async history(id) {
        let promise = this.histories.get(id);
        if (!promise) {
            const history = new TaskHistory(this.store.directory, id);
            promise = history.open().then(() => history);
            this.histories.set(id, promise);
        }
        return promise;
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
        const output = await this.transport.exec(`cd ${quote(cwd)} && printf '%s\\0' "$(pwd -P)" && ${definitions.map(p => `printf '%s\\0%s\\0' ${quote(p.id)} "$(command -v ${quote(p.command)} 2>/dev/null || true)"`).join(' && ')}`);
        const [canonical, ...parts] = output.split('\0');
        this.assertOpen();
        if (!canonical?.startsWith('/'))
            throw new Error('Remote project does not exist or is not accessible');
        const installed = new Map();
        for (let i = 0; i + 1 < parts.length; i += 2)
            if (parts[i + 1])
                installed.set(parts[i], parts[i + 1]);
        const profiles = new Map();
        const providers = await Promise.all(definitions.map(async (definition) => {
            const path = installed.get(definition.id);
            const unavailable = { id: definition.id, label: definition.label, status: 'unavailable', models: [], modes: [], ...(definition.id === 'antigravity' ? { notice: ANTIGRAVITY_NOTICE } : {}) };
            if (!path)
                return unavailable;
            let peer;
            try {
                const argv = [path, ...definition.args];
                if (definition.protocol === 'antigravity') {
                    const version = await this.transport.exec('node --version');
                    if (Number(version.trim().match(/^v(\d+)/)?.[1] ?? 0) < 22)
                        throw new Error('Antigravity remote control requires Node.js 22 or newer on the SSH host');
                    const models = decodeAntigravityModels(await this.transport.exec(`cd ${quote(canonical)} && ${quote(path)} models`, 40_000));
                    if (!models.length)
                        throw new Error('Antigravity returned no models. Sign in with agy and check agy models on the remote host.');
                    const provider = { ...unavailable, status: 'ready', models, defaultModeId: 'default', modes: [{ id: 'default', label: 'CLI permission settings' }, { id: 'plan', label: 'Plan' }, { id: 'accept-edits', label: 'Accept edits' }, { id: 'auto', label: 'Auto' }] };
                    profiles.set(definition.id, { argv, protocol: definition.protocol, cwd: canonical, provider });
                    return provider;
                }
                const launch = definition.protocol === 'claude' ? [path, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence'] : argv;
                this.assertOpen();
                peer = new JsonlPeer(this.transport.start(canonical, launch));
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
                    modes = [{ id: 'workspace-write', label: 'Workspace write · ask on request' }, { id: 'read-only', label: 'Read only' }, { id: 'full-access', label: 'Full access' }];
                    defaultModeId = 'workspace-write';
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
                profiles.set(definition.id, { argv, protocol: definition.protocol, cwd: canonical, provider });
                return provider;
            }
            catch (error) {
                return { ...unavailable, status: 'error', error: error instanceof Error ? error.message : String(error) };
            }
            finally {
                if (peer) {
                    this.probes.delete(peer);
                    peer.close();
                }
            }
        }));
        this.assertOpen();
        this.catalogs.set(cwd, { at: Date.now(), selection, profiles, providers });
        return structuredClone(providers);
    }
    task(id) {
        const task = this.store.task(t => t.agentId === id && t.hostId === this.host.id);
        if (!task)
            throw new RemoteError('Remote agent not found', 404);
        return task;
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
    async open(task, resume, signal) {
        if (!CLI_PROVIDERS.some(provider => provider.id === task.provider))
            throw new Error('This CLI provider is no longer supported. Saved output remains available.');
        this.sessions.get(task.id)?.close();
        let profile;
        if (resume) {
            if (!task.native)
                throw new Error('No saved native CLI session exists. The task will not be replayed.');
            profile = { protocol: task.native.protocol, argv: task.native.argv, cwd: task.executionCwd ?? task.cwd, provider: { id: task.provider, label: task.provider, status: 'ready', models: [], modes: [] } };
        }
        else {
            await this.providers(task.cwd, false);
            const found = this.catalogs.get(task.cwd)?.profiles.get(task.provider);
            if (!found)
                throw new Error('The selected CLI is not ready on this SSH host');
            profile = found;
        }
        let argv = [...profile.argv];
        if (profile.protocol === 'antigravity')
            argv = antigravityArguments(argv[0], task, resume);
        if (profile.protocol === 'claude')
            argv = [argv[0], '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-prompt-tool', 'stdio', '--model', task.model, ...(resume ? ['--resume', task.native.sessionId] : ['--session-id', randomUUID()]), ...(task.modeId && task.modeId !== 'inherit' ? ['--permission-mode', task.modeId] : []), ...(task.thinkingOptionId ? ['--effort', task.thinkingOptionId] : [])];
        const history = await this.history(task.id);
        // Upload before creating a native session, so a failed upload can be retried safely.
        const attachments = !resume ? await transferAttachments(this.transport, this.store.directory, task.id, task.id, profile.cwd, task.attachments ?? [], signal) : [];
        signal?.throwIfAborted();
        this.assertOpen();
        if ([...this.sessions.values()].filter(s => s.alive).length >= SESSION_LIMIT) {
            const idle = [...this.sessions].find(([id, session]) => !this.starting.has(id) && !this.leases.has(id) && session.evictable);
            if (!idle)
                throw new Error(`This SSH host already has ${SESSION_LIMIT} working CLI sessions. Wait for one to finish, or archive an idle agent.`);
            idle[1].close();
            this.sessions.delete(idle[0]);
        }
        const launch = profile.protocol === 'antigravity' ? ['node', '--input-type=module', '-e', ANTIGRAVITY_RUNNER, '--', ...argv] : argv;
        // A finished turn changed the account's usage; read it again when it is next shown.
        const session = new CliSession(new JsonlPeer(this.transport.start(profile.cwd, launch)), { ...task, executionCwd: profile.cwd }, history, this.store, { turnEnded: () => this.accounts.delete(task.provider) });
        this.sessions.set(task.id, session);
        try {
            await session.initialize(profile.protocol, argv, resume);
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
    async agent(id) {
        const task = this.task(id), session = this.sessions.get(task.id);
        if (session)
            return structuredClone(session.agent);
        return { id, cwd: task.executionCwd ?? task.cwd, provider: task.provider, model: task.model, title: task.title, status: 'closed', pendingPermissions: [], nativeSessionId: task.native?.sessionId, resumable: task.native?.resumable };
    }
    async timeline(id, cursor, direction) { return (await this.history(this.task(id).id)).page(cursor, direction); }
    async messageTimeline(id, messageId, cursor) { return (await this.history(this.task(id).id)).messagePage(messageId, cursor); }
    async reply(id) { return (await this.history(this.task(id).id)).lastReply(); }
    /** The live session, resuming the saved native session when the process is gone. */
    async attached(task) {
        const session = this.sessions.get(task.id);
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
            let session = await this.attached(task);
            if (session.busy) {
                await session.stop();
                session = await this.attached(task);
            }
            const files = await transferAttachments(this.transport, this.store.directory, task.id, messageId, task.executionCwd ?? task.cwd, attachments, signal);
            await session.send(attachmentPrompt(text, files), messageId, files);
        }
        finally {
            release();
        }
    }
    async stop(id) {
        const session = this.sessions.get(this.task(id).id);
        if (session?.alive)
            await session.stop();
    }
    async respond(id, requestId, answer) {
        const session = this.sessions.get(this.task(id).id);
        if (!session?.alive)
            throw new RemoteError('This permission request is no longer pending', 409);
        await session.respond(requestId, answer);
    }
    async detach(task) {
        const session = this.sessions.get(task.id);
        if (!session)
            return;
        if (session.alive && session.busy)
            await session.stop();
        session.close();
        this.sessions.delete(task.id);
    }
    async forget(task) {
        await this.detach(task);
        const history = this.histories.get(task.id) ?? this.history(task.id);
        this.histories.delete(task.id);
        await (await history.catch(() => new TaskHistory(this.store.directory, task.id))).remove();
        await rm(join(this.store.directory, 'attachments', task.id), { recursive: true, force: true });
    }
    async account(provider, cwd, refresh) {
        this.assertOpen();
        const definition = CLI_PROVIDERS.find(p => p.id === provider);
        if (definition?.protocol !== 'codex' && definition?.protocol !== 'claude')
            return null;
        const cached = this.accounts.get(provider);
        if (cached && !refresh && Date.now() - cached.at < ACCOUNT_TTL)
            return cached.value;
        const value = this.readAccount(definition, cwd);
        this.accounts.set(provider, { at: Date.now(), value });
        value.catch(() => { if (this.accounts.get(provider)?.value === value)
            this.accounts.delete(provider); });
        return value;
    }
    /** Ask a running session of this CLI, or briefly start one without a prompt. */
    async readAccount(definition, cwd) {
        const live = [...this.sessions.values()].find(s => s.alive && s.task.provider === definition.id && s.agent.status !== 'initializing');
        if (live)
            return readAccountUsage(live.peer, definition.protocol, live.account);
        const path = await this.transport.exec(`printf '%s' "$(command -v ${quote(definition.command)} 2>/dev/null || true)"`);
        this.assertOpen();
        if (!path.startsWith('/'))
            throw new Error(`${definition.label} is not installed on this SSH host`);
        const argv = definition.protocol === 'claude' ? [path, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence'] : [path, ...definition.args];
        const peer = new JsonlPeer(this.transport.start(cwd ?? await this.homeDirectory(), argv));
        this.probes.add(peer);
        try {
            peer.onMessage(message => { if (message.method && message.id !== undefined)
                peer.send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Usage checks do not execute tools' } }); });
            if (definition.protocol === 'codex') {
                await initializeCodex(peer);
                return await readAccountUsage(peer, 'codex');
            }
            const init = await peer.control({ subtype: 'initialize' });
            return await readAccountUsage(peer, 'claude', init?.account);
        }
        finally {
            this.probes.delete(peer);
            peer.close();
        }
    }
    async close() {
        this.closed = true;
        for (const probe of this.probes)
            probe.close();
        for (const session of this.sessions.values())
            session.close();
        await Promise.allSettled([...this.starting.values()]);
        this.probes.clear();
        this.sessions.clear();
        for (const history of this.histories.values())
            await (await history.catch(() => undefined))?.flush();
    }
}
