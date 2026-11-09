import { SshBackend } from './backend.js';
import { HostConnections } from './host-connections.js';
import { SharedSync } from './shared-sync.js';
import { readSshConfigHosts } from '../core/ssh-config.js';
import { attachmentInput, inputModalitiesOf } from '../core/domain.js';
import { browsePath, busy, enabledProvidersOf, permissionModes, field, identifier, questionsOf, record, RemoteError, sharesSessions, taskInput } from '../core/domain.js';
export class RemoteAgentsService {
    store;
    readSshConfig;
    hostConnections;
    sharedSync;
    /** Told the host whose shared workspaces changed, as reported by its registry; Workspace Tags sync follows them. */
    sharedWorkspaceListeners = new Set();
    /** Told a task whose history another DSH drives after it was brought up to date here; its conversation catches up. */
    sharedHistoryListeners = new Set();
    /** Called with a DSH conversation when how far it has been read changes, here or on another DSH. */
    chatReadListeners = new Set();
    locks = new Map();
    restoring = new Map();
    delegationRecovery = new Map();
    /** DSH's MCP servers and skills for remote CLIs; set once DSH's registries are available. */
    sharing;
    constructor(store, factory, readSshConfig = readSshConfigHosts) {
        this.store = store;
        this.readSshConfig = readSshConfig;
        this.hostConnections = new HostConnections(store, factory ?? (host => new SshBackend(host, store, undefined, () => this.sharing)), (key, action) => this.serial(key, action), (hostId, backend) => this.sharedSync.bind(hostId, backend));
        this.sharedSync = new SharedSync(store, this.hostConnections, {
            workspaces: hostId => { for (const listener of this.sharedWorkspaceListeners)
                listener(hostId); },
            history: taskId => { for (const listener of this.sharedHistoryListeners)
                listener(taskId); },
            read: sessionId => { for (const listener of this.chatReadListeners)
                listener(sessionId); },
        });
    }
    async sshConfig() { return this.readSshConfig(); }
    /** Reuse the agent host's transport and machine-identity checks for workspace operations. */
    async withWorkspace(hostId, verify, action) {
        return this.hostConnections.use(hostId, async (backend) => {
            await verify();
            if (!backend.workspaceFiles)
                throw new RemoteError('Remote workspace files are unavailable on this host', 501);
            return action(backend.workspaceFiles);
        });
    }
    hosts() { return this.hostConnections.hosts(); }
    /** Closed for a plugin reload or DSH shutdown; remote work must not be stopped then. */
    get stopped() { return this.hostConnections.stopped; }
    /** Reattach one saved CLI without making any other saved session connect to its host. */
    restore(task) {
        const pending = this.restoring.get(task.id);
        if (pending)
            return pending;
        const restoring = this.serial(task.id, async () => {
            const backend = this.hostConnections.backend(task.hostId);
            if (task.native) {
                await backend.restore?.(task);
                return;
            }
            // Interrupted before its native session existed: nothing can be resumed, so remove it.
            await backend.detach(task);
        }).catch(error => this.updateTask(task.id, next => { next.error = this.hostConnections.safeError(error); }).catch(() => { })).then(() => { })
            .finally(() => { if (this.restoring.get(task.id) === restoring)
            this.restoring.delete(task.id); });
        this.restoring.set(task.id, restoring);
        return restoring;
    }
    /**
     * Reattach persistent CLIs after a restart and finish queued relay cleanups. Runs in the
     * background: hosts may be offline, and their sessions keep reconnecting until they return.
     * This is deliberately explicit: plugin startup restores only conversations DSH actually opens.
     */
    resume(hostId) {
        const tasks = this.store.tasks(t => !!t.relay && (!hostId || t.hostId === hostId));
        // Sharing hosts list the sessions other DSH instances started, whether or not this one has any.
        for (const host of this.store.hosts())
            if (!this.stopped && (!hostId || host.id === hostId))
                this.hostConnections.backend(host.id).startSharing?.();
        return Promise.allSettled([
            ...tasks.map(task => this.restore(task)),
            ...this.store.hosts().filter(host => !hostId || host.id === hostId).map(host => this.stopped ? undefined : this.hostConnections.backend(host.id).cleanup?.()),
        ]).then(() => { });
    }
    /** Reattach only the remote tasks behind one open DSH conversation; unrelated hosts stay offline. */
    resumeConversation(sessionId) {
        const tasks = this.store.tasks(t => !!t.relay && t.chat?.sessionId === sessionId);
        for (const hostId of new Set(tasks.map(task => task.hostId)))
            if (!this.stopped)
                this.hostConnections.backend(hostId).startSharing?.();
        return Promise.allSettled(tasks.map(task => this.restore(task))).then(() => { });
    }
    /** Shared read state is observational; marking read starts sharing for this conversation only. */
    chatReadMark(sessionId) { return this.sharedSync.chatReadMark(sessionId); }
    async markChatRead(sessionId) { return this.sharedSync.markChatRead(sessionId); }
    /** Observe only this conversation's delegated CLIs, including saved/archived history.
     * Recovery attaches existing relays only; it never starts a new CLI or sends a prompt.
     * Do not use snapshot/resume here: opening one conversation must not connect unrelated hosts.
     */
    async delegations(sessionId) {
        const tasks = this.store.tasks(t => t.origin === 'dsh' && t.owner?.sessionId === sessionId && !t.chat);
        return Promise.all(tasks.map(async (task) => this.observeDelegation(task, await this.live(task))));
    }
    observeDelegation(task, live) {
        const summary = this.summarize(task, live);
        if (!task.relay || !task.native || task.archived || summary.attached || this.stopped)
            return summary;
        const recovery = this.delegationRecovery.get(task.id), now = Date.now();
        // Polls must not repeatedly acquire a shared lease or retry an offline/quota failure.
        // The backend owns reconnecting once attached. A changed relay gets a fresh attempt.
        if (!recovery || recovery.relayId !== task.relay.id || recovery.retryAt <= now) {
            this.delegationRecovery.set(task.id, { relayId: task.relay.id, retryAt: now + 30_000 });
            void this.restore(task);
        }
        return { ...summary, status: task.error ? 'error' : 'starting', reconnecting: true,
            ...(task.error ? { error: this.hostConnections.safeError(task.error) } : {}) };
    }
    onCatalogChange(listener) { return this.hostConnections.onCatalogChange(listener); }
    async discoverHost(hostId) {
        await this.hostConnections.discoverHost(hostId);
        return this.snapshot();
    }
    async setHostProviders(hostId, value) {
        await this.hostConnections.setHostProviders(hostId, value);
        return this.snapshot();
    }
    async snapshot() {
        const tasks = this.store.snapshot().tasks;
        return { hosts: this.hosts(), agents: await Promise.all(tasks.map(async (task) => this.summarize(task, await this.live(task)))) };
    }
    task(id) {
        const task = this.store.task(t => t.id === id);
        if (!task)
            throw new RemoteError('Remote agent not found', 404);
        return task;
    }
    async serial(key, action) {
        const previous = this.locks.get(key) ?? Promise.resolve();
        const next = previous.catch(() => { }).then(action);
        this.locks.set(key, next);
        try {
            return await next;
        }
        finally {
            if (this.locks.get(key) === next)
                this.locks.delete(key);
        }
    }
    /** Local process state; never contacts the SSH host. */
    async live(task) {
        if (!task.agentId || this.stopped)
            return null;
        try {
            return await this.hostConnections.backend(task.hostId).agent(task.agentId);
        }
        catch {
            return null;
        }
    }
    summarize(task, live) {
        const pending = live?.pendingPermissions.length ?? 0;
        const resumable = live?.resumable ?? task.native?.resumable;
        // A creation record without an in-flight request was interrupted, for example by a DSH restart.
        const status = task.state === 'creating' && this.locks.has(task.id) ? 'starting'
            : !task.agentId ? 'error'
                : pending ? 'attention'
                    : live && (live.status === 'running' || live.status === 'initializing' || live.activeTurn) ? 'running'
                        : live?.status === 'error' ? 'error'
                            : live?.status === 'closed' && resumable === false ? 'closed' : 'idle';
        const error = status === 'error' ? live?.lastError ?? task.error ?? 'Starting this agent was interrupted. Retry to finish starting it.'
            : status === 'closed' || (status === 'idle' && live?.lastError) ? live?.lastError : undefined;
        const controller = this.stopped ? undefined : this.hostConnections.peek(task.hostId)?.controller?.(task.id);
        return {
            id: task.id, hostId: task.hostId, cwd: task.executionCwd ?? task.cwd, provider: task.provider, model: task.model,
            ...(task.chat ? { chatSessionId: task.chat.sessionId } : {}),
            ...(task.owner ? { ownerSessionId: task.owner.sessionId } : {}),
            ...(task.modeId ? { modeId: task.modeId } : {}), ...(task.thinkingOptionId ? { thinkingOptionId: task.thinkingOptionId } : {}),
            ...(task.serviceTier ? { serviceTier: task.serviceTier } : {}),
            modes: permissionModes(task.provider, task.modes ?? []), title: task.title, createdAt: task.createdAt, updatedAt: task.updatedAt ?? task.createdAt,
            archived: task.archived === true, delegated: task.origin === 'dsh', started: !!task.agentId, attached: !!live && live.status !== 'closed', status, pendingPermissions: pending,
            ...(status === 'running' && live?.activeTurn?.unprompted ? { unprompted: true } : {}),
            ...(error ? { error } : {}), ...(resumable !== undefined ? { resumable } : {}), ...(task.native?.sessionId ? { nativeSessionId: task.native.sessionId } : {}),
            ...(live?.persistent ? { persistent: true } : {}), ...(live?.reconnecting && live.status !== 'closed' ? { reconnecting: true } : {}),
            ...(task.shared?.imported && task.shared.creator ? { creator: task.shared.creator } : {}), ...(controller ? { controller } : {}),
        };
    }
    async summary(id) { const task = this.task(id); return this.summarize(task, await this.live(task)); }
    /** One directory level on a verified host; `path` defaults to the remote home. */
    async browse(hostId, path, options = {}) {
        const target = path === undefined ? undefined : browsePath(path);
        return this.hostConnections.use(hostId, async (backend) => {
            if (!backend.listDirectory)
                throw new RemoteError('This host cannot browse directories', 501);
            return backend.listDirectory(target, options);
        });
    }
    async addHost(input, options = {}) {
        const hostId = await this.hostConnections.addHost(input);
        if (options.discoverModels)
            return this.discoverHost(hostId);
        return this.snapshot();
    }
    /** `everywhere` also deletes a shared host's sessions for the other DSH instances. */
    async removeHost(id, options = {}) {
        return this.serial(`catalog:${id}`, async () => {
            this.hostConnections.host(id);
            // Forget local sessions and output without probing an unreachable SSH host. Shared sessions stay on the host
            // for the other DSH instances, and their CLIs keep running, unless deleted everywhere, which needs the host.
            const shared = sharesSessions(this.hostConnections.host(id)) && this.store.tasks(t => t.hostId === id).length > 0;
            if (options.deleteAgents && options.everywhere && shared && !await this.hostConnections.backend(id).sharingReachable?.(10_000)) {
                throw new RemoteError('Connect to this machine to delete its sessions in every DSH, or remove it from this DSH only.', 409);
            }
            if (options.deleteAgents)
                for (const task of this.store.snapshot().tasks.filter(t => t.hostId === id)) {
                    if (sharesSessions(this.hostConnections.host(id)) && !options.everywhere)
                        await this.forgetLocal(task.id);
                    else
                        await this.delete(task.id);
                }
            // Give queued relay removals a short chance; an offline host never blocks removing it.
            const queued = this.hostConnections.peek(id)?.cleanup?.();
            if (queued)
                await Promise.race([queued, new Promise(resolve => setTimeout(resolve, 5000).unref())]);
            await this.store.update(state => {
                // A concurrently created session still requires confirmation on the next attempt.
                if (state.tasks.some(t => t.hostId === id))
                    throw new RemoteError('Delete this host’s agents, including archived ones, before removing it', 409);
                state.hosts = state.hosts.filter(h => h.id !== id);
                state.mainChatProjects = state.mainChatProjects?.filter(p => p.hostId !== id);
                state.relayCleanups = state.relayCleanups?.filter(c => c.hostId !== id);
                if (!state.relayCleanups?.length)
                    delete state.relayCleanups;
                state.sharedDeletions = state.sharedDeletions?.filter(d => d.hostId !== id);
                if (!state.sharedDeletions?.length)
                    delete state.sharedDeletions;
                delete state.seenWorkspaces?.[id];
            });
            await this.hostConnections.release(id);
            this.sharing?.forget(id);
            this.hostConnections.catalogChanged();
            return this.snapshot();
        });
    }
    /** Share this host's sessions and workspaces with other DSH instances, or stop. CLIs keep running either way. */
    async setHostSharing(hostId, share) {
        if (typeof share !== 'boolean')
            throw new RemoteError('Invalid sharing setting');
        await this.serial(`catalog:${hostId}`, async () => {
            if (sharesSessions(this.hostConnections.host(hostId)) === share)
                return;
            if (!share) {
                // Sessions started here are withdrawn, so the other DSH instances stop showing them; this DSH keeps them.
                await this.hostConnections.backend(hostId).withdrawSharing?.(this.store.tasks(t => t.hostId === hostId && !t.shared?.imported).map(t => t.id));
                // Copies of sessions other DSH instances started are theirs.
                for (const task of this.store.tasks(t => t.hostId === hostId && !!t.shared?.imported))
                    await this.forgetLocal(task.id);
            }
            await this.store.update(state => {
                const host = state.hosts.find(h => h.id === hostId);
                if (!host)
                    throw new RemoteError('Remote host was removed', 409);
                if (share)
                    delete host.share;
                else
                    host.share = false;
                if (!share)
                    delete state.seenWorkspaces?.[hostId];
            });
            // A new backend starts or stops sharing, and reattaches the CLIs the old one released.
            await this.hostConnections.release(hostId);
            void this.resume(hostId);
        });
        return this.snapshot();
    }
    async forgetLocal(id) {
        return this.serial(id, async () => {
            const task = this.task(id), backend = this.hostConnections.backend(task.hostId);
            if (backend.forgetLocal)
                await backend.forgetLocal(task);
            else
                await backend.forget(task);
            await this.store.update(state => { state.tasks = state.tasks.filter(t => t.id !== id); });
        });
    }
    /** Shared workspaces not yet offered to this DSH. */
    async sharedWorkspaces(hostId) { return this.sharedSync.sharedWorkspaces(hostId); }
    async seeWorkspaces(hostId, paths) { return this.sharedSync.seeWorkspaces(hostId, paths); }
    async sharedWorkspaceList(hostId, timeout = 3000) { return this.sharedSync.sharedWorkspaceList(hostId, timeout); }
    async setWorkspaceTags(hostId, path, tags) { return this.sharedSync.setWorkspaceTags(hostId, path, tags); }
    async shareWorkspace(hostId, path) { return this.sharedSync.shareWorkspace(hostId, path); }
    async connect(hostId) {
        await this.hostConnections.use(hostId, async () => { });
        return this.snapshot();
    }
    async providers(hostId, cwd, refresh = false) { return this.hostConnections.use(hostId, backend => backend.providers(cwd, refresh)); }
    async updateTask(id, update) {
        await this.store.update(state => {
            const task = state.tasks.find(t => t.id === id);
            if (!task)
                throw new RemoteError('Remote agent not found', 404);
            update(task);
        });
        return this.task(id);
    }
    async create(input, options = {}) {
        const request = taskInput(input);
        const title = options.title === undefined ? request.prompt.replace(/\s+/g, ' ').slice(0, 80) : field(options.title, 'title', 100);
        return this.serial(request.id, async () => {
            const existing = this.store.task(t => t.id === request.id);
            if (existing) {
                if (JSON.stringify(taskInput(existing)) !== JSON.stringify(request))
                    throw new RemoteError('This request ID belongs to a different agent', 409);
                return existing.agentId ? this.summary(existing.id) : this.launch(existing, options.signal, options.beforeStart);
            }
            return this.hostConnections.use(request.hostId, async (backend, host) => {
                if (!enabledProvidersOf(host).includes(request.provider))
                    throw new RemoteError('This CLI is disabled on this machine. Enable it in Settings → Remote agents.', 409);
                // Probe only the target CLI here; launching the other enabled CLIs to list their models is what made starting slow.
                const provider = await backend.target(request.cwd, request.provider);
                if (provider.status !== 'ready')
                    throw new RemoteError('The selected CLI is not ready in this remote project', 409);
                const model = provider.models.find(m => m.id === request.model);
                if (!model)
                    throw new RemoteError('The selected model is unavailable on this host', 409);
                if (request.attachments?.some(a => a.kind === 'image') && !inputModalitiesOf(provider.id, model).includes('image'))
                    throw new RemoteError('This remote CLI does not support image input');
                if (request.modeId && !permissionModes(provider.id, provider.modes).some(m => m.id === request.modeId))
                    throw new RemoteError('The selected mode is unavailable', 409);
                if (request.thinkingOptionId && !model.thinkingOptions?.some(m => m.id === request.thinkingOptionId))
                    throw new RemoteError('The selected thinking level is unavailable', 409);
                if (request.serviceTier && !model.serviceTiers?.some(t => t.id === request.serviceTier))
                    throw new RemoteError('The selected speed is unavailable', 409);
                await options.beforeStart?.();
                const now = new Date().toISOString();
                const task = { ...request, serverId: host.serverId, title, createdAt: now, updatedAt: now, modes: provider.modes, ...(options.origin ? { origin: options.origin } : {}), ...(options.chat ? { chat: options.chat } : {}), ...(options.owner ? { owner: options.owner } : {}), ...(options.unattended ? { unattended: true } : {}), state: 'creating' };
                // Persist the exact execution intent and idempotency key before any remote mutation.
                await this.store.update(state => {
                    if (!state.hosts.some(h => h.id === task.hostId && h.serverId === task.serverId))
                        throw new RemoteError('Remote host binding changed', 409);
                    if (state.tasks.length >= 1000)
                        throw new RemoteError('The remote agent registry is full. Delete archived agents first.');
                    state.tasks.push(task);
                });
                return this.launch(task, options.signal, options.beforeStart);
            });
        });
    }
    /** Retry an interrupted start, or reattach a stopped session without replaying anything. */
    async retry(id, signal) {
        const task = this.task(id);
        if (!task.agentId)
            return this.create(taskInput(task), { signal });
        return this.serial(id, () => this.hostConnections.use(task.hostId, async (backend) => {
            const agent = await backend.recover(this.task(id), signal);
            this.assertAgent(task, agent);
            await this.updateTask(id, next => { next.state = 'ready'; delete next.error; });
            return this.summary(id);
        }, task.serverId));
    }
    async launch(task, signal, beforeStart) {
        try {
            await this.hostConnections.use(task.hostId, async (backend) => {
                await beforeStart?.();
                const agent = await backend.create(task, signal);
                if (agent.provider !== task.provider)
                    throw new Error('Created agent provider does not match the request');
                await this.updateTask(task.id, next => { next.agentId = agent.id; next.executionCwd = agent.cwd; next.state = 'ready'; delete next.error; });
            }, task.serverId);
        }
        catch (error) {
            // Keep the agent address available to the UI for an idempotent retry.
            await this.updateTask(task.id, next => { next.state = 'uncertain'; next.error = this.hostConnections.safeError(error); });
        }
        return this.summary(task.id);
    }
    assertAgent(task, agent) {
        if (!agent)
            throw new RemoteError('The remote agent no longer exists', 404);
        if (agent.cwd !== (task.executionCwd ?? task.cwd) || agent.provider !== task.provider)
            throw new RemoteError('Remote agent identity or project changed', 409);
    }
    async state(id) {
        const task = this.task(id), live = await this.live(task);
        return { agent: this.summarize(task, live), permissions: live?.pendingPermissions ?? [] };
    }
    /** Saved output stays readable while the SSH host is offline. */
    async detail(id, cursor, direction) {
        const task = this.task(id);
        // Viewing a panel agent opts into its relay recovery; offline history remains immediately readable.
        const delegated = task.origin === 'dsh' && !!task.owner && !task.chat;
        if (!delegated && task.relay && !task.archived)
            void this.restore(task);
        const live = await this.live(task);
        if (live)
            this.assertAgent(task, live);
        const timeline = task.agentId ? await this.hostConnections.backend(task.hostId).timeline(task.agentId, cursor, direction) : null;
        return { agent: delegated ? this.observeDelegation(task, live) : this.summarize(task, live), permissions: live?.pendingPermissions ?? [], timeline };
    }
    /** Saved output only: nothing is restored or attached, so reading many sessions never connects their relays. */
    async timeline(id, cursor, direction) {
        const task = this.task(id);
        return task.agentId ? this.hostConnections.backend(task.hostId).timeline(task.agentId, cursor, direction) : null;
    }
    /** Identify the DSH that sent a shared message without opening a connection. */
    sender(hostId, instance, label) { return this.sharedSync.sender(hostId, instance, label); }
    async reply(id) {
        const task = this.task(id);
        return task.agentId ? this.hostConnections.backend(task.hostId).reply(task.agentId) : '';
    }
    async messageTimeline(id, messageId, cursor) {
        const task = this.task(id);
        if (!task.agentId)
            throw new RemoteError('Remote agent is not ready', 409);
        return this.hostConnections.backend(task.hostId).messageTimeline(task.agentId, messageId, cursor);
    }
    async setThinking(id, thinkingOptionId) {
        return this.serial(id, async () => {
            const task = this.task(id);
            if (task.thinkingOptionId === thinkingOptionId)
                return;
            if (busy(await this.summary(id)))
                throw new RemoteError('Stop the agent before changing its thinking level', 409);
            if (task.native?.resumable === false)
                throw new RemoteError('This CLI cannot resume with a different thinking level', 409);
            if (task.agentId)
                await this.hostConnections.backend(task.hostId).detach(task);
            await this.updateTask(id, next => { next.thinkingOptionId = thinkingOptionId; });
        });
    }
    /** Change a model or speed by resuming the same native session. Existing receipts keep their original namespace. */
    async setModel(id, model, thinkingOptionId, route, serviceTier) {
        return this.serial(id, async () => {
            const task = this.task(id);
            if (task.model === model && task.thinkingOptionId === thinkingOptionId && task.serviceTier === serviceTier)
                return;
            if (busy(await this.summary(id)))
                throw new RemoteError('Stop the agent before changing its model', 409);
            if (task.native?.resumable === false)
                throw new RemoteError('This CLI cannot resume with a different model. Start a new conversation.', 409);
            await this.hostConnections.use(task.hostId, async (backend) => {
                const provider = (await backend.providers(task.cwd, false)).find(p => p.id === task.provider && p.status === 'ready');
                const selected = provider?.models.find(m => m.id === model);
                if (!selected)
                    throw new RemoteError('The selected model is unavailable on this host', 409);
                if (thinkingOptionId && !selected.thinkingOptions?.some(e => e.id === thinkingOptionId))
                    throw new RemoteError('The selected thinking level is unavailable', 409);
                if (serviceTier && !selected.serviceTiers?.some(t => t.id === serviceTier))
                    throw new RemoteError('The selected speed is unavailable', 409);
                if (task.agentId)
                    await backend.detach(task);
                await this.updateTask(id, next => {
                    next.model = model;
                    next.thinkingOptionId = thinkingOptionId;
                    next.serviceTier = serviceTier;
                    if (next.chat && route) {
                        next.chat.receiptRoute ??= next.chat.route;
                        next.chat.route = route;
                    }
                });
            }, task.serverId);
        });
    }
    /** Context comes from local state; only plan limits are read from the SSH host, and they are cached. */
    async usage(sessionId, options = {}) {
        const cli = (route) => route.split('/').slice(0, 2).join('/');
        const task = this.store.tasks(t => t.chat?.sessionId === sessionId && (!options.route || cli(t.chat.route) === cli(options.route)))
            .sort((a, b) => (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt))[0];
        const target = task ? { hostId: task.hostId, provider: task.provider } : options.target;
        if (!target)
            return null;
        const live = task ? await this.live(task) : undefined;
        const tokenUsage = live && live.status !== 'closed' ? live.tokenUsage : live?.tokenUsage ?? task?.tokenUsage;
        const report = { provider: target.provider, context: live?.context ?? task?.context ?? null, ...(tokenUsage ? { tokenUsage } : {}) };
        if (!options.account)
            return report;
        try {
            const account = await this.hostConnections.use(target.hostId, backend => backend.account(target.provider, task ? task.executionCwd ?? task.cwd : undefined, options.refresh === true), task?.serverId);
            if (account)
                report.account = account;
        }
        catch (error) {
            report.account = { provider: target.provider, windows: [], checkedAt: new Date().toISOString(), error: this.hostConnections.safeError(error) };
        }
        return report;
    }
    async rename(id, title) {
        return this.serial(id, async () => {
            await this.updateTask(id, next => { next.title = field(title, 'title', 100); });
            return this.summary(id);
        });
    }
    async send(id, input, options = {}) {
        const value = record(input), messageId = identifier(value.id), text = field(value.text, 'message', 100_000);
        const attachments = value.attachments === undefined ? undefined : attachmentInput(value.attachments);
        return this.serial(id, async () => {
            const task = this.task(id);
            if (!task.agentId)
                throw new RemoteError('Retry starting this agent before sending a message', 409);
            if ((await this.messageTimeline(id, messageId)).found)
                return this.summary(id);
            if (options.interrupt === false && busy(await this.summary(id)))
                throw new RemoteError('This agent is still working. Wait for it, or interrupt it to send now.', 409);
            return this.hostConnections.use(task.hostId, async (backend) => {
                const live = await backend.agent(task.agentId);
                this.assertAgent(task, live);
                if (live.status === 'closed' && (live.resumable ?? task.native?.resumable) === false)
                    throw new RemoteError('This CLI session has ended and cannot be resumed. Its output is kept.', 409);
                // Messaging an archived agent brings it back, as in Paseo.
                await this.updateTask(id, next => { next.updatedAt = new Date().toISOString(); delete next.archived; });
                await backend.send(task.agentId, text, messageId, attachments, options.signal);
                return this.summary(id);
            }, task.serverId);
        });
    }
    async stop(id) {
        return this.serial(id, async () => {
            const task = this.task(id);
            if (!task.agentId)
                return;
            const backend = this.hostConnections.backend(task.hostId);
            this.assertAgent(task, await backend.agent(task.agentId));
            // Interrupting uses the already-open SSH pipe; it must work while the host is otherwise unreachable.
            await backend.stop(task.agentId);
        });
    }
    async respond(id, requestId, input) {
        return this.serial(id, async () => {
            const task = this.task(id), value = record(input);
            if (!task.agentId)
                throw new RemoteError('Remote agent is not ready', 409);
            if (value.behavior !== 'allow' && value.behavior !== 'deny')
                throw new RemoteError('Invalid permission response');
            const answer = { behavior: value.behavior };
            if (value.selectedActionId !== undefined)
                answer.selectedActionId = field(value.selectedActionId, 'permission action', 500);
            if (value.message !== undefined)
                answer.message = field(value.message, 'permission message', 10_000);
            if (value.answers !== undefined) {
                const answers = record(value.answers);
                if (Object.values(answers).some(v => typeof v !== 'string' || v.length > 10_000))
                    throw new RemoteError('Invalid question answers');
                answer.answers = answers;
            }
            const backend = this.hostConnections.backend(task.hostId);
            const agent = await backend.agent(task.agentId);
            this.assertAgent(task, agent);
            const permission = agent.pendingPermissions.find(p => p.id === requestId);
            if (!permission)
                throw new RemoteError('This permission request is no longer pending', 409);
            if (permission.actions?.length && answer.behavior === 'allow' && !answer.selectedActionId)
                throw new RemoteError('Select one of the available permission actions');
            if (answer.selectedActionId && !permission.actions?.some(a => a.id === answer.selectedActionId && a.behavior === answer.behavior))
                throw new RemoteError('Invalid permission action');
            if (permission.kind === 'question' && answer.behavior === 'allow' && !permission.actions?.length) {
                const questions = questionsOf(permission.input);
                if (!questions.length)
                    throw new RemoteError('This CLI returned an unsupported question format');
                if (questions.some(q => !Object.hasOwn(answer.answers ?? {}, q.header) || (!q.optional && !answer.answers?.[q.header]?.trim())))
                    throw new RemoteError('Answer every required question');
                const allowed = new Set(questions.map(q => q.header));
                if (Object.keys(answer.answers ?? {}).some(key => !allowed.has(key)))
                    throw new RemoteError('Unknown question answer');
            }
            await backend.respond(agent.id, permission.id, answer, permission.input);
        });
    }
    /** Archives every session working in a remote folder or below it, as when a worktree is removed. */
    async archiveSessionsIn(hostId, folder) {
        const prefix = folder.endsWith('/') ? folder : `${folder}/`;
        for (const task of this.store.tasks(t => t.hostId === hostId && !t.archived && (t.cwd === folder || t.cwd.startsWith(prefix)))) {
            await this.archive(task.id).catch(() => { });
        }
    }
    /** Soft delete: interrupt, release the CLI process and hide the agent. Output and the native session are kept. */
    async archive(id, archived = true, options = {}) {
        return this.serial(id, async () => {
            const task = this.task(id);
            // A history row can become active between a dashboard poll and a bulk archive.
            if (archived && options.onlyIdle) {
                const latest = await this.summary(id);
                if (busy(latest) || latest.status === 'error')
                    throw new RemoteError('This session is active. Refresh before archiving.', 409);
            }
            if (archived)
                await this.hostConnections.backend(task.hostId).detach(task);
            await this.updateTask(id, next => { if (archived)
                next.archived = true;
            else
                delete next.archived; });
            return this.summary(id);
        });
    }
    /**
     * Ends an idle CLI's process on its host; the session itself stays and its next message resumes it. A finished
     * subagent would otherwise hold one of the account's relay slots until someone archives it.
     */
    async release(id) {
        return this.serial(id, async () => {
            const task = this.task(id);
            if (!task.agentId || task.native?.resumable === false)
                return;
            const live = await this.live(task);
            if (live && busy(this.summarize(task, live)))
                return;
            await this.hostConnections.backend(task.hostId).detach(task);
        });
    }
    async delete(id) {
        return this.serial(id, async () => {
            const task = this.task(id);
            await this.hostConnections.backend(task.hostId).forget(task);
            await this.store.update(state => { state.tasks = state.tasks.filter(t => t.id !== id); });
        });
    }
    /** Applies from the next message: the idle session is released and resumed with the new mode. */
    async setMode(id, modeId) {
        return this.serial(id, async () => {
            const task = this.task(id);
            if (!permissionModes(task.provider, task.modes ?? []).some(m => m.id === modeId))
                throw new RemoteError('This mode is not available for this agent', 409);
            if (task.modeId === modeId)
                return this.summary(id);
            const live = await this.live(task);
            if (live && busy(this.summarize(task, live)))
                throw new RemoteError('Stop the agent before changing its mode', 409);
            if (live && live.status !== 'closed' && task.native?.resumable === false)
                throw new RemoteError('This CLI cannot resume its session, so its mode cannot change', 409);
            if (task.agentId)
                await this.hostConnections.backend(task.hostId).detach(task);
            await this.updateTask(id, next => { next.modeId = modeId; });
            return this.summary(id);
        });
    }
    async close() {
        await this.hostConnections.closeBackends();
        // Let in-flight mutations persist their final receipt before a plugin reload opens state.
        await Promise.allSettled([...this.locks.values()]);
        this.hostConnections.clear();
        this.delegationRecovery.clear();
        await this.store.flush();
    }
}
