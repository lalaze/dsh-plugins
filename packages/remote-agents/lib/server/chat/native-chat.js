import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { join } from 'node:path';
import { createToolResultMessage, createUserMessage, LlmAdapter, LlmError, MessageId, ReasoningEffortId, ToolCallId, } from '@deepseek-ai/dsh-llm';
import { busy, fastTierOf, inputModalitiesOf, presetMode, remotePath } from '../core/domain.js';
import { localFileMentions, localFilePrompt, restoreFiles, stageAttachments, stageLocalFiles } from '../agents/attachments.js';
import { ChatImageLinks, saveChatImage } from './images.js';
import { decidePermission } from '../agents/tools.js';
export const CHAT_PROVIDER = 'remote-cli';
/** Wakes a conversation whose remote turn outlived DSH, so the missed output streams in without a new message. */
export const SYNC_SOURCE = 'remote-cli-sync';
const CLI_NAMES = { claude: 'Claude', codex: 'Codex', dsh: 'DeepSeek Harness', antigravity: 'Antigravity', grok: 'Grok', codebuddy: 'CodeBuddy Code' };
export const chatProviderId = (cli) => `remote-cli-${cli}`;
/** The old aggregate route stays resolvable for saved conversations, with an empty picker catalog. */
export const CHAT_PROVIDERS = [CHAT_PROVIDER, ...Object.keys(CLI_NAMES).map(chatProviderId)];
const hash = (...parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
/** DSH aborts streams with a cancel cause; disposal is a shutdown, not a user's Stop. */
const disposal = (reason) => !!reason && typeof reason === 'object' && ['disposed', 'released'].includes(String(reason.kind));
const RELEASED = { kind: 'released' };
const blockText = (content) => content.filter(b => b.type === 'text').map(b => b.text ?? '').join('\n');
/**
 * DSH frames title input as an instruction line followed by a JSON array of `{ text }` human
 * messages. Title the session from the first of them, never from the instruction itself.
 */
function sessionTitleOf(request) {
    let text = request;
    const json = request.slice(request.indexOf('\n') + 1).trim();
    if (json.startsWith('[')) {
        try {
            const messages = JSON.parse(json);
            const first = Array.isArray(messages) ? messages.map(m => typeof m?.text === 'string' ? m.text.trim() : '').find(Boolean) : undefined;
            if (first)
                text = first;
        }
        catch { /* Not DSH's framing: use the request text as before. */ }
    }
    return text.replace(/\s+/g, ' ').trim().slice(0, 80) || 'Remote CLI';
}
/** The DSH tool row that holds one response's remote tool calls. */
const REMOTE_TOOL = 'remote_cli';
/** A speed tier (Codex Fast) is a separate picker row: DSH model selections carry only a model and a reasoning effort. */
export const chatModelId = (projectId, provider, model, serviceTier) => `${projectId}/${encodeURIComponent(provider)}/${encodeURIComponent(model)}${serviceTier ? `/${encodeURIComponent(serviceTier)}` : ''}`;
/**
 * Remote tools already execute inside the CLI. Record their lifecycle without dispatching a DSH tool: each runs as a
 * nested call under one row per response. A tool-call message in the streaming step would make a reopened or
 * reconnected DSH chat show that message and hide the CLI's text, and DSH rejects a stored log whose tool/call precedes
 * the message advertising it; its chat also drops nested calls that arrive before their row. So the whole row is
 * committed when the response ends: its tool-call message, its call, the nested calls, and a summary result.
 */
class NativeToolRows {
    options;
    title;
    calls = new Map();
    settled = [];
    finished = new Set();
    closed = false;
    step;
    session;
    constructor(context, options, title) {
        this.options = options;
        this.title = title;
        if (context) {
            this.session = context.session;
            this.step = { turn: context.turn, step: context.step };
        }
    }
    write(entry) {
        if (!this.session || !this.step || this.closed)
            return false;
        const item = entry.item, key = String(item.callId ?? entry.seqStart);
        if (this.finished.has(key))
            return true;
        let call = this.calls.get(key);
        if (!call) {
            // Namespace native ids by DSH step: CLI call ids can repeat after a resume or a replay.
            call = { id: ToolCallId(`remote-${this.step.turn}-${this.step.step}-${hash(key).slice(0, 24)}`), name: typeof item.name === 'string' ? item.name : 'Remote tool',
                args: typeof item.detail === 'object' && item.detail !== null ? item.detail : {} };
            this.calls.set(key, call);
        }
        if (item.status !== 'running' && item.status !== 'pending')
            this.finish(key, typeof item.detail === 'string' ? item.detail : JSON.stringify(item.detail ?? {}), item.status === 'failed' || item.status === 'canceled');
        return true;
    }
    finish(key, text, isError) {
        const call = this.calls.get(key);
        if (!call)
            return;
        this.settled.push({ ...call, result: { text, isError } });
        this.calls.delete(key);
        this.finished.add(key);
    }
    close(text = 'Remote tool did not finish before this response ended.', isError = true) {
        for (const key of this.calls.keys())
            this.finish(key, text, isError);
        const session = this.session, step = this.step;
        if (!session || !step || this.closed || !this.settled.length)
            return;
        this.closed = true;
        const id = ToolCallId(`remote-${step.turn}-${step.step}-cli`), args = JSON.stringify({ description: this.title });
        session.append('assistant/message', { ...step, message: {
                id: MessageId(`${id}:call`), role: 'assistant', source: { kind: 'model', provider: this.options.provider, model: this.options.model },
                content: [{ type: 'tool-call', id, name: REMOTE_TOOL, arguments: args }],
            }, stream: [] }, { surfaceOp: 'append' });
        const seq = session.append('tool/call', { ...step, callId: id, name: REMOTE_TOOL, arguments: args }).seq;
        for (const { id: subCallId, name, args: callArgs, result } of this.settled) {
            const nested = { rootCallId: id, parentCallId: id, subCallId, name, arguments: callArgs };
            session.append('tool/ptc-dispatch-start', nested);
            session.append('tool/ptc-dispatch', { ...nested, isError: result.isError, content: [{ type: 'text', text: result.text }] });
        }
        const summary = this.settled.map(c => `${c.name} ${JSON.stringify(c.args)}${c.result.isError ? ' (failed)' : ''}\n${c.result.text}`).join('\n\n');
        session.append('tool/result', { ...step, message: createToolResultMessage({ callId: id, content: [{ type: 'text', text: summary }], isError: false }) }, { surfaceOp: 'append', sourceEventSeqs: [seq] });
    }
}
export class RemoteCliAdapter extends LlmAdapter {
    projects;
    host;
    pollMs;
    active = new Set();
    controllers = new Set();
    released = false;
    auxiliaryDirectories = new Map();
    modelInfoListeners = new Set();
    woken = new Set();
    constructor(projects, host, pollMs = 150) {
        super();
        this.projects = projects;
        this.host = host;
        this.pollMs = pollMs;
    }
    providerInfo(provider) {
        const cli = Object.keys(CLI_NAMES).find(id => chatProviderId(id) === provider);
        return { id: provider, name: cli ? CLI_NAMES[cli] : 'Remote CLIs (legacy)' };
    }
    // Native turns are durable and at-most-once; the harness must not retry a failed CLI operation.
    providerRetryPolicy() { return { mode: 'normal', maxRetries: 0, retryableCodes: [], initialDelayMs: 1000, maxDelayMs: 1000, jitterRatio: 0 }; }
    async listModels(provider) {
        if (provider === CHAT_PROVIDER)
            return [];
        const projects = this.projects.hosts();
        return projects.flatMap(project => {
            const host = this.projects.service.hosts().find(h => h.id === project.hostId);
            // One row per model: Codex's Fast speed is the composer's lightning switch. Routes saved with a tier still resolve.
            return project.providers.filter(p => p.status === 'ready' && chatProviderId(p.id) === provider).flatMap(p => p.models.map(m => ({
                provider, id: chatModelId(project.id, p.id, m.id), name: `${m.label} · ${host?.label ?? project.label}`,
                description: `${host?.label ?? project.label} · ${p.label}`, inputModalities: inputModalitiesOf(p.id, m),
            })));
        });
    }
    route(providerRoute, modelId) {
        const [projectId, providerId, nativeModel, nativeTier, ...extra] = modelId.split('/');
        const project = this.projects.routes().find(p => p.id === projectId);
        let cli, model, serviceTier;
        try {
            cli = decodeURIComponent(providerId ?? '');
            model = decodeURIComponent(nativeModel ?? '');
            serviceTier = nativeTier === undefined ? undefined : decodeURIComponent(nativeTier);
        }
        catch {
            throw new LlmError('Invalid remote CLI model', 'INVALID_MODEL');
        }
        const provider = project?.providers.find(p => p.id === cli && p.status === 'ready');
        const selected = provider?.models.find(m => m.id === model);
        const tierAvailable = serviceTier === undefined || !!selected?.serviceTiers?.some(t => t.id === serviceTier);
        if (!project || !provider || !selected || !tierAvailable || extra.length || (providerRoute !== CHAT_PROVIDER && providerRoute !== chatProviderId(provider.id)))
            throw new LlmError('This remote model is unavailable. Add its host or refresh models in Settings → Remote agents.', 'INVALID_MODEL');
        return { project, provider, model: selected, serviceTier };
    }
    async resolveModel(provider, model, signal) {
        signal?.throwIfAborted();
        const route = this.route(provider, model);
        const advertised = (await this.listModels(provider)).find(m => m.id === model);
        // DSH picks a model's default effort whenever it is chosen in the menu, so the default is the effort this
        // model last ran with, while the model still offers it; otherwise the CLI's own default.
        const remembered = this.projects.service.store.chatEffort(model);
        const defaultEffort = remembered && route.model.thinkingOptions?.some(o => o.id === remembered) ? remembered : route.model.defaultThinkingOptionId;
        return { provider, id: model, name: advertised?.name ?? route.model.label, inputModalities: inputModalitiesOf(route.provider.id, route.model),
            ...(route.model.thinkingOptions?.length ? { reasoning: { efforts: route.model.thinkingOptions.map(o => ({ id: ReasoningEffortId(o.id), name: o.label })),
                    ...(defaultEffort ? { defaultEffort: ReasoningEffortId(defaultEffort) } : {}) } } : {}) };
    }
    /** Called when an advertised default effort changes, for the plugin to refresh DSH's model catalog. */
    onModelInfoChange(listener) { this.modelInfoListeners.add(listener); return () => { this.modelInfoListeners.delete(listener); }; }
    /** Remember the effort a conversation turn uses with a model; compaction's disposable sessions do not count. */
    async rememberEffort(route, effort) {
        const store = this.projects.service.store;
        if (store.chatEffort(route) === effort)
            return;
        await store.update(state => { state.chatEfforts = { ...state.chatEfforts, [route]: effort }; });
        for (const listener of this.modelInfoListeners)
            listener();
    }
    /**
     * Plugin unload or DSH shutdown: end local streams but leave remote turns running. A persistent
     * CLI keeps working; the conversation shows its remaining output with the next response.
     */
    close() { this.released = true; for (const controller of this.controllers)
        controller.abort(RELEASED); }
    /** The conversation's remote task when its last response ended before all its output reached DSH. */
    unsynced(sessionId, route) {
        const service = this.projects.service;
        const task = service.store.task(t => t.chat?.sessionId === sessionId && t.chat.route === route)
            ?? service.store.task(t => t.chat?.sessionId === sessionId && route.startsWith(`${t.chat.route.split('/').slice(0, 2).join('/')}/`));
        return task?.agentId && task.chat?.delivered && !task.chat.delivered.done ? task : undefined;
    }
    /**
     * Wake a conversation whose last remote response was cut off when DSH quit or reloaded the plugin. Its turn
     * streams the output produced meanwhile and waits for the remote turn to finish. Only a conversation still
     * routed to a remote CLI is woken: another model would answer the notice instead.
     */
    sync(agent) {
        const config = agent.session.requestHeader()?.config;
        if (this.released || !config || !CHAT_PROVIDERS.includes(config.provider) || this.active.has(agent.session.id))
            return false;
        const task = this.unsynced(agent.session.id, config.model), pending = task?.chat?.delivered;
        if (!task || !pending || this.woken.has(`${task.id}:${pending.messageId}`))
            return false;
        this.woken.add(`${task.id}:${pending.messageId}`);
        const summary = 'Remote CLI output produced while DSH was disconnected';
        agent.send(createUserMessage({ source: { kind: SYNC_SOURCE, form: 'notice', summary },
            content: [{ type: 'text', text: `${summary}. It is shown below; no new request was sent to the remote CLI.` }] }), 'next-turn', true);
        return true;
    }
    async *stream(options) {
        if (options.purpose === 'session-title') {
            const title = sessionTitleOf(options.messages.filter(m => m.role === 'user').map(m => blockText(m.content)).at(-1) ?? '');
            yield { type: 'block-start', index: 0, blockType: 'text' };
            yield { type: 'text-delta', index: 0, text: title };
            yield { type: 'block-end', index: 0, block: { type: 'text', text: title } };
            yield { type: 'finish', reason: { kind: 'stop' } };
            return;
        }
        if (options.purpose === 'compaction') {
            // Harness maintenance gets a disposable session, never an instruction injected into the live coding turn.
            const sessionId = `remote-compaction-${randomUUID()}`;
            const cwd = options.sessionId ? this.host.cwd?.(options.sessionId) : undefined;
            if (cwd)
                this.auxiliaryDirectories.set(sessionId, cwd);
            const prompt = [options.system, ...options.messages.map(m => `${m.role}: ${blockText(m.content)}`)].filter(Boolean).join('\n\n');
            try {
                yield* this.stream({ ...options, purpose: undefined, sessionId, messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: `This is a conversation summarization request. Produce only the requested summary. Do not run commands, modify files, or use tools.\n\n${prompt}` }] })] });
            }
            finally {
                this.auxiliaryDirectories.delete(sessionId);
                const task = this.projects.service.store.task(t => t.chat?.sessionId === sessionId);
                if (task)
                    await this.projects.service.delete(task.id);
            }
            return;
        }
        const sessionId = options.sessionId;
        if (!sessionId)
            throw new LlmError('Select a remote CLI in a DSH conversation to use it.', 'SESSION_REQUIRED');
        const final = options.messages.at(-1), sync = final?.role === 'user' && final.source?.kind === SYNC_SOURCE;
        if (this.active.has(sessionId))
            throw new LlmError('This conversation already has a remote CLI response in progress.', 'REMOTE_BUSY');
        const { project, provider, model, serviceTier: routeTier } = this.route(options.provider, options.model), service = this.projects.service;
        // A route saved with a tier keeps it; otherwise the conversation's lightning switch picks the Fast tier.
        const serviceTier = routeTier ?? (service.store.chatFast(sessionId) ? fastTierOf(model)?.id : undefined);
        const lastUser = options.messages.findLast(m => m.role === 'user' && (!m.source || m.source.kind === 'user'));
        if (!lastUser || lastUser.role !== 'user')
            throw new LlmError('A user message is required for the remote CLI.', 'INVALID_REQUEST');
        const contentOf = (message) => restoreFiles(message.content, message.id ? this.host.userContent?.(sessionId, message.id) : undefined);
        const content = contentOf(lastUser);
        if (content.some(b => !['text', 'image', 'file'].includes(b.type)))
            throw new LlmError('This remote CLI input type is unsupported', 'UNSUPPORTED_INPUT');
        if (content.some(b => b.type === 'image' && !b.offloaded) && !inputModalitiesOf(provider.id, model).includes('image'))
            throw new LlmError('This remote CLI does not support image input', 'UNSUPPORTED_INPUT');
        const currentPrompt = blockText(content).trim() || (content.some(b => b.type === 'image' || b.type === 'file') ? 'Inspect the attached images and files.' : '');
        if (!currentPrompt)
            throw new LlmError('Enter a message for the remote CLI.', 'INVALID_REQUEST');
        const effort = options.reasoningEffort ?? model.defaultThinkingOptionId;
        if (effort && !model.thinkingOptions?.some(o => o.id === effort))
            throw new LlmError('This remote model does not support that thinking level.', 'INVALID_REQUEST');
        if (options.reasoningEffort && !this.auxiliaryDirectories.has(sessionId))
            void this.rememberEffort(options.model, options.reasoningEffort).catch(() => { });
        let task = service.store.task(t => t.chat?.sessionId === sessionId && t.chat.route === options.model)
            ?? service.store.task(t => t.chat?.sessionId === sessionId && t.chat.route.startsWith(`${project.id}/${encodeURIComponent(provider.id)}/`));
        // Recheck even saved routes: a previous model choice cannot authorize another workspace's machine.
        const selectedCwd = this.auxiliaryDirectories.get(sessionId) ?? this.host.cwd?.(sessionId);
        if (!selectedCwd)
            throw new LlmError('Choose a DSH workspace before starting a remote CLI conversation.', 'WORKSPACE_REQUIRED');
        const placement = await this.host.workspace?.(selectedCwd, options.signal);
        if (!placement?.cwd || !placement.hostIds.includes(project.hostId))
            throw new LlmError('This remote model does not belong to the current workspace machine. Select a matching workspace and model.', 'WORKSPACE_MISMATCH');
        if (selectedCwd !== (this.auxiliaryDirectories.get(sessionId) ?? this.host.cwd?.(sessionId)))
            throw new LlmError('The workspace changed during verification. Select the model again.', 'WORKSPACE_MISMATCH');
        const cwd = remotePath(placement.cwd);
        if (task && task.cwd !== cwd || project.id !== project.hostId && project.cwd !== cwd)
            throw new LlmError('The remote conversation belongs to a different workspace directory. Start a new conversation.', 'WORKSPACE_MISMATCH');
        const userId = lastUser.id ?? hash(JSON.stringify(options.messages));
        // A CLI that never started left only its first prompt. A new message starts afresh with that prompt as
        // context; retrying it would run the stale prompt first and reject this message as busy.
        if (!sync && task && !task.agentId && !this.active.has(sessionId) && task.id !== hash(hash(sessionId, task.chat?.receiptRoute ?? task.chat?.route ?? options.model), userId)) {
            await service.delete(task.id);
            task = undefined;
        }
        const binding = hash(sessionId, task?.chat?.receiptRoute ?? task?.chat?.route ?? options.model);
        const messageId = hash(binding, userId);
        const controller = new AbortController(), signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
        signal.throwIfAborted();
        const currentIndex = options.messages.lastIndexOf(lastUser);
        const previousIndex = task?.chat?.lastUserId ? options.messages.findIndex(m => m.id === task.chat?.lastUserId) : -1;
        const contextStart = previousIndex >= 0 ? previousIndex + 1 : 0;
        const previous = options.messages.slice(contextStart, currentIndex).filter(m => m.role === 'assistant' || (m.role === 'user' && (!m.source || m.source.kind === 'user')))
            .map(m => `${m.role}: ${blockText(m.role === 'user' ? contentOf(m) : m.content)}`).filter(t => t.trim() !== 'user:' && t.trim() !== 'assistant:').join('\n\n');
        const prompt = previous ? `Conversation context (already occurred; do not repeat completed actions):\n${previous}\n\nCurrent user request:\n${currentPrompt}` : currentPrompt;
        const taskId = task?.id ?? messageId;
        let admitted = false, settled = false, index = 0;
        const rows = new NativeToolRows(this.host.step(sessionId), options, `${provider.label} on ${project.label}:${cwd}`);
        const questions = new Map();
        let permissionFailure, permissionNotice = false;
        let open;
        const endBlock = function* () {
            if (open) {
                yield { type: 'block-end', index: open.index, block: { type: open.type, text: open.text } };
                open = undefined;
            }
        };
        const textChunk = function* (type, text) {
            if (!text)
                return;
            if (open?.type !== type) {
                yield* endBlock();
                open = { type, index: index++, text: '' };
                yield { type: 'block-start', index: open.index, blockType: type };
            }
            open.text += text;
            yield type === 'text' ? { type: 'text-delta', index: open.index, text } : { type: 'reasoning-delta', index: open.index, text };
        };
        // Remote CLIs name images by workspace path; the DSH chat can only show files on the DSH host.
        const images = new ChatImageLinks(async (path) => {
            const data = await this.host.image?.(sessionId, path, signal);
            return data && saveChatImage(join(service.store.directory, 'chat-images'), path, data);
        });
        // Record what reached this conversation, so output produced while DSH was away is shown later.
        let savedAt = 0, reached;
        const delivered = async (id, cursor, done = false, force = false) => {
            if (!done)
                reached = { id, cursor };
            if (!done && !force && Date.now() - savedAt < 250)
                return;
            savedAt = Date.now();
            await service.store.update(state => { const saved = state.tasks.find(t => t.id === taskId); if (saved?.chat)
                saved.chat.delivered = { messageId: id, cursor: cursor ?? null, ...(done ? { done: true } : {}) }; }).catch(() => { });
        };
        /** Stream one message's output until its turn ends. A recovered turn reports failures as text. */
        const follow = async function* (id, from, recovered) {
            const interrupted = yield* timeline(id, from, recovered);
            yield* textChunk('text', images.flush());
            return interrupted;
        };
        const timeline = async function* (id, from, recovered) {
            let cursor = from, interrupted = false;
            while (true) {
                signal.throwIfAborted();
                if (permissionFailure)
                    throw permissionFailure;
                if (permissionNotice) {
                    permissionNotice = false;
                    yield* textChunk('reasoning', 'Approval is still pending. Open Remote agents to respond, or stop this turn.\n');
                }
                // State first, history second: the idle flag can be set just before the final append settles.
                const state = await service.state(taskId), page = await service.messageTimeline(taskId, id, cursor);
                if (!page.found)
                    throw new LlmError('Remote message delivery was not recorded. Retry without changing the message.', 'REMOTE_DELIVERY_UNKNOWN');
                for (const entry of page.entries) {
                    if (entry.item.type === 'assistant_message') {
                        yield* textChunk('text', await images.push(String(entry.item.text ?? '')));
                        continue;
                    }
                    yield* textChunk('text', images.flush());
                    if (entry.item.type === 'reasoning')
                        yield* textChunk('reasoning', String(entry.item.text ?? ''));
                    if (entry.item.type === 'tool_call') {
                        yield* endBlock();
                        if (!rows.write(entry))
                            yield* textChunk('reasoning', `${entry.item.name ?? 'Tool'} · ${entry.item.status ?? ''}\n${typeof entry.item.detail === 'string' ? entry.item.detail : JSON.stringify(entry.item.detail ?? {})}\n`);
                    }
                    if (entry.item.type === 'error') {
                        if (recovered)
                            yield* textChunk('text', `\n\n${String(entry.item.message)}\n`);
                        else
                            throw new LlmError(String(entry.item.message), 'REMOTE_CLI_FAILED');
                    }
                    if (entry.item.type === 'interrupted')
                        interrupted = true;
                }
                cursor = page.endCursor ?? cursor;
                await delivered(id, cursor);
                for (const [key, pending] of questions)
                    if (!state.permissions.some(p => p.id === key)) {
                        pending.abort();
                        questions.delete(key);
                    }
                for (const permission of state.permissions) {
                    if (questions.has(permission.id))
                        continue;
                    const agent = this.host.agent(sessionId), pending = new AbortController();
                    questions.set(permission.id, pending);
                    if (!agent || !this.host.approval || !this.host.userQuestions)
                        throw new LlmError('DSH approvals are unavailable. Enable approval and userQuestions services before using remote CLI chat.', 'APPROVAL_UNAVAILABLE');
                    const questionSignal = AbortSignal.any([signal, pending.signal]);
                    void decidePermission({ approval: this.host.approval, userQuestions: this.host.userQuestions }, permission, { agent, callId: `remote-${taskId}-${permission.id}`, signal: questionSignal }, questionSignal, `${provider.label} on ${project.label}:${cwd}`)
                        .then(async (answer) => {
                        if (questionSignal.aborted)
                            return;
                        if (!answer) {
                            permissionNotice = true;
                            return;
                        }
                        await service.respond(taskId, permission.id, answer);
                    }).catch(async (error) => {
                        // The session panel or another client can answer while the native prompt is open.
                        if (questionSignal.aborted)
                            return;
                        try {
                            if ((await service.state(taskId)).permissions.some(p => p.id === permission.id))
                                permissionFailure = error;
                        }
                        catch {
                            permissionFailure = error;
                        }
                    });
                }
                if (page.hasNewer)
                    continue;
                if (!busy(state.agent) || page.hasFollowingMessage || page.terminalStatus) {
                    if (recovered)
                        return interrupted || page.terminalStatus === 'canceled';
                    if (!page.deliveryConfirmed)
                        throw new LlmError('Remote message delivery was not confirmed. It will not be resent automatically; send a new message to continue.', 'REMOTE_DELIVERY_UNKNOWN');
                    if (page.terminalStatus === 'canceled')
                        interrupted = true;
                    if (page.terminalStatus === 'failed')
                        throw new LlmError(state.agent.error ?? 'The remote CLI turn failed.', 'REMOTE_CLI_FAILED');
                    if (!page.terminalStatus && !page.hasFollowingMessage) {
                        if (!state.agent.attached && !interrupted)
                            throw new LlmError('The remote CLI disconnected before this response finished. Saved output is shown; send a new message to resume its session.', 'REMOTE_TURN_INTERRUPTED');
                        if (state.agent.status === 'error' || (state.agent.status === 'closed' && !interrupted))
                            throw new LlmError(state.agent.error ?? 'Remote CLI session ended', 'REMOTE_CLI_FAILED');
                    }
                    return interrupted;
                }
                await pause(this.pollMs, undefined, { signal });
            }
        }.bind(this);
        if (this.active.has(sessionId))
            throw new LlmError('This conversation already has a remote CLI response in progress.', 'REMOTE_BUSY');
        this.active.add(sessionId);
        this.controllers.add(controller);
        try {
            if (sync) {
                // A catch-up turn only shows what the remote CLI did meanwhile; it never sends anything.
                const pending = task && service.store.task(t => t.id === task.id)?.chat?.delivered;
                if (pending && !pending.done) {
                    admitted = true;
                    yield* follow(pending.messageId, pending.cursor ?? undefined, true);
                    settled = true;
                    await delivered(pending.messageId, undefined, true);
                }
                else {
                    settled = true;
                    yield* textChunk('text', 'The remote CLI produced no further output.');
                }
                yield* endBlock();
                rows.close();
                yield { type: 'finish', reason: { kind: 'stop' } };
                return;
            }
            const blocks = options.messages.slice(contextStart, currentIndex + 1).flatMap(m => m.role === 'user' && (!m.source || m.source.kind === 'user') ? [...contentOf(m)] : []);
            // DSH Desktop cites dropped non-image files by their path on this machine: send copies along with the attachments.
            const stageInput = async () => {
                const local = await stageLocalFiles(service.store.directory, taskId, messageId, localFileMentions(blockText(blocks), cwd), signal);
                const attachments = [...await stageAttachments(service.store.directory, taskId, messageId, blocks, this.host.attachments, signal), ...local.map(f => f.attachment)];
                return { attachments, text: localFilePrompt(prompt, taskId, messageId, local) };
            };
            if (!task) {
                const composerMode = presetMode(provider.id, provider.modes, this.host.permission?.(sessionId));
                const { attachments, text } = await stageInput();
                // A newly selected route receives prior human/assistant context, never local DSH tool schemas or its system prompt.
                admitted = true;
                const agent = await service.create({ id: taskId, hostId: project.hostId, cwd, provider: provider.id, model: model.id, prompt: text, ...(attachments.length ? { attachments } : {}),
                    // Native chats follow the DSH composer's permission. Without a matching mode Claude and Codex follow the
                    // remote CLI's own permission config; old cached Claude catalogs must not override it.
                    ...(composerMode ? { modeId: composerMode } : provider.id === 'codex' ? { modeId: 'inherit' } : provider.id !== 'claude' && provider.defaultModeId ? { modeId: provider.defaultModeId } : {}), ...(effort ? { thinkingOptionId: effort } : {}), ...(serviceTier ? { serviceTier } : {}) }, { title: currentPrompt.replace(/\s+/g, ' ').slice(0, 80), chat: { sessionId, route: options.model, lastUserId: userId }, signal });
                if (!agent.started)
                    throw new LlmError(agent.error ?? 'The remote CLI could not start. Retry this response.', 'REMOTE_START_FAILED');
            }
            else {
                // A receipt left by a failed HTTP/model response is replayed, never delivered again.
                if (!task.agentId)
                    await service.retry(task.id, signal);
                const page = await service.messageTimeline(task.id, messageId);
                if (!page.found) {
                    // A previous response may have continued while DSH was closed: show the rest before this one.
                    const previous = service.store.task(t => t.id === task.id)?.chat?.delivered;
                    if (previous && !previous.done && previous.messageId !== messageId) {
                        const rest = await service.messageTimeline(task.id, previous.messageId, previous.cursor ?? undefined).catch(() => undefined);
                        if (rest?.found && (rest.entries.length || busy(await service.summary(task.id)))) {
                            admitted = true;
                            yield* textChunk('text', 'Output from the previous response, completed while DSH was disconnected:\n\n');
                            yield* follow(previous.messageId, previous.cursor ?? undefined, true);
                            yield* textChunk('text', '\n\n---\n\n');
                        }
                        await delivered(previous.messageId, undefined, true);
                    }
                    const { attachments, text } = await stageInput();
                    await service.setModel(task.id, model.id, effort, options.model, serviceTier);
                    // The composer's permission wins over a mode chosen in Open sessions; a custom DSH permission keeps the saved mode.
                    const mode = presetMode(task.provider, task.modes ?? [], this.host.permission?.(sessionId));
                    if (mode && mode !== service.store.task(t => t.id === task.id)?.modeId)
                        await service.setMode(task.id, mode);
                    admitted = true;
                    await service.send(task.id, { id: messageId, text, ...(attachments.length ? { attachments } : {}) }, { interrupt: false, signal });
                }
                else
                    admitted = true;
            }
            const receipt = await service.messageTimeline(taskId, messageId);
            if (!receipt.hasFollowingMessage)
                await service.store.update(state => { const saved = state.tasks.find(t => t.id === taskId); if (saved?.chat)
                    saved.chat.lastUserId = userId; });
            const interrupted = yield* follow(messageId, undefined, false);
            settled = true;
            await delivered(messageId, undefined, true);
            yield* endBlock();
            rows.close();
            yield { type: 'finish', reason: interrupted ? { kind: 'aborted', failure: { code: 'ABORTED', message: 'The remote CLI turn was interrupted.' } } : { kind: 'stop' } };
        }
        catch (error) {
            // DSH unloads the plugin before its turn loop on quit or reload. The remote turn keeps running and its output
            // catches up once DSH reattaches (see sync), so end this turn normally instead of recording a failure.
            if (!admitted || settled || options.signal?.aborted || !this.released && !service.stopped)
                throw error;
            yield* textChunk('text', images.flush());
            yield* endBlock();
            rows.close('Still running on the remote CLI; its result appears when DSH reconnects.', false);
            yield* textChunk('text', `${index ? '\n\n' : ''}DSH disconnected while the remote CLI was still working. It keeps running, and its output appears here when DSH reconnects.`);
            yield* endBlock();
            yield { type: 'finish', reason: { kind: 'stop' } };
        }
        finally {
            for (const pending of questions.values())
                pending.abort();
            // Only a user's Stop interrupts the remote turn. Shutdown and plugin reloads leave it running.
            const shutdown = this.released || service.stopped || disposal(controller.signal.reason) || disposal(options.signal?.reason);
            try {
                if (reached && !settled)
                    await delivered(reached.id, reached.cursor, false, true);
                if (admitted && !settled && !shutdown && service.store.task(t => t.id === taskId))
                    await service.stop(taskId);
            }
            finally {
                try {
                    rows.close();
                }
                finally {
                    this.active.delete(sessionId);
                    this.controllers.delete(controller);
                }
            }
        }
    }
}
