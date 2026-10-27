import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { createToolResultMessage, createUserMessage, LlmAdapter, LlmError, MessageId, ReasoningEffortId, ToolCallId, } from '@deepseek-ai/dsh-llm';
import { busy, inputModalitiesOf, remotePath } from './domain.js';
import { restoreFiles, stageAttachments } from './attachments.js';
import { decidePermission } from './tools.js';
export const CHAT_PROVIDER = 'remote-cli';
const CLI_NAMES = { claude: 'Claude', codex: 'Codex', dsh: 'DeepSeek Harness', antigravity: 'Antigravity', grok: 'Grok', codebuddy: 'CodeBuddy Code' };
export const chatProviderId = (cli) => `remote-cli-${cli}`;
/** The old aggregate route stays resolvable for saved conversations, with an empty picker catalog. */
export const CHAT_PROVIDERS = [CHAT_PROVIDER, ...Object.keys(CLI_NAMES).map(chatProviderId)];
const hash = (...parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const blockText = (content) => content.filter(b => b.type === 'text').map(b => b.text ?? '').join('\n');
/** A speed tier (Codex Fast) is a separate picker row: DSH model selections carry only a model and a reasoning effort. */
export const chatModelId = (projectId, provider, model, serviceTier) => `${projectId}/${encodeURIComponent(provider)}/${encodeURIComponent(model)}${serviceTier ? `/${encodeURIComponent(serviceTier)}` : ''}`;
/** Remote tools already execute inside the CLI. Record their lifecycle without dispatching a DSH tool. */
class NativeToolRows {
    options;
    calls = new Map();
    finished = new Set();
    step;
    session;
    constructor(context, options) {
        this.options = options;
        if (context) {
            this.session = context.session;
            this.step = { turn: context.turn, step: context.step };
        }
    }
    write(entry) {
        if (!this.session || !this.step)
            return false;
        const item = entry.item, key = String(item.callId ?? entry.seqStart);
        if (this.finished.has(key))
            return true;
        let call = this.calls.get(key);
        if (!call) {
            // Namespace native ids by DSH step: CLI call ids can repeat after a resume or a replay.
            const id = ToolCallId(`remote-${this.step.turn}-${this.step.step}-${hash(key).slice(0, 24)}`);
            const name = typeof item.name === 'string' ? item.name : 'Remote tool';
            const args = JSON.stringify(typeof item.detail === 'object' && item.detail !== null ? item.detail : {});
            this.session.append('assistant/message', { ...this.step, message: {
                    id: MessageId(`${id}:call`), role: 'assistant', source: { kind: 'model', provider: this.options.provider, model: this.options.model },
                    content: [{ type: 'tool-call', id, name, arguments: args }],
                }, stream: [] }, { surfaceOp: 'append' });
            const event = this.session.append('tool/call', { ...this.step, callId: id, name, arguments: args });
            call = { id, seq: event.seq };
            this.calls.set(key, call);
        }
        if (item.status !== 'running' && item.status !== 'pending')
            this.finish(key, typeof item.detail === 'string' ? item.detail : JSON.stringify(item.detail ?? {}), item.status === 'failed' || item.status === 'canceled');
        return true;
    }
    finish(key, text, isError) {
        const call = this.calls.get(key);
        if (!call || !this.session || !this.step)
            return;
        this.session.append('tool/result', { ...this.step, message: createToolResultMessage({ callId: call.id, content: [{ type: 'text', text }], isError }) }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] });
        this.calls.delete(key);
        this.finished.add(key);
    }
    close() { for (const key of this.calls.keys())
        this.finish(key, 'Remote tool did not finish before this response ended.', true); }
}
export class RemoteCliAdapter extends LlmAdapter {
    projects;
    host;
    pollMs;
    active = new Set();
    controllers = new Set();
    auxiliaryDirectories = new Map();
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
            return project.providers.filter(p => p.status === 'ready' && chatProviderId(p.id) === provider).flatMap(p => p.models.flatMap(m => [undefined, ...m.serviceTiers ?? []].map(tier => ({
                provider, id: chatModelId(project.id, p.id, m.id, tier?.id), name: `${m.label}${tier ? ` ${tier.label}` : ''} · ${host?.label ?? project.label}`,
                description: `${host?.label ?? project.label} · ${p.label}`, inputModalities: inputModalitiesOf(p.id, m),
            }))));
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
        return { provider, id: model, name: advertised?.name ?? route.model.label, inputModalities: inputModalitiesOf(route.provider.id, route.model),
            ...(route.model.thinkingOptions?.length ? { reasoning: { efforts: route.model.thinkingOptions.map(o => ({ id: ReasoningEffortId(o.id), name: o.label })),
                    ...(route.model.defaultThinkingOptionId ? { defaultEffort: ReasoningEffortId(route.model.defaultThinkingOptionId) } : {}) } } : {}) };
    }
    close() { for (const controller of this.controllers)
        controller.abort(); }
    async *stream(options) {
        if (options.purpose === 'session-title') {
            const title = options.messages.filter(m => m.role === 'user').map(m => blockText(m.content)).at(-1)?.replace(/\s+/g, ' ').slice(0, 80) || 'Remote CLI';
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
        if (this.active.has(sessionId))
            throw new LlmError('This conversation already has a remote CLI response in progress.', 'REMOTE_BUSY');
        const { project, provider, model, serviceTier } = this.route(options.provider, options.model), service = this.projects.service;
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
        const task = service.store.task(t => t.chat?.sessionId === sessionId && t.chat.route === options.model)
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
        const binding = hash(sessionId, task?.chat?.receiptRoute ?? task?.chat?.route ?? options.model);
        const userId = lastUser.id ?? hash(JSON.stringify(options.messages));
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
        let admitted = false, settled = false, interrupted = false, index = 0, cursor;
        const rows = new NativeToolRows(this.host.step(sessionId), options);
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
        if (this.active.has(sessionId))
            throw new LlmError('This conversation already has a remote CLI response in progress.', 'REMOTE_BUSY');
        this.active.add(sessionId);
        this.controllers.add(controller);
        try {
            const blocks = options.messages.slice(contextStart, currentIndex + 1).flatMap(m => m.role === 'user' && (!m.source || m.source.kind === 'user') ? [...contentOf(m)] : []);
            if (!task) {
                const attachments = await stageAttachments(service.store.directory, taskId, messageId, blocks, this.host.attachments, signal);
                // A newly selected route receives prior human/assistant context, never local DSH tool schemas or its system prompt.
                admitted = true;
                const agent = await service.create({ id: taskId, hostId: project.hostId, cwd, provider: provider.id, model: model.id, prompt, ...(attachments.length ? { attachments } : {}),
                    // Old cached Claude catalogs must not override remote permissions.
                    ...(provider.id !== 'claude' && provider.defaultModeId ? { modeId: provider.defaultModeId } : {}), ...(effort ? { thinkingOptionId: effort } : {}), ...(serviceTier ? { serviceTier } : {}) }, { title: currentPrompt.replace(/\s+/g, ' ').slice(0, 80), chat: { sessionId, route: options.model, lastUserId: userId }, signal });
                if (!agent.started)
                    throw new LlmError(agent.error ?? 'The remote CLI could not start. Retry this response.', 'REMOTE_START_FAILED');
            }
            else {
                // A receipt left by a failed HTTP/model response is replayed, never delivered again.
                if (!task.agentId)
                    await service.retry(task.id, signal);
                const page = await service.messageTimeline(task.id, messageId);
                if (!page.found) {
                    const attachments = await stageAttachments(service.store.directory, taskId, messageId, blocks, this.host.attachments, signal);
                    await service.setModel(task.id, model.id, effort, options.model, serviceTier);
                    admitted = true;
                    await service.send(task.id, { id: messageId, text: prompt, ...(attachments.length ? { attachments } : {}) }, { interrupt: false, signal });
                }
                else
                    admitted = true;
            }
            const receipt = await service.messageTimeline(taskId, messageId);
            if (!receipt.hasFollowingMessage)
                await service.store.update(state => { const saved = state.tasks.find(t => t.id === taskId); if (saved?.chat)
                    saved.chat.lastUserId = userId; });
            while (true) {
                signal.throwIfAborted();
                if (permissionFailure)
                    throw permissionFailure;
                if (permissionNotice) {
                    permissionNotice = false;
                    yield* textChunk('reasoning', 'Approval is still pending. Open Remote agents to respond, or stop this turn.\n');
                }
                // State first, history second: the idle flag can be set just before the final append settles.
                const state = await service.state(taskId), page = await service.messageTimeline(taskId, messageId, cursor);
                if (!page.found)
                    throw new LlmError('Remote message delivery was not recorded. Retry without changing the message.', 'REMOTE_DELIVERY_UNKNOWN');
                for (const entry of page.entries) {
                    if (entry.item.type === 'assistant_message')
                        yield* textChunk('text', String(entry.item.text ?? ''));
                    if (entry.item.type === 'reasoning')
                        yield* textChunk('reasoning', String(entry.item.text ?? ''));
                    if (entry.item.type === 'tool_call') {
                        yield* endBlock();
                        if (!rows.write(entry))
                            yield* textChunk('reasoning', `${entry.item.name ?? 'Tool'} · ${entry.item.status ?? ''}\n${typeof entry.item.detail === 'string' ? entry.item.detail : JSON.stringify(entry.item.detail ?? {})}\n`);
                    }
                    if (entry.item.type === 'error')
                        throw new LlmError(String(entry.item.message), 'REMOTE_CLI_FAILED');
                    if (entry.item.type === 'interrupted')
                        interrupted = true;
                }
                cursor = page.endCursor ?? cursor;
                for (const [id, pending] of questions)
                    if (!state.permissions.some(p => p.id === id)) {
                        pending.abort();
                        questions.delete(id);
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
                    settled = true;
                    break;
                }
                await pause(this.pollMs, undefined, { signal });
            }
            yield* endBlock();
            rows.close();
            yield { type: 'finish', reason: interrupted ? { kind: 'aborted', failure: { code: 'ABORTED', message: 'The remote CLI turn was interrupted.' } } : { kind: 'stop' } };
        }
        finally {
            for (const pending of questions.values())
                pending.abort();
            try {
                if (admitted && !settled && service.store.task(t => t.id === taskId))
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
