import { createHash, randomUUID } from 'node:crypto';
import { questionsOf } from './domain.js';
import { RelayExit, RelayReleased } from './relay.js';
import { configureAcpSession } from './acp.js';
import { acpTurnUsage, claudeMessageTokens, claudeTokenUsage, claudeTurnUsage, codexContext, codexTokenUsage, codexTurnUsage, contextUsage } from './usage.js';
const list = (value) => Array.isArray(value) ? value : [];
const contentText = (content) => typeof content === 'string' ? content : list(content).map(c => c?.text ?? c?.content?.text ?? '').join('\n');
export async function initializeCodex(peer) {
    await peer.request('initialize', { clientInfo: { name: 'dsh-remote-agents', title: 'DSH Remote Agents', version: '0.1.0' }, capabilities: {} });
    peer.send({ method: 'initialized', params: {} });
}
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
    confirmed = false;
    partialText = false;
    /** Codex running thread totals, now and when the current turn began. */
    codexTotal;
    codexBefore;
    suspended = true;
    intentionalClose = false;
    diskFailed = false;
    admitting = false;
    interrupting = false;
    stopping = false;
    released = false;
    endedSent = false;
    restoring = false;
    imageInput = false;
    /** Items produced by the output line being processed, saved together with its relay offset. */
    batch;
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
            if (this.interrupting)
                this.close();
            else if (!this.intentionalClose)
                this.fail(error);
            this.ended();
        });
    }
    get alive() { return this.peer.alive && !this.released; }
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
        try {
            this.message(message);
        }
        catch (error) {
            this.fail(error);
        }
        finally {
            const items = this.batch;
            this.batch = undefined;
            if (items.length && !this.diskFailed)
                void this.history.appendBatch(items, this.position(frame.end)).catch(error => this.diskFailure(error));
        }
    }
    write(message, id) { this.peer.send(message, this.relay ? id : undefined); }
    async initialize(protocol, argv, resume = false) {
        this.agent.resumable = protocol !== 'acp';
        if (protocol === 'codex') {
            await initializeCodex(this.peer);
            const mode = this.task.modeId ?? 'workspace-write';
            // Without a selected tier, Codex applies its configured one; a resumed thread does not restore an earlier tier.
            const policy = mode === 'inherit' ? {} : { approvalPolicy: mode === 'full-access' ? 'never' : 'on-request', sandbox: mode === 'read-only' ? 'read-only' : mode === 'full-access' ? 'danger-full-access' : 'workspace-write' };
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
                response = await this.peer.request(method, { ...params, ...binding, approvalPolicy: mode === 'full-access' ? 'never' : 'onRequest', sandbox: mode === 'read-only' ? 'readOnly' : mode === 'full-access' ? 'dangerFullAccess' : 'workspaceWrite' });
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
            const response = await this.peer.request(resume ? resumeMethod : 'session/new', { cwd: this.agent.cwd, mcpServers: [], ...(resume ? { sessionId: this.task.native.sessionId } : {}) });
            this.nativeId = resume ? this.task.native.sessionId : response?.sessionId;
            await configureAcpSession(this.peer, this.nativeId, this.task, response);
        }
        else if (protocol === 'antigravity') {
            const init = await this.peer.waitForMessage(message => message.event === 'init');
            this.nativeId = init.conversation_id;
            if (resume && this.nativeId !== this.task.native.sessionId)
                throw new Error('Antigravity resumed a different conversation');
        }
        else {
            this.nativeId = this.task.native?.sessionId ?? argv[argv.indexOf('--session-id') + 1];
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
        const open = !!id && !entries.some(e => e.item.type === 'turn_end' && e.item.clientMessageId === id);
        this.suspended = false;
        this.agent.status = 'idle';
        if (!open)
            return;
        this.activeMessage = id;
        this.agent.status = 'running';
        this.confirmed = message.item.delivery !== 'pending' || entries.some(e => e.item.type === 'delivery' && e.item.clientMessageId === id);
        this.agent.activeTurn = { turnId: entries.findLast(e => e.turnId)?.turnId ?? randomUUID(), startedAt: message.timestamp };
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
    async send(text, messageId, attachments = []) {
        // A failed turn leaves a live process able to take the next message.
        if (this.admitting || !this.alive || (this.agent.status !== 'idle' && this.agent.status !== 'error') || this.agent.activeTurn)
            throw new Error('Remote CLI is not idle');
        this.admitting = true;
        try {
            if (await this.history.hasMessage(messageId))
                return; // Durable at-most-once admission.
            const protocol = this.protocol(), images = attachments.filter(a => a.kind === 'image');
            if (images.length && (protocol === 'antigravity' || (protocol === 'acp' && !this.imageInput)))
                throw new Error('This remote CLI does not support image input');
            await this.history.append({ type: 'user_message', text, clientMessageId: messageId, delivery: 'pending', ...(attachments.length ? { attachments: attachments.map(({ data, ...file }) => file) } : {}) });
            if (messageId === this.task.id)
                await this.store.update(state => { state.tasks.find(t => t.id === this.task.id).native.initialSent = true; });
            this.activeMessage = messageId;
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
            else if (protocol === 'antigravity')
                this.write({ event: 'user', message: { content: text } }, id);
            else
                this.write({ type: 'user', session_id: this.nativeId, uuid: randomUUID(), parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text }, ...images.map(a => ({ type: 'image', source: { type: 'base64', media_type: a.mediaType, data: a.data } }))] } }, id);
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
        this.saveUsage();
        this.hooks.turnEnded?.();
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
    }
    setContext(context) { if (context)
        this.agent.context = context; }
    /** Record what a turn used before it ends, so readers of the turn see it ahead of its end. */
    turnUsage(usage, failed = false) {
        if (!usage || !this.activeMessage)
            return;
        this.append({ type: 'usage', usage });
        this.hooks.usage?.(usage, { startedAt: this.agent.activeTurn?.startedAt ?? null, failed });
    }
    setTokenUsage(usage) { this.agent.tokenUsage = usage; this.saveUsage(); }
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
        this.complete('failed');
        this.agent.status = 'error';
        this.agent.lastError = message;
        this.append({ type: 'error', message });
    }
    tool(id, name, status, detail) {
        const item = { type: 'tool_call', callId: id, name, status, detail };
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
            this.setContext(codexContext(m.params?.tokenUsage));
            this.setTokenUsage(codexTokenUsage(m.params?.tokenUsage));
            this.codexTotal = m.params?.tokenUsage?.total ?? this.codexTotal;
        }
        if (this.suspended)
            return; // A resume can replay native history already present in our log.
        if (m.event === 'step_update') {
            const step = m.step_update ?? {};
            this.confirm();
            if (step.step_type === 'agent_response' && typeof step.text_delta === 'string') {
                this.partialText = true;
                this.append({ type: 'assistant_message', text: step.text_delta });
            }
            if (step.step_type === 'tool')
                this.tool(`${this.nativeId}:${step.step_index}`, String(step.tool_name ?? 'Tool'), step.state === 'DONE' ? 'completed' : step.state === 'ERROR' ? 'failed' : 'running', step);
        }
        if (m.event === 'result') {
            const result = m.result ?? {};
            if (this.interrupting) {
                this.close();
                return;
            }
            this.confirm();
            if (typeof result.response === 'string' && result.response && !this.partialText)
                this.append({ type: 'assistant_message', text: result.response });
            if (result.status === 'SUCCESS')
                this.complete();
            else
                this.fail(result.error || 'Antigravity turn failed');
        }
        const p = m.params ?? {};
        if (m.method === 'turn/started') {
            this.confirm();
            this.codexBefore = this.codexTotal;
            if (this.agent.activeTurn && p.turn?.id)
                this.agent.activeTurn.turnId = p.turn.id;
        }
        if (m.method === 'turn/completed') {
            this.confirm();
            this.turnUsage(codexTurnUsage(this.codexTotal, this.codexBefore), p.turn?.status === 'failed');
            this.codexBefore = this.codexTotal;
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
            const item = p.item;
            if (item?.type === 'commandExecution' || item?.type === 'fileChange' || item?.type === 'mcpToolCall')
                this.tool(String(item.id), item.type === 'commandExecution' ? 'Bash' : item.type === 'fileChange' ? 'Edit' : String(item.tool ?? 'MCP'), m.method === 'item/started' ? 'running' : item.status === 'failed' ? 'failed' : item.status === 'declined' ? 'canceled' : 'completed', item);
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
            if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
                this.confirm();
                this.partialText = true;
                this.append({ type: 'assistant_message', text: String(event.delta.text ?? '') });
            }
            if (event.type === 'content_block_delta' && event.delta?.type === 'thinking_delta')
                this.append({ type: 'reasoning', text: String(event.delta.thinking ?? '') });
        }
        if (m.type === 'assistant') {
            this.confirm();
            // Subagent messages run in their own context window.
            const used = m.parent_tool_use_id ? undefined : claudeMessageTokens(m.message?.usage);
            if (used !== undefined && this.agent.context)
                this.setContext({ used, max: this.agent.context.max });
            if (!m.parent_tool_use_id && m.message?.usage !== undefined)
                this.setTokenUsage(claudeTokenUsage(m.message.usage));
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
                if (block.type === 'tool_result')
                    this.tool(String(block.tool_use_id), String(this.tools.get(String(block.tool_use_id))?.name ?? 'Tool'), block.is_error ? 'failed' : 'completed', contentText(block.content));
        if (m.type === 'result') {
            this.confirm();
            this.turnUsage(claudeTurnUsage(m.usage), !!m.is_error || m.subtype !== 'success');
            if (m.is_error || m.subtype !== 'success')
                this.fail(contentText(m.errors) || String(m.result ?? 'Claude turn failed'));
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
            if (protocol === 'codex')
                await this.peer.request('turn/interrupt', { threadId: this.nativeId, turnId: this.agent.activeTurn?.turnId }, 5000);
            else if (protocol === 'acp')
                this.write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: this.nativeId } });
            else if (protocol === 'antigravity') {
                this.interrupting = true;
                this.write({ event: 'dsh_interrupt' });
            }
            else
                await this.peer.control({ subtype: 'interrupt' }, 5000);
            let timer;
            try {
                await Promise.race([settled, new Promise(resolve => { timer = setTimeout(resolve, 5000); })]);
            }
            finally {
                clearTimeout(timer);
            }
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
