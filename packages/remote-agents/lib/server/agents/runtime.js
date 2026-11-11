import { ClaudeGoalOrigins, legacyClaudeVersion } from '../chat/claude-goal-origin.js';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { CHAT_IMAGE_LIMIT, CHAT_IMAGES, chatImageName, imageExtensionOf, viewedImageExtension, viewedImagePath, writeChatImage } from '../chat/images.js';
import { list, questionsOf } from '../core/domain.js';
import { initializeCodex } from '../core/codex.js';
import { RelayExit, RelayReleased } from './relay.js';
import { configureAcpSession } from './acp.js';
import { acpTurnUsage, claudeMessageTokens, claudeModelUsage, claudeTokenUsage, claudeTurnUsage, codexContext, codexTokenUsage, codexTotalBefore, codexTurnUsage, contextUsage } from '../core/usage.js';
/** The file name an image is shown with, from the remote path it was read from. */
const imageName = (path) => typeof path === 'string' ? path.split(/[\\/]/).pop() ?? '' : '';
const contentText = (content) => typeof content === 'string' ? content : list(content).map(c => c?.text ?? c?.content?.text ?? '').join('\n');
/** Claude result errors are string[], unlike assistant/tool content blocks. */
const claudeResultError = (message) => {
    const errors = typeof message.errors === 'string' ? message.errors
        : list(message.errors).map(error => typeof error === 'string' ? error : contentText([error])).filter(Boolean).join('\n');
    const error = typeof message.error === 'string' ? message.error : message.error?.message;
    return errors || (typeof error === 'string' && error) || contentText(message.result) || 'Claude turn failed';
};
export async function initializeAcp(peer) {
    const result = await peer.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'dsh-remote-agents', version: '0.1.0' } });
    if (result?.protocolVersion !== 1)
        throw new Error(`Unsupported ACP protocol version: ${result?.protocolVersion}. This client supports ACP v1.`);
    return result;
}
/** Input IDs a relay deduplicates; replies to one request can never be delivered twice. */
const inputId = (kind, key) => `${kind}-${createHash('sha256').update(key).digest('hex').slice(0, 32)}`;
/** Prompt request IDs are derived from the message, so a response is recognized after any restart. */
const promptRequestId = (messageId) => `dsh-prompt-${messageId}`;
export class CliSession {
    peer;
    task;
    history;
    store;
    hooks;
    relay;
    agent;
    /** Claude's signed-in account from `initialize`, used to label its plan limits. */
    account;
    nativeId = '';
    savedUsage = '';
    activeMessage;
    goalIdentity;
    goalOrigins;
    claudeInputUuid;
    claudeUuidSupported = false;
    claudeLegacy = false;
    confirmed = false;
    partialText = false;
    /** The model Claude's main thread answered with this turn: aliases such as `opus` resolve to a full model ID. */
    turnModel;
    /** Codex's running thread totals, as last reported. */
    codexTotal;
    /**
     * Where the open Codex turn began in those totals; unset until known. A session that attaches after the turn began, as
     * after DSH restarts, does not know the thread's totals then, and must not count the whole thread as this turn.
     */
    codexStart;
    suspended = true;
    intentionalClose = false;
    diskFailed = false;
    admitting = false;
    stopping = false;
    released = false;
    endedSent = false;
    restoring = false;
    imageInput = false;
    /** Background tasks Claude reported finished while idle; they head the turn it starts for them. */
    notices = [];
    /** Items produced by the output line being processed, saved together with its relay offset. */
    batch;
    /** Images in that line's tool results, saved before its items so a chat reading them finds the files. */
    viewed;
    permissions = new Map();
    tools = new Map();
    stopWaiters = new Set();
    constructor(peer, task, history, store, hooks = {}, relay) {
        this.peer = peer;
        this.task = task;
        this.history = history;
        this.store = store;
        this.hooks = hooks;
        this.relay = relay;
        this.agent = { id: task.agentId ?? task.id, cwd: task.executionCwd ?? task.cwd, provider: task.provider, model: task.model, title: task.title, status: 'initializing', pendingPermissions: [], ...(task.context ? { context: { ...task.context } } : {}), ...(task.tokenUsage ? { tokenUsage: structuredClone(task.tokenUsage) } : {}), ...(relay ? { persistent: true } : {}) };
        this.savedUsage = JSON.stringify([task.context, task.tokenUsage]);
        peer.onMessage((message, frame) => this.frame(message, frame));
        peer.onExit(error => {
            if (this.released)
                return;
            if (error instanceof RelayReleased && !this.intentionalClose) {
                // Another DSH took over the relay; leave the turn to it.
                this.released = true;
                this.agent.status = 'closed';
                this.agent.reconnecting = false;
                this.agent.lastError = error.message;
                return;
            }
            if (error instanceof RelayExit && error.exit.reason === 'idle-timeout' && !this.busy) {
                this.intentionalClose = true;
                this.agent.status = 'closed';
            }
            if (!this.intentionalClose)
                this.fail(error);
            this.ended();
        });
    }
    get alive() { return this.peer.alive && !this.released; }
    /** Disconnected on purpose, leaving the CLI running for DSH to reattach later or for another DSH. */
    get detached() { return this.released; }
    /** A turn, approval or message admission is in progress. */
    get busy() { return this.admitting || this.agent.status === 'running' || this.agent.status === 'initializing' || !!this.agent.activeTurn || this.agent.pendingPermissions.length > 0; }
    /** Only sessions that can be resumed later may be closed to free a connection slot. */
    get evictable() { return this.alive && this.agent.resumable === true && !this.busy; }
    append(item) {
        if (this.diskFailed || this.restoring)
            return;
        const turnId = this.agent.activeTurn?.turnId;
        if (this.batch) {
            this.batch.push({ item, turnId });
            return;
        }
        void this.history.append(item, turnId, this.position()).catch(error => this.diskFailure(error));
    }
    diskFailure(error) {
        this.diskFailed = true;
        this.agent.status = 'error';
        this.agent.lastError = `Could not save task history: ${String(error)}`;
        // Keep a relay running: its output is read again from the last saved position.
        if (this.relay)
            this.release();
        else
            this.peer.close();
    }
    position(at = this.peer.position) { return this.relay ? { id: this.relay.id, at, ...(this.partialText ? { partial: true } : {}) } : undefined; }
    /** Process one output line; its history items are saved in one write with the offset after it. */
    frame(message, frame) {
        this.batch = [];
        this.viewed = [];
        try {
            this.message(message);
        }
        catch (error) {
            this.fail(error);
        }
        finally {
            const items = this.batch, images = this.viewed;
            this.batch = undefined;
            this.viewed = undefined;
            // An image that cannot be saved is not shown; the history is still written.
            const save = images.length ? async () => { for (const { file, data } of images)
                await writeChatImage(join(this.store.directory, CHAT_IMAGES), file, data).catch(() => { }); } : undefined;
            if (items.length && !this.diskFailed)
                void this.history.appendBatch(items, this.position(frame.end), save).catch(error => this.diskFailure(error));
        }
    }
    /**
     * Queue an image's base64 bytes to be saved with this output line, and return its copy's name; undefined when the chat
     * cannot show it. The bytes stay out of the history, which other DSHs copy: it records only the name.
     */
    keepImage(encoded, mediaType) {
        if (!this.viewed || typeof encoded !== 'string' || !encoded || encoded.length * 0.75 > CHAT_IMAGE_LIMIT)
            return;
        const data = Buffer.from(encoded, 'base64'), extension = viewedImageExtension(mediaType) ?? imageExtensionOf(data);
        if (!data.length || !extension)
            return;
        const file = chatImageName(data, extension);
        if (!this.viewed.some(v => v.file === file))
            this.viewed.push({ file, data });
        return file;
    }
    /**
     * The images in a tool's output, as Claude (`source`) or MCP (`data`, `mimeType`) image blocks, such as a screenshot
     * it read. `path` is the remote file the tool read, when it names one, for a DSH without the copy.
     */
    toolImages(content, path, name = imageName(path)) {
        const images = [];
        for (const block of list(content)) {
            if (block?.type !== 'image')
                continue;
            const file = block.source ? (block.source.type === 'base64' ? this.keepImage(block.source.data, block.source.media_type) : undefined) : this.keepImage(block.data, block.mimeType);
            if (file)
                images.push({ file, ...(viewedImagePath(path) ? { path } : {}), name });
        }
        return images;
    }
    write(message, id) { this.peer.send(message, this.relay ? id : undefined); }
    /** `mcpServers` are DSH's shared servers in ACP's stdio form; other protocols receive them as launch options. */
    async initialize(protocol, argv, resume = false, mcpServers = [], goalIdentity) {
        this.goalIdentity = goalIdentity;
        this.agent.resumable = protocol !== 'acp';
        if (protocol === 'codex') {
            // Stop needs the background terminal calls, which Codex only accepts from a client asking for experimental ones.
            await initializeCodex(this.peer, { experimentalApi: true });
            const mode = this.task.modeId ?? 'workspace-write';
            // Without a selected tier, Codex applies its configured one; a resumed thread does not restore an earlier tier.
            // Auto review routes approval requests to Codex's reviewer subagent; other modes route them back to the user,
            // since a resumed thread keeps the reviewer it last had. Codex releases without a reviewer ignore the field.
            const reviewer = mode === 'auto-review' ? 'auto_review' : 'user';
            // An unattended task never asks: Codex works inside its sandbox and reports what it could not do.
            const never = mode === 'full-access' || this.task.unattended === true;
            const policy = mode === 'inherit' ? (never ? { approvalPolicy: 'never' } : {}) : { approvalPolicy: never ? 'never' : 'on-request', sandbox: mode === 'read-only' ? 'read-only' : mode === 'full-access' ? 'danger-full-access' : 'workspace-write', approvalsReviewer: reviewer };
            const params = { cwd: this.agent.cwd, model: this.task.model, ...(this.task.serviceTier ? { serviceTier: this.task.serviceTier } : {}), ...policy };
            let response;
            const method = resume ? 'thread/resume' : 'thread/start';
            const binding = resume ? { threadId: this.task.native.sessionId } : {};
            try {
                response = await this.peer.request(method, { ...params, ...binding });
            }
            catch (error) {
                if (mode === 'inherit' || !/unknown variant|invalid.*(?:sandbox|approval)/i.test(String(error)))
                    throw error;
                // Older releases spell enums in camelCase and name the reviewer `guardian_subagent`.
                response = await this.peer.request(method, { ...params, ...binding, approvalPolicy: never ? 'never' : 'onRequest', sandbox: mode === 'read-only' ? 'readOnly' : mode === 'full-access' ? 'dangerFullAccess' : 'workspaceWrite',
                    approvalsReviewer: reviewer === 'auto_review' ? 'guardian_subagent' : reviewer });
            }
            this.nativeId = response?.thread?.id;
        }
        else if (protocol === 'acp') {
            const capabilities = await initializeAcp(this.peer);
            this.imageInput = capabilities.agentCapabilities?.promptCapabilities?.image === true;
            const resumeMethod = capabilities.agentCapabilities?.loadSession ? 'session/load'
                : capabilities.agentCapabilities?.sessionCapabilities?.resume ? 'session/resume' : undefined;
            this.agent.resumable = !!resumeMethod;
            if (resume && !resumeMethod)
                throw new Error('This ACP CLI cannot resume sessions. The saved task history remains available.');
            const response = await this.peer.request(resume ? resumeMethod : 'session/new', { cwd: this.agent.cwd, mcpServers, ...(resume ? { sessionId: this.task.native.sessionId } : {}) });
            this.nativeId = resume ? this.task.native.sessionId : response?.sessionId;
            await configureAcpSession(this.peer, this.nativeId, this.task, response);
        }
        else {
            this.nativeId = this.task.native?.sessionId ?? argv[argv.indexOf('--session-id') + 1];
            if (goalIdentity)
                await this.openGoalOrigins();
            this.account = (await this.peer.control({ subtype: 'initialize' }))?.account;
        }
        if (typeof this.nativeId !== 'string' || !this.nativeId)
            throw new Error('Remote CLI did not return a native session ID');
        await this.store.update(state => {
            const task = state.tasks.find(t => t.id === this.task.id);
            task.agentId = this.agent.id;
            task.executionCwd = this.agent.cwd;
            task.native = { protocol, sessionId: this.nativeId, argv, resumable: this.agent.resumable, initialSent: task.native?.initialSent ?? false, ...(this.imageInput ? { imageInput: true } : {}) };
        });
        this.agent.nativeSessionId = this.nativeId;
        this.agent.status = 'idle';
        this.suspended = false;
        if (protocol === 'claude')
            void this.claudeContext();
    }
    async openGoalOrigins() {
        const origins = new ClaudeGoalOrigins(join(this.store.directory, 'claude-goal-origins', `${this.task.id}.jsonl`));
        this.goalOrigins = origins;
        const prior = (await this.history.lines(1)).map(line => JSON.parse(line))
            .filter(entry => entry.item.type === 'tool_call' && typeof entry.item.callId === 'string')
            .map(entry => ({ nativeSessionId: this.nativeId, callId: String(entry.item.callId) }));
        await origins.open(prior);
    }
    /**
     * Reattach to a relay that kept running: rebuild the open turn, its tools and its unanswered
     * permission requests from the history, then resend saved answers (the relay drops duplicates).
     */
    async restore() {
        const native = this.task.native, relay = this.relay;
        this.nativeId = native.sessionId;
        this.agent.nativeSessionId = native.sessionId;
        this.agent.resumable = native.resumable;
        this.imageInput = native.imageInput === true;
        this.partialText = (await this.history.checkpoint(relay.id))?.partial === true;
        const { message, entries } = await this.history.turn();
        const id = message?.item.clientMessageId;
        this.claudeInputUuid = typeof message?.item.claudeUserUuid === 'string' ? message.item.claudeUserUuid : undefined;
        const savedGoal = message?.item.claudeGoalIdentity;
        if (native.protocol === 'claude' && savedGoal?.messageId === id && typeof savedGoal?.epoch === 'string') {
            this.goalIdentity = savedGoal;
            await this.openGoalOrigins();
        }
        const open = !!id && !entries.some(e => e.item.type === 'turn_end' && e.item.clientMessageId === id);
        this.suspended = false;
        this.agent.status = 'idle';
        if (!open)
            return;
        this.activeMessage = id;
        this.agent.status = 'running';
        this.confirmed = message.item.delivery !== 'pending' || entries.some(e => e.item.type === 'delivery' && e.item.clientMessageId === id);
        this.agent.activeTurn = { turnId: entries.findLast(e => e.turnId)?.turnId ?? randomUUID(), startedAt: message.timestamp, ...(message.item.unprompted === true ? { unprompted: true } : {}) };
        const start = this.store.task(t => t.id === this.task.id)?.codexTurnStart;
        if (start?.turnId === this.agent.activeTurn.turnId)
            this.codexStart = { turnId: start.turnId, total: start.total };
        for (const entry of entries)
            if (entry.item.type === 'tool_call')
                this.tools.set(String(entry.item.callId), entry.item);
        const answered = new Set(entries.filter(e => e.item.type === 'permission_response').map(e => String(e.item.requestId)));
        const requests = entries.filter((e) => e.item.type === 'permission_request' && e.item.relay === relay.id && !!e.item.wire);
        this.restoring = true;
        try {
            for (const request of requests)
                if (!answered.has(String(request.item.requestId)))
                    this.message(request.item.wire);
        }
        finally {
            this.restoring = false;
        }
        for (const entry of entries)
            if (entry.item.type === 'permission_response' && entry.item.reply)
                this.write(entry.item.reply, inputId('reply', String(entry.item.requestId)));
    }
    protocol() { return this.store.task(t => t.id === this.task.id).native.protocol; }
    /** `sentBy` names this DSH in a shared history, so the others can tell where the message came from. */
    async send(text, messageId, attachments = [], sentBy) {
        // A failed turn leaves a live process able to take the next message.
        if (this.admitting || !this.alive || (this.agent.status !== 'idle' && this.agent.status !== 'error') || this.agent.activeTurn)
            throw new Error('Remote CLI is not idle');
        this.admitting = true;
        try {
            if (await this.history.hasMessage(messageId))
                return; // Durable at-most-once admission.
            const protocol = this.protocol(), images = attachments.filter(a => a.kind === 'image');
            if (images.length && protocol === 'acp' && !this.imageInput)
                throw new Error('This remote CLI does not support image input');
            const claudeUuid = protocol === 'claude' ? randomUUID() : undefined;
            const goalSend = this.goalOrigins ? this.goalIdentity?.messageId === messageId ? this.goalIdentity : { epoch: `ungranted-${randomUUID()}`, messageId } : undefined;
            if (claudeUuid && goalSend)
                await this.goalOrigins.send({ ...goalSend, uuid: claudeUuid, nativeSessionId: this.nativeId });
            await this.history.append({ type: 'user_message', text, clientMessageId: messageId, delivery: 'pending', ...(claudeUuid ? { claudeUserUuid: claudeUuid } : {}), ...(goalSend ? { claudeGoalIdentity: goalSend } : {}), ...(attachments.length ? { attachments: attachments.map(({ data, ...file }) => file) } : {}), ...(sentBy ? { sentBy } : {}) });
            if (messageId === this.task.id)
                await this.store.update(state => { state.tasks.find(t => t.id === this.task.id).native.initialSent = true; });
            // Claude hands the notices of its finished background tasks to this message; they head no turn of its own now.
            this.claudeInputUuid = claudeUuid;
            this.activeMessage = messageId;
            this.notices = [];
            this.confirmed = false;
            this.partialText = false;
            this.agent.lastError = undefined;
            this.agent.status = 'running';
            this.agent.activeTurn = { turnId: randomUUID(), startedAt: new Date().toISOString() };
            // Prompt responses are handled with the output stream (see `message`), so a restarted DSH still recognizes them.
            const id = inputId('prompt', messageId);
            if (protocol === 'codex')
                this.write({ jsonrpc: '2.0', id: promptRequestId(messageId), method: 'turn/start', params: { threadId: this.nativeId, cwd: this.agent.cwd, model: this.task.model, input: [{ type: 'text', text }, ...images.map(a => ({ type: 'localImage', path: a.path }))], ...(this.task.thinkingOptionId ? { effort: this.task.thinkingOptionId } : {}), ...(this.task.serviceTier ? { serviceTier: this.task.serviceTier } : {}) } }, id);
            else if (protocol === 'acp')
                this.write({ jsonrpc: '2.0', id: promptRequestId(messageId), method: 'session/prompt', params: { sessionId: this.nativeId, prompt: [{ type: 'text', text }, ...images.map(a => ({ type: 'image', mimeType: a.mediaType, data: a.data }))] } }, id);
            else
                this.write({ type: 'user', session_id: this.nativeId, uuid: claudeUuid, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text }, ...images.map(a => ({ type: 'image', source: { type: 'base64', media_type: a.mediaType, data: a.data } }))] } }, id);
        }
        finally {
            this.admitting = false;
        }
    }
    confirm() {
        if (!this.activeMessage || this.confirmed)
            return;
        this.confirmed = true;
        this.append({ type: 'delivery', clientMessageId: this.activeMessage });
    }
    complete(toolStatus = 'completed') {
        this.goalOrigins?.close();
        this.claudeInputUuid = undefined;
        const unprompted = this.agent.activeTurn?.unprompted === true;
        this.saveUsage();
        this.turnModel = undefined;
        this.agent.status = 'idle';
        this.agent.activeTurn = null;
        this.agent.pendingPermissions = [];
        this.permissions.clear();
        for (const [callId, detail] of this.tools)
            if (detail.status === 'running')
                this.append({ ...detail, type: 'tool_call', callId, status: toolStatus });
        if (this.activeMessage)
            this.append({ type: 'turn_end', clientMessageId: this.activeMessage, status: toolStatus });
        this.tools.clear();
        for (const done of this.stopWaiters)
            done();
        this.stopWaiters.clear();
        this.activeMessage = undefined;
        this.hooks.turnEnded?.({ unprompted });
    }
    /**
     * Claude goes on without a message from DSH when a background task it ran finishes, or at a wake-up it scheduled.
     * Its output would otherwise land after the previous turn's end, unseen, with the session reading as idle. Such
     * output opens a turn of the CLI's own, headed by the task notices it got, saved and shown like any other turn.
     * Only Claude's own output counts: a subagent it left running in the background may still stream while it is idle.
     */
    continueUnprompted(subagent = false) {
        if (subagent || this.activeMessage || this.admitting || this.restoring || this.stopping)
            return;
        const id = `cli-${randomUUID()}`;
        this.append({ type: 'user_message', text: this.notices.join('\n'), clientMessageId: id, unprompted: true });
        this.notices = [];
        this.activeMessage = id;
        this.confirmed = true;
        this.partialText = false;
        this.agent.lastError = undefined;
        this.agent.status = 'running';
        this.agent.activeTurn = { turnId: randomUUID(), startedAt: new Date().toISOString(), unprompted: true };
        this.hooks.ownTurnStarted?.();
    }
    setContext(context) { if (context)
        this.agent.context = context; }
    /** Record what a turn used before it ends, so readers of the turn see it ahead of its end. */
    turnUsage(usage, failed = false, models) {
        if (!usage || !this.activeMessage)
            return;
        this.append({ type: 'usage', usage });
        this.hooks.usage?.(usage, { startedAt: this.agent.activeTurn?.startedAt ?? null, failed, ...(this.turnModel ? { model: this.turnModel } : {}), ...(models ? { models } : {}) });
    }
    setTokenUsage(usage) { this.agent.tokenUsage = usage; this.saveUsage(); }
    /** Keep where a Codex turn began, saved so that a DSH reattaching during the turn counts all of it. */
    startCodexTurn(turnId, total) {
        const id = typeof turnId === 'string' && turnId ? turnId : undefined;
        this.codexStart = { ...(id ? { turnId: id } : {}), total };
        if (!id)
            return;
        const saved = { turnId: id, ...(total && typeof total === 'object' ? { total: structuredClone(total) } : {}) };
        void this.store.update(state => { const task = state.tasks.find(t => t.id === this.task.id); if (task)
            task.codexTurnStart = saved; }).catch(() => { });
    }
    /** Save request snapshots as they arrive, including during long tool loops and resume. */
    saveUsage() {
        const { context, tokenUsage } = this.agent, key = JSON.stringify([context, tokenUsage]);
        if (key === this.savedUsage)
            return;
        this.savedUsage = key;
        const snapshot = structuredClone({ context, tokenUsage });
        void this.store.update(state => {
            const task = state.tasks.find(t => t.id === this.task.id);
            if (task) {
                task.context = snapshot.context;
                task.tokenUsage = snapshot.tokenUsage;
            }
        }).catch(() => { if (this.savedUsage === key)
            this.savedUsage = ''; });
    }
    /** Claude reports its exact context breakdown on request, including after compaction. */
    async claudeContext() {
        try {
            const usage = await this.peer.control({ subtype: 'get_context_usage' });
            this.setContext(contextUsage(usage?.totalTokens, usage?.maxTokens));
            this.saveUsage();
        }
        catch { /* Older Claude Code versions do not report context usage. */ }
    }
    fail(error) {
        if (this.intentionalClose)
            return;
        // CLIs report a user interrupt as a failed turn; it is recorded once by stop().
        if (this.stopping && this.peer.alive) {
            this.complete('canceled');
            return;
        }
        const message = error instanceof Error ? error.message : String(error);
        if (this.goalOrigins && this.activeMessage) {
            try {
                this.hooks.goalFailed?.(this.activeMessage, message);
            }
            catch { /* Still end the failed CLI turn. */ }
        }
        this.complete('failed');
        this.agent.status = 'error';
        this.agent.lastError = message;
        this.append({ type: 'error', message });
    }
    tool(id, name, status, detail, images = []) {
        const item = { type: 'tool_call', callId: id, name, status, detail, ...(images.length ? { images } : {}) };
        this.tools.set(id, item);
        this.append(item);
    }
    permission(id, permission, wire, respond) {
        this.confirm();
        this.permissions.set(id, respond);
        this.agent.pendingPermissions = [...this.agent.pendingPermissions.filter(p => p.id !== id), { ...permission, id }];
        // A persistent session keeps the request, so its prompt is shown again after a DSH restart.
        if (this.relay)
            this.append({ type: 'permission_request', requestId: id, relay: this.relay.id, wire });
    }
    async respond(id, answer) {
        const respond = this.permissions.get(id);
        if (!respond)
            throw new Error('This permission request is no longer pending');
        const reply = respond(answer);
        this.permissions.delete(id);
        this.agent.pendingPermissions = this.agent.pendingPermissions.filter(p => p.id !== id);
        // Save the answer first: after a restart it is resent, never asked again; the relay delivers it once.
        if (this.relay)
            await this.history.append({ type: 'permission_response', requestId: id, reply }, this.agent.activeTurn?.turnId, this.position());
        this.write(reply, inputId('reply', id));
    }
    resolved(id) {
        if (!this.permissions.delete(id))
            return;
        this.agent.pendingPermissions = this.agent.pendingPermissions.filter(q => q.id !== id);
        if (this.relay)
            this.append({ type: 'permission_response', requestId: id, resolved: true });
    }
    message(m) {
        if (this.task.provider === 'claude' && m.type === 'system' && m.subtype === 'init' && m.session_id === this.nativeId && m.parent_tool_use_id == null && !m.historical && !m.isReplay) {
            this.claudeLegacy = legacyClaudeVersion(m.claude_code_version);
            this.goalOrigins?.noteInit(m, this.nativeId);
            if (typeof m.claude_code_version === 'string' && !this.claudeLegacy)
                this.claudeUuidSupported = true;
        }
        if (this.task.provider === 'claude' && (m.type === 'assistant' || m.type === 'stream_event')) {
            if (m.parent_tool_use_id == null && !m.historical && !m.isReplay && typeof m.user_message_uuid === 'string' && m.session_id === this.nativeId)
                this.claudeUuidSupported = true;
            const origins = this.goalOrigins?.observe(m, this.nativeId, this.activeMessage) ?? [];
            if (origins.length) {
                // Publish provenance only after its independent append-only journal is durable.
                // A journal failure disables goal proof; it does not stop ordinary CLI output.
                const journal = this.goalOrigins;
                void journal.flush().then(async (durable) => { if (durable)
                    for (const origin of origins)
                        await this.history.append({ type: 'claude_goal_origin', ...origin }); }).catch(() => { });
            }
            if (this.claudeInputUuid && m.parent_tool_use_id == null && typeof m.user_message_uuid === 'string' && m.user_message_uuid !== this.claudeInputUuid)
                return;
            if (this.goalOrigins && (m.historical || m.isReplay))
                return;
        }
        if (m.method && m.id !== undefined) {
            this.request(m);
            return;
        }
        if (m.id !== undefined && !m.method && this.activeMessage && String(m.id) === promptRequestId(this.activeMessage)) {
            this.promptResponse(m);
            return;
        }
        // Codex reports the resumed thread's usage while its history replay is still suppressed.
        if (m.method === 'thread/tokenUsage/updated') {
            const usage = m.params?.tokenUsage, turnId = typeof m.params?.turnId === 'string' ? m.params.turnId : undefined;
            this.setContext(codexContext(usage));
            this.setTokenUsage(codexTokenUsage(usage));
            // The first report of a turn whose start was missed: the turn began before that request, at the latest.
            if (this.activeMessage && (!this.codexStart || (turnId && this.codexStart.turnId && turnId !== this.codexStart.turnId)))
                this.startCodexTurn(turnId, codexTotalBefore(usage));
            this.codexTotal = usage?.total ?? this.codexTotal;
        }
        if (this.suspended)
            return; // A resume can replay native history already present in our log.
        // Claude reports a background task it ran as finished. Mid-turn the notice is the turn's own business; while idle it
        // heads the turn Claude starts for it (see `continueUnprompted`). A notice that starts no turn is kept for the next.
        if (m.type === 'system' && m.subtype === 'task_notification' && !this.activeMessage && typeof m.summary === 'string' && m.summary) {
            const notice = `${m.summary}${typeof m.status === 'string' && m.status && m.status !== 'completed' ? ` (${m.status})` : ''}`;
            if (!this.notices.includes(notice))
                this.notices.push(notice);
        }
        // Claude's safeguards refused a request: the CLI retries it on another model and stays there, while the picker keeps
        // showing the selection, so the switch is shown where it happened. A subagent's fallback (`local`) changes nothing else.
        if (m.type === 'system' && m.subtype === 'model_refusal_fallback' && m.direction === 'retry' && m.scope !== 'local' && typeof m.original_model === 'string' && typeof m.fallback_model === 'string') {
            this.continueUnprompted();
            this.append({ type: 'model_switch', from: m.original_model, to: m.fallback_model, ...(typeof m.api_refusal_category === 'string' && m.api_refusal_category ? { category: m.api_refusal_category } : {}) });
        }
        const p = m.params ?? {};
        if (m.method === 'turn/started') {
            this.confirm();
            if (this.codexTotal)
                this.startCodexTurn(p.turn?.id, this.codexTotal);
            else
                this.codexStart = undefined;
            if (this.agent.activeTurn && p.turn?.id)
                this.agent.activeTurn.turnId = p.turn.id;
        }
        if (m.method === 'turn/completed') {
            this.confirm();
            this.turnUsage(this.codexStart && codexTurnUsage(this.codexTotal, this.codexStart.total), p.turn?.status === 'failed');
            this.codexStart = undefined;
            if (p.turn?.status === 'failed')
                this.fail(p.turn.error?.message ?? 'Remote turn failed');
            else
                this.complete(p.turn?.status === 'interrupted' ? 'canceled' : 'completed');
        }
        if (m.method === 'item/agentMessage/delta') {
            this.confirm();
            this.append({ type: 'assistant_message', text: String(p.delta ?? '') });
        }
        if (m.method?.startsWith('item/reasoning/') && m.method.endsWith('Delta'))
            this.append({ type: 'reasoning', text: String(p.delta ?? '') });
        if (m.method === 'item/started' || m.method === 'item/completed') {
            const item = p.item, done = m.method === 'item/completed';
            const status = !done ? 'running' : item?.status === 'failed' || item?.failure ? 'failed' : item?.status === 'declined' ? 'canceled' : 'completed';
            if (item?.type === 'commandExecution' || item?.type === 'fileChange')
                this.tool(String(item.id), item.type === 'commandExecution' ? 'Bash' : 'Edit', status, item);
            if (item?.type === 'mcpToolCall') {
                // Screenshots and other images an MCP tool returns are shown; their bytes are kept out of the saved detail.
                const content = list(item.result?.content), images = status === 'completed' ? this.toolImages(content, undefined, String(item.tool ?? '')) : [];
                const detail = content.some(b => b?.type === 'image') ? { ...item, result: { ...item.result, content: content.map(b => b?.type === 'image' ? { type: 'image', mimeType: b.mimeType } : b) } } : item;
                this.tool(String(item.id), String(item.tool ?? 'MCP'), status, detail, images);
            }
            // view_image reports only the path; the chat fetches the image from the remote machine.
            if (item?.type === 'imageView')
                this.tool(String(item.id), 'view_image', status, item, done && viewedImagePath(item.path) ? [{ path: item.path, name: imageName(item.path) }] : []);
            if (item?.type === 'imageGeneration') {
                const { result, ...detail } = item, file = status === 'completed' ? this.keepImage(result) : undefined, path = viewedImagePath(item.savedPath) ? item.savedPath : undefined;
                this.tool(String(item.id), 'image_generation', status, detail, status === 'completed' && (file || path) ? [{ ...(file ? { file } : {}), ...(path ? { path } : {}), name: imageName(path) || 'Generated image' }] : []);
            }
        }
        if (m.method === 'error')
            this.append({ type: 'error', message: String(p.error?.message ?? p.message ?? 'Remote CLI error') });
        if (m.method === 'serverRequest/resolved')
            this.resolved(`rpc-${p.requestId}`);
        if (m.method === 'session/update') {
            const update = p.update ?? {};
            this.confirm();
            if (update.sessionUpdate === 'usage_update')
                this.setContext(contextUsage(update.used, update.size));
            if (update.sessionUpdate === 'agent_message_chunk' || update.sessionUpdate === 'agent_thought_chunk')
                this.append({ type: update.sessionUpdate === 'agent_message_chunk' ? 'assistant_message' : 'reasoning', text: update.content?.type === 'text' ? String(update.content.text ?? '') : '' });
            if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
                const old = this.tools.get(String(update.toolCallId));
                this.tool(String(update.toolCallId), String(update.title ?? old?.name ?? 'Tool'), ['completed', 'failed'].includes(update.status) ? update.status : 'running', update.rawOutput ?? update.rawInput ?? update.content ?? old?.detail);
            }
        }
        if (m.type === 'control_request')
            this.claudeRequest(m);
        if (m.type === 'stream_event') {
            const event = m.event ?? {};
            if (event.type === 'content_block_delta' && ['text_delta', 'thinking_delta'].includes(event.delta?.type))
                this.continueUnprompted(!!m.parent_tool_use_id);
            if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
                this.confirm();
                this.partialText = true;
                this.append({ type: 'assistant_message', text: String(event.delta.text ?? '') });
            }
            if (event.type === 'content_block_delta' && event.delta?.type === 'thinking_delta')
                this.append({ type: 'reasoning', text: String(event.delta.thinking ?? '') });
        }
        if (m.type === 'assistant') {
            this.continueUnprompted(!!m.parent_tool_use_id);
            this.confirm();
            // Subagent messages run in their own context window.
            const used = m.parent_tool_use_id ? undefined : claudeMessageTokens(m.message?.usage);
            if (used !== undefined && this.agent.context)
                this.setContext({ used, max: this.agent.context.max });
            if (!m.parent_tool_use_id && m.message?.usage !== undefined)
                this.setTokenUsage(claudeTokenUsage(m.message.usage));
            // Claude's own notices, such as API errors, are `<synthetic>` messages.
            if (!m.parent_tool_use_id && typeof m.message?.model === 'string' && m.message.model && !m.message.model.startsWith('<'))
                this.turnModel = m.message.model;
            for (const block of list(m.message?.content)) {
                if (block.type === 'text' && !this.partialText)
                    this.append({ type: 'assistant_message', text: String(block.text ?? '') });
                if (block.type === 'tool_use')
                    this.tool(String(block.id), String(block.name), 'running', block.input);
            }
            this.partialText = false;
        }
        if (m.type === 'user')
            for (const block of list(m.message?.content))
                if (block.type === 'tool_result') {
                    const call = this.tools.get(String(block.tool_use_id)), input = call?.detail;
                    this.tool(String(block.tool_use_id), String(call?.name ?? 'Tool'), block.is_error ? 'failed' : 'completed', contentText(block.content), block.is_error ? [] : this.toolImages(block.content, input?.file_path ?? input?.path));
                }
        if (m.type === 'result') {
            if (m.historical || m.isReplay || m.parent_tool_use_id != null || m.session_id !== undefined && m.session_id !== this.nativeId)
                return;
            const ownTurn = this.agent.activeTurn?.unprompted === true;
            const failed = !!m.is_error || m.subtype !== 'success';
            // Session-scoped/zeroed errors legitimately omit UUID even on modern Claude.
            // They are failures of the current execution, never proof that its prompt succeeded.
            // Explicitly stale UUIDs still take the rejection path below.
            if (typeof m.user_message_uuid !== 'string' && failed) {
                const reason = claudeResultError(m);
                if (this.goalOrigins)
                    this.fail(`Claude reported a session-level error without a message UUID; the current turn failed conservatively: ${reason}`);
                else {
                    this.confirm();
                    this.turnUsage(claudeTurnUsage(m.usage), true, claudeModelUsage(m.model_usage_since_last_result));
                    this.fail(reason);
                }
                void this.claudeContext();
                return;
            }
            if (typeof m.user_message_uuid === 'string') {
                this.claudeUuidSupported = true;
                if (!ownTurn && m.user_message_uuid !== this.claudeInputUuid)
                    return;
            }
            else if (this.claudeUuidSupported && !this.claudeLegacy && !ownTurn)
                return;
            if (this.goalOrigins && !ownTurn && !this.goalOrigins.resultMatches(m, this.nativeId, this.activeMessage))
                return;
            this.confirm();
            this.turnUsage(claudeTurnUsage(m.usage), !!m.is_error || m.subtype !== 'success', claudeModelUsage(m.model_usage_since_last_result));
            if (m.is_error || m.subtype !== 'success')
                this.fail(claudeResultError(m));
            else
                this.complete();
            void this.claudeContext();
        }
    }
    /** Codex `turn/start` and ACP `session/prompt` responses for the active message. */
    promptResponse(m) {
        if (m.error) {
            this.fail(new Error(typeof m.error.message === 'string' ? m.error.message : JSON.stringify(m.error)));
            return;
        }
        // ACP acknowledges `session/cancel` by ending the prompt with `stopReason: cancelled`.
        if (this.protocol() === 'acp') {
            this.confirm();
            this.turnUsage(acpTurnUsage(m.result?.usage));
            this.complete(m.result?.stopReason === 'cancelled' ? 'canceled' : 'completed');
            return;
        }
        if (m.result?.turn?.id && this.agent.activeTurn)
            this.agent.activeTurn.turnId = m.result.turn.id;
        this.confirm();
    }
    request(m) {
        const p = m.params ?? {}, id = `rpc-${m.id}`;
        const reply = (result) => ({ jsonrpc: '2.0', id: m.id, result });
        // Requests answered without the user may be read again after a reconnect; the relay drops repeats.
        const answer = (message) => { if (!this.restoring)
            this.write(message, inputId('auto', id)); };
        if (m.method === 'session/request_permission') {
            const options = list(p.options);
            this.permission(id, { kind: 'tool', name: String(p.toolCall?.title ?? 'Tool'), detail: p.toolCall, actions: options.map(o => ({ id: String(o.optionId), label: String(o.name), behavior: String(o.kind).startsWith('allow') ? 'allow' : 'deny', scope: String(o.kind).endsWith('always') ? 'session' : 'once' })) }, m, answer => reply(answer.selectedActionId ? { outcome: { outcome: 'selected', optionId: answer.selectedActionId } } : { outcome: { outcome: 'cancelled' } }));
        }
        else if (m.method === 'item/tool/requestUserInput') {
            const questions = list(p.questions);
            this.permission(id, { kind: 'question', name: 'Question', input: { questions: questions.map(q => ({ ...q, header: q.header ?? q.id, options: list(q.options), allowOther: q.isOther === true })) } }, m, answer => reply({ answers: Object.fromEntries(questions.map(q => [q.id, { answers: answer.behavior === 'allow' ? [answer.answers?.[q.header ?? q.id] ?? ''] : [] }])) }));
        }
        else if (m.method === 'item/permissions/requestApproval') {
            this.permission(id, { kind: 'tool', name: 'Additional permissions', description: p.reason, detail: p.permissions }, m, answer => reply({ permissions: answer.behavior === 'allow' ? p.permissions : {}, scope: 'turn' }));
        }
        else if (m.method === 'item/commandExecution/requestApproval' || m.method === 'item/fileChange/requestApproval') {
            const decisions = list(p.availableDecisions).filter(d => typeof d === 'string');
            const choices = decisions.length ? decisions : ['accept', 'decline'];
            this.permission(id, { kind: 'tool', name: m.method.includes('commandExecution') ? 'Bash' : 'Edit', description: p.reason, detail: p, actions: choices.map(decision => ({ id: decision, label: { accept: 'Allow once', acceptForSession: 'Allow for this session', decline: 'Deny', cancel: 'Cancel' }[decision] ?? decision, behavior: decision.startsWith('accept') ? 'allow' : 'deny' })) }, m, answer => reply({ decision: answer.selectedActionId ?? (answer.behavior === 'allow' ? 'accept' : 'decline') }));
        }
        else if (m.method === 'mcpServer/elicitation/request') {
            // MCP tool approvals are forms without required fields; links and data entry cannot be answered here.
            const required = p.requestedSchema?.required;
            if (p.mode === 'url' || (Array.isArray(required) && required.length)) {
                answer(reply({ action: 'decline', content: null, _meta: null }));
                return;
            }
            this.permission(id, { kind: 'tool', name: `MCP · ${String(p.serverName ?? 'server')}`, title: `MCP approval: ${String(p.serverName ?? 'server')}`, description: typeof p.message === 'string' ? p.message : undefined, detail: p }, m, answer => reply({ action: answer.behavior === 'allow' ? 'accept' : 'decline', content: answer.behavior === 'allow' ? {} : null, _meta: null }));
        }
        else
            answer({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `Client method not supported: ${m.method}` } });
    }
    claudeRequest(m) {
        const request = m.request ?? {};
        const reply = (response) => ({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response } });
        if (request.subtype !== 'can_use_tool') {
            if (!this.restoring)
                this.write(reply({}), inputId('auto', `claude-${m.request_id}`));
            return;
        }
        this.continueUnprompted();
        const name = String(request.tool_name ?? 'Tool');
        // Only echo native allow-rule suggestions, and only after the user selects their scope.
        // Keep updates in this closure: the client supplies an action ID, never arbitrary rules.
        const updates = request.suppress_always_allow_rule || request.suppressAlwaysAllowRule || name === 'AskUserQuestion' || name === 'ExitPlanMode' ? []
            : list(request.permission_suggestions).filter(s => s?.type === 'addRules' && s.behavior === 'allow'
                && ['session', 'localSettings'].includes(s.destination) && Array.isArray(s.rules) && s.rules.length > 0
                && s.rules.every((r) => r && typeof r.toolName === 'string' && r.toolName.length > 0 && (r.ruleContent === undefined || typeof r.ruleContent === 'string')));
        const remembered = [
            { id: 'remember-session', label: 'Allow matching requests for this session', scope: 'session', updates: updates.filter(s => s.destination === 'session') },
            { id: 'remember-project', label: 'Always allow matching requests in this project', scope: 'project', updates: updates.filter(s => s.destination === 'localSettings') },
        ].filter(action => action.updates.length);
        const actions = remembered.length ? [
            { id: 'once', label: 'Allow once', behavior: 'allow', scope: 'once' },
            ...remembered.map(({ updates: _updates, ...action }) => ({ ...action, behavior: 'allow' })),
            { id: 'deny', label: 'Deny', behavior: 'deny' },
        ] : undefined;
        this.permission(`claude-${m.request_id}`, { name, kind: name === 'AskUserQuestion' ? 'question' : name === 'ExitPlanMode' ? 'plan' : 'tool',
            title: request.title, description: request.description, input: request.input,
            ...(typeof request.decision_reason === 'string' && request.decision_reason ? { reason: request.decision_reason } : {}),
            ...(request.decision_reason_type === 'safetyCheck' ? { safetyCheck: true } : {}),
            detail: updates.length ? { input: request.input, permissionSuggestions: updates } : request.input, ...(actions ? { actions } : {}) }, m, answer => {
            const answers = answer.answers && name === 'AskUserQuestion'
                ? Object.fromEntries(questionsOf(request.input).map(question => [question.question, answer.answers[question.header]]))
                : answer.answers;
            const selected = remembered.find(action => action.id === answer.selectedActionId);
            return reply(answer.behavior === 'allow' ? { behavior: 'allow', updatedInput: { ...request.input, ...(answers ? { answers } : {}) }, ...(selected ? { updatedPermissions: selected.updates } : {}) } : { behavior: 'deny', message: answer.message ?? 'The user denied this request' });
        });
    }
    async stop() {
        if (this.agent.status !== 'running' && !this.agent.pendingPermissions.length)
            return;
        const settled = new Promise(resolve => this.stopWaiters.add(resolve));
        this.stopping = true;
        try {
            const protocol = this.protocol();
            // Read now: the turn's end clears them.
            const commands = protocol === 'codex' ? [...this.tools.values()].filter(tool => tool.name === 'Bash').map(tool => String(tool.callId)) : [];
            if (protocol === 'codex')
                await this.peer.request('turn/interrupt', { threadId: this.nativeId, turnId: this.agent.activeTurn?.turnId }, 5000);
            else if (protocol === 'acp')
                this.write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: this.nativeId } });
            else
                await this.peer.control({ subtype: 'interrupt' }, 5000);
            let timer;
            try {
                await Promise.race([settled, new Promise(resolve => { timer = setTimeout(resolve, 5000); })]);
            }
            finally {
                clearTimeout(timer);
            }
            await this.endCommands(commands);
        }
        finally {
            this.stopping = false;
            if (this.agent.status === 'running') {
                this.close();
                this.agent.lastError = 'The remote CLI did not confirm interruption. The next message resumes its saved session.';
            }
            this.append({ type: 'interrupted' });
        }
    }
    /**
     * An interrupted Codex turn leaves its commands running, so Stop ends them too. Only the ones this turn started:
     * what an earlier turn left running, such as a dev server, stays.
     */
    async endCommands(itemIds) {
        if (!itemIds.length)
            return;
        try {
            const running = await this.peer.request('thread/backgroundTerminals/list', { threadId: this.nativeId, limit: 100 }, 3000);
            await Promise.all(list(running?.data).filter(terminal => itemIds.includes(String(terminal?.itemId)))
                .map(terminal => this.peer.request('thread/backgroundTerminals/terminate', { threadId: this.nativeId, processId: terminal.processId }, 3000)));
        }
        catch { /* A Codex release without these calls leaves them running, as every Stop did before. */ }
    }
    /** End the CLI process and the turn. */
    close() {
        this.intentionalClose = true;
        this.peer.close();
        this.complete('canceled');
        this.agent.status = 'closed';
        if (!this.released)
            this.ended();
    }
    ended() { if (!this.endedSent) {
        this.endedSent = true;
        this.hooks.ended?.();
    } }
    /** Disconnect without affecting the CLI: a persistent session continues and is restored later. */
    release() {
        if (!this.relay) {
            this.close();
            return;
        }
        this.released = true;
        this.agent.reconnecting = false;
        this.peer.close();
    }
}
