import { randomUUID } from 'node:crypto';
import { questionsOf } from './domain.js';
import { configureAcpSession } from './acp.js';
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
export class CliSession {
    peer;
    task;
    history;
    store;
    agent;
    nativeId = '';
    activeMessage;
    confirmed = false;
    partialText = false;
    suspended = true;
    intentionalClose = false;
    diskFailed = false;
    admitting = false;
    interrupting = false;
    stopping = false;
    permissions = new Map();
    tools = new Map();
    stopWaiters = new Set();
    constructor(peer, task, history, store) {
        this.peer = peer;
        this.task = task;
        this.history = history;
        this.store = store;
        this.agent = { id: task.agentId ?? task.id, cwd: task.executionCwd ?? task.cwd, provider: task.provider, model: task.model, title: task.title, status: 'initializing', pendingPermissions: [] };
        peer.onMessage(message => { try {
            this.message(message);
        }
        catch (error) {
            this.fail(error);
        } });
        peer.onExit(error => { if (this.interrupting)
            this.close();
        else if (!this.intentionalClose)
            this.fail(error); });
    }
    get alive() { return this.peer.alive; }
    /** A turn, approval or message admission is in progress. */
    get busy() { return this.admitting || this.agent.status === 'running' || this.agent.status === 'initializing' || !!this.agent.activeTurn || this.agent.pendingPermissions.length > 0; }
    /** Only sessions that can be resumed later may be closed to free a connection slot. */
    get evictable() { return this.alive && this.agent.resumable === true && !this.busy; }
    append(item) {
        if (this.diskFailed)
            return;
        void this.history.append(item, this.agent.activeTurn?.turnId).catch(error => { this.diskFailed = true; this.agent.status = 'error'; this.agent.lastError = `Could not save task history: ${String(error)}`; this.peer.close(); });
    }
    async initialize(protocol, argv, resume = false) {
        this.agent.resumable = protocol !== 'acp';
        if (protocol === 'codex') {
            await initializeCodex(this.peer);
            const mode = this.task.modeId ?? 'workspace-write';
            const params = { cwd: this.agent.cwd, model: this.task.model, approvalPolicy: mode === 'full-access' ? 'never' : 'on-request', sandbox: mode === 'read-only' ? 'read-only' : mode === 'full-access' ? 'danger-full-access' : 'workspace-write' };
            let response;
            const method = resume ? 'thread/resume' : 'thread/start';
            const binding = resume ? { threadId: this.task.native.sessionId } : {};
            try {
                response = await this.peer.request(method, { ...params, ...binding });
            }
            catch (error) {
                if (!/unknown variant|invalid.*(?:sandbox|approval)/i.test(String(error)))
                    throw error;
                response = await this.peer.request(method, { ...params, ...binding, approvalPolicy: mode === 'full-access' ? 'never' : 'onRequest', sandbox: mode === 'read-only' ? 'readOnly' : mode === 'full-access' ? 'dangerFullAccess' : 'workspaceWrite' });
            }
            this.nativeId = response?.thread?.id;
        }
        else if (protocol === 'acp') {
            const capabilities = await initializeAcp(this.peer);
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
            await this.peer.control({ subtype: 'initialize' });
        }
        if (typeof this.nativeId !== 'string' || !this.nativeId)
            throw new Error('Remote CLI did not return a native session ID');
        await this.store.update(state => {
            const task = state.tasks.find(t => t.id === this.task.id);
            task.agentId = this.agent.id;
            task.executionCwd = this.agent.cwd;
            task.native = { protocol, sessionId: this.nativeId, argv, resumable: this.agent.resumable, initialSent: task.native?.initialSent ?? false };
        });
        this.agent.nativeSessionId = this.nativeId;
        this.agent.status = 'idle';
        this.suspended = false;
    }
    protocol() { return this.store.task(t => t.id === this.task.id).native.protocol; }
    async send(text, messageId) {
        // A failed turn leaves a live process able to take the next message.
        if (this.admitting || !this.alive || (this.agent.status !== 'idle' && this.agent.status !== 'error') || this.agent.activeTurn)
            throw new Error('Remote CLI is not idle');
        this.admitting = true;
        try {
            if (await this.history.hasMessage(messageId))
                return; // Durable at-most-once admission.
            await this.history.append({ type: 'user_message', text, clientMessageId: messageId, delivery: 'pending' });
            if (messageId === this.task.id)
                await this.store.update(state => { state.tasks.find(t => t.id === this.task.id).native.initialSent = true; });
            this.activeMessage = messageId;
            this.confirmed = false;
            this.partialText = false;
            this.agent.lastError = undefined;
            this.agent.status = 'running';
            this.agent.activeTurn = { turnId: randomUUID(), startedAt: new Date().toISOString() };
            const protocol = this.protocol();
            if (protocol === 'codex') {
                void this.peer.request('turn/start', { threadId: this.nativeId, cwd: this.agent.cwd, model: this.task.model, input: [{ type: 'text', text }], ...(this.task.thinkingOptionId ? { effort: this.task.thinkingOptionId } : {}) }).then(result => { if (this.activeMessage !== messageId)
                    return; if (result?.turn?.id && this.agent.activeTurn)
                    this.agent.activeTurn.turnId = result.turn.id; this.confirm(); }).catch(error => { if (this.activeMessage === messageId)
                    this.fail(error); });
            }
            else if (protocol === 'acp') {
                void this.peer.request('session/prompt', { sessionId: this.nativeId, prompt: [{ type: 'text', text }] }, 0).then(() => { if (this.activeMessage !== messageId)
                    return; this.confirm(); this.complete(); }).catch(error => { if (this.activeMessage === messageId)
                    this.fail(error); });
            }
            else if (protocol === 'antigravity')
                this.peer.send({ event: 'user', message: { content: text } });
            else
                this.peer.send({ type: 'user', session_id: this.nativeId, uuid: randomUUID(), parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text }] } });
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
    permission(id, permission, respond) {
        this.confirm();
        this.permissions.set(id, respond);
        this.agent.pendingPermissions.push({ ...permission, id });
    }
    async respond(id, answer) {
        const respond = this.permissions.get(id);
        if (!respond)
            throw new Error('This permission request is no longer pending');
        respond(answer);
        this.permissions.delete(id);
        this.agent.pendingPermissions = this.agent.pendingPermissions.filter(p => p.id !== id);
    }
    message(m) {
        if (m.method && m.id !== undefined) {
            this.request(m);
            return;
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
            if (this.agent.activeTurn && p.turn?.id)
                this.agent.activeTurn.turnId = p.turn.id;
        }
        if (m.method === 'turn/completed') {
            this.confirm();
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
        if (m.method === 'serverRequest/resolved') {
            const id = `rpc-${p.requestId}`;
            this.permissions.delete(id);
            this.agent.pendingPermissions = this.agent.pendingPermissions.filter(q => q.id !== id);
        }
        if (m.method === 'session/update') {
            const update = p.update ?? {};
            this.confirm();
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
            if (m.is_error || m.subtype !== 'success')
                this.fail(contentText(m.errors) || String(m.result ?? 'Claude turn failed'));
            else
                this.complete();
        }
    }
    request(m) {
        const p = m.params ?? {}, id = `rpc-${m.id}`;
        const reply = (result) => this.peer.send({ jsonrpc: '2.0', id: m.id, result });
        if (m.method === 'session/request_permission') {
            const options = list(p.options);
            this.permission(id, { kind: 'tool', name: String(p.toolCall?.title ?? 'Tool'), detail: p.toolCall, actions: options.map(o => ({ id: String(o.optionId), label: String(o.name), behavior: String(o.kind).startsWith('allow') ? 'allow' : 'deny', scope: String(o.kind).endsWith('always') ? 'session' : 'once' })) }, answer => reply(answer.selectedActionId ? { outcome: { outcome: 'selected', optionId: answer.selectedActionId } } : { outcome: { outcome: 'cancelled' } }));
        }
        else if (m.method === 'item/tool/requestUserInput') {
            const questions = list(p.questions);
            this.permission(id, { kind: 'question', name: 'Question', input: { questions: questions.map(q => ({ ...q, header: q.header ?? q.id, options: list(q.options), allowOther: q.isOther === true })) } }, answer => reply({ answers: Object.fromEntries(questions.map(q => [q.id, { answers: answer.behavior === 'allow' ? [answer.answers?.[q.header ?? q.id] ?? ''] : [] }])) }));
        }
        else if (m.method === 'item/permissions/requestApproval') {
            this.permission(id, { kind: 'tool', name: 'Additional permissions', description: p.reason, detail: p.permissions }, answer => reply({ permissions: answer.behavior === 'allow' ? p.permissions : {}, scope: 'turn' }));
        }
        else if (m.method === 'item/commandExecution/requestApproval' || m.method === 'item/fileChange/requestApproval') {
            const decisions = list(p.availableDecisions).filter(d => typeof d === 'string');
            const choices = decisions.length ? decisions : ['accept', 'decline'];
            this.permission(id, { kind: 'tool', name: m.method.includes('commandExecution') ? 'Bash' : 'Edit', description: p.reason, detail: p, actions: choices.map(decision => ({ id: decision, label: { accept: 'Allow once', acceptForSession: 'Allow for this session', decline: 'Deny', cancel: 'Cancel' }[decision] ?? decision, behavior: decision.startsWith('accept') ? 'allow' : 'deny' })) }, answer => reply({ decision: answer.selectedActionId ?? (answer.behavior === 'allow' ? 'accept' : 'decline') }));
        }
        else
            this.peer.send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `Client method not supported: ${m.method}` } });
    }
    claudeRequest(m) {
        const request = m.request ?? {};
        const reply = (response) => this.peer.send({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response } });
        if (request.subtype !== 'can_use_tool') {
            reply({});
            return;
        }
        const name = String(request.tool_name ?? 'Tool');
        this.permission(`claude-${m.request_id}`, { name, kind: name === 'AskUserQuestion' ? 'question' : name === 'ExitPlanMode' ? 'plan' : 'tool', input: request.input, detail: request.input }, answer => {
            const answers = answer.answers && name === 'AskUserQuestion'
                ? Object.fromEntries(questionsOf(request.input).map(question => [question.question, answer.answers[question.header]]))
                : answer.answers;
            reply(answer.behavior === 'allow' ? { behavior: 'allow', updatedInput: { ...request.input, ...(answers ? { answers } : {}) } } : { behavior: 'deny', message: answer.message ?? 'The user denied this request' });
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
                this.peer.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: this.nativeId } });
            else if (protocol === 'antigravity') {
                this.interrupting = true;
                this.peer.send({ event: 'dsh_interrupt' });
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
    close() { this.intentionalClose = true; this.peer.close(); this.complete('canceled'); this.agent.status = 'closed'; }
}
