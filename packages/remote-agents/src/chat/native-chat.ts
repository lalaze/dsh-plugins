import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { join } from 'node:path';
import {
  createToolResultMessage, createUserMessage, LlmAdapter, LlmError, MessageId, ReasoningEffortId, ToolCallId,
  type ContentBlock, type GenerateOptions, type LlmModelInfo, type LlmResolvedModelInfo, type StreamChunk,
} from '@deepseek-ai/dsh-llm';
import type { Session } from '@deepseek-ai/dsh-session';
import { busy, fastTierOf, inputModalitiesOf, presetMode, remotePath, type Cursor, type DshPermission, type Model, type TimelineEntry } from '../core/domain.js';
import { localFileMentions, localFilePrompt, restoreFiles, stageAttachments, stageLocalFiles, type AttachmentAccess } from '../agents/attachments.js';
import { CHAT_IMAGES, ChatImageLinks, chatImageName, imageExtensionOf, saveChatImage, viewedImageMarkdown, writeChatImage } from './images.js';
import { ChatProjects } from './projects.js';
import { modelSwitchNote, ownTurnWaitNote, toolStatus, transcript, type TurnSource } from './transcript.js';
import { decidePermission, unattendedAnswer } from '../agents/tools.js';
import { isTeamPrompt, teamMemberNote, type TeamMember } from './agent-teams.js';
import type { ToolHost } from '../core/dsh-host.js';
import type { WorkspacePlacement } from '../workspace/access.js';

export const CHAT_PROVIDER = 'remote-cli';
/** Wakes a conversation whose remote turn outlived DSH, so the missed output streams in without a new message. */
export const SYNC_SOURCE = 'remote-cli-sync';
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap { 'remote-cli-sync': { readonly kind: 'remote-cli-sync'; readonly form: 'notice'; readonly summary: string } }
}
/** DSH's PTC executor declares these log-only nested-call events; the chat renders them under their root call. */
interface NestedCall { rootCallId: ReturnType<typeof ToolCallId>; parentCallId: ReturnType<typeof ToolCallId>; subCallId: ReturnType<typeof ToolCallId>; name: string; arguments: unknown }
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'tool/ptc-dispatch-start': NestedCall;
    'tool/ptc-dispatch': NestedCall & { isError: boolean; content: ContentBlock[] };
  }
}
/** The parts of a live DSH agent that a catch-up wake needs. */
export interface SyncAgent {
  readonly session: Pick<Session, 'id' | 'requestHeader'>;
  send(message: ReturnType<typeof createUserMessage>, target: 'next-turn', wakeup: boolean): void;
}
/** Wakes a conversation to show what its remote CLI did meanwhile; nothing is sent to the CLI. */
const notice = (summary: string, shown = 'It is shown below') => createUserMessage({ source: { kind: SYNC_SOURCE, form: 'notice', summary },
  content: [{ type: 'text', text: `${summary}. ${shown}; no new request was sent to the remote CLI.` }] });
/** How long a turn without a recorded end must have been quiet before it is shown as ended. */
const QUIET_MS = 60_000;
/**
 * How long a turn shown as it goes outlasts the running status of the DSH driving it. When that DSH goes away, nothing
 * is recorded until its lease expires, another DSH takes the CLI over within a quarter of the lease (45 s by default),
 * and the relay replays what it missed.
 */
const LAPSE_MS = 120_000;
/**
 * Claude writes its progress between tool calls as short thinking blocks, about 100 characters and under 400 in real logs,
 * and its real thinking stays hidden. DSH folds a step's reasoning under its first text, so those sentences go in the reply.
 * A block longer than this is real thinking from another model or release: the rest of it stays reasoning.
 */
const PROGRESS_LIMIT = 1000;
/** Finished turns this conversation did not send, ready to show: one markdown block and the last message among them. */
/** `running`: the last turn has not ended; its output so far is in `text`, and what it writes next follows this cursor. */
interface Elsewhere { text: string; summary: string; lastMessageId: string; turns: number; writing?: boolean; running?: Cursor }
const CLI_NAMES: Readonly<Record<string, string>> = { claude: 'Claude', codex: 'Codex', dsh: 'DeepSeek Harness', antigravity: 'Antigravity', grok: 'Grok', codebuddy: 'CodeBuddy Code' };
export const chatProviderId = (cli: string) => `remote-cli-${cli}`;
/** The old aggregate route stays resolvable for saved conversations, with an empty picker catalog. */
export const CHAT_PROVIDERS = [CHAT_PROVIDER, ...Object.keys(CLI_NAMES).map(chatProviderId)];
export interface ChatHost extends Partial<ToolHost> {
  agent(sessionId: NonNullable<GenerateOptions['sessionId']>): unknown;
  cwd?(sessionId: NonNullable<GenerateOptions['sessionId']>): string | undefined;
  workspace?(cwd: string, signal?: AbortSignal): Promise<WorkspacePlacement>;
  step(sessionId: NonNullable<GenerateOptions['sessionId']>): { session: Session; turn: number; step: number } | undefined;
  userContent?(sessionId: NonNullable<GenerateOptions['sessionId']>, messageId: string): readonly ContentBlock[] | undefined;
  /** The conversation's permission from the DSH composer; undefined for a custom value or without permission presets. */
  permission?(sessionId: NonNullable<GenerateOptions['sessionId']>): DshPermission | undefined;
  /** A delegated subagent nobody answers (DSH approval policy `never`): the CLI must not wait for approvals or answers. */
  unattended?(sessionId: NonNullable<GenerateOptions['sessionId']>): boolean;
  /** The AgentTeams team and member this conversation runs as, when it is a team member. */
  teamMember?(sessionId: NonNullable<GenerateOptions['sessionId']>): TeamMember | undefined;
  /** Whether the conversation's CLI runs in its terminal, as a TUI conversation's does. */
  tui?(sessionId: NonNullable<GenerateOptions['sessionId']>): boolean;
  /** A file from the conversation's verified remote workspace, or undefined when it is too large to show. */
  image?(sessionId: NonNullable<GenerateOptions['sessionId']>, path: string, signal: AbortSignal): Promise<Uint8Array | undefined>;
  /** A file the CLI looked at by absolute path on the conversation's verified machine, inside the workspace or not; undefined when too large. */
  viewedImage?(sessionId: NonNullable<GenerateOptions['sessionId']>, path: string, signal: AbortSignal): Promise<Uint8Array | undefined>;
  attachments?: AttachmentAccess;
}
const hash = (...parts: string[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
/** DSH aborts streams with a cancel cause; disposal is a shutdown, not a user's Stop. */
const disposal = (reason: unknown) => !!reason && typeof reason === 'object' && ['disposed', 'released'].includes(String((reason as { kind?: unknown }).kind));
/** Whether a response shows this history entry. The rest, as usage, turn ends and empty reasoning, only keep its records. */
const showsOutput = ({ item }: TimelineEntry) => item.type === 'assistant_message' || item.type === 'reasoning' ? !!item.text : item.type === 'tool_call' || item.type === 'error' || item.type === 'model_switch';
const RELEASED = { kind: 'released' } as const;
/** What the CLI is asked to do: human messages and AgentTeams assignments, never context DSH injects. */
const prompted = (m: GenerateOptions['messages'][number]) => m.role === 'user' && (!m.source || m.source.kind === 'user' || isTeamPrompt(m.source));
/** How a /flow run ended, from dsh-model-flow: the one injected context the CLI needs, since other models did that work. */
const flowReport = (m: GenerateOptions['messages'][number]) => m.role === 'user' && (m.source as { kind?: string } | undefined)?.kind === 'model-flow';
const blockText = (content: readonly { type: string; text?: string }[]) => content.filter(b => b.type === 'text').map(b => b.text ?? '').join('\n');
/**
 * DSH frames title input as an instruction line followed by a JSON array of `{ text }` human
 * messages. Title the session from the first of them, never from the instruction itself.
 */
function sessionTitleOf(request: string): string {
  let text = request;
  const json = request.slice(request.indexOf('\n') + 1).trim();
  if (json.startsWith('[')) {
    try {
      const messages: unknown = JSON.parse(json);
      const first = Array.isArray(messages) ? (messages as ({ text?: unknown } | null)[]).map(m => typeof m?.text === 'string' ? m.text.trim() : '').find(Boolean) : undefined;
      if (first) text = first;
    } catch { /* Not DSH's framing: use the request text as before. */ }
  }
  return text.replace(/\s+/g, ' ').trim().slice(0, 80) || 'Remote CLI';
}
/** The DSH tool row that holds one response's remote tool calls. */
const REMOTE_TOOL = 'remote_cli';
/** A speed tier (Codex Fast) is a separate picker row: DSH model selections carry only a model and a reasoning effort. */
export const chatModelId = (projectId: string, provider: string, model: string, serviceTier?: string) => `${projectId}/${encodeURIComponent(provider)}/${encodeURIComponent(model)}${serviceTier ? `/${encodeURIComponent(serviceTier)}` : ''}`;

/**
 * Remote tools already execute inside the CLI. Record their lifecycle without dispatching a DSH tool: each runs as a
 * nested call under one row per response. A tool-call message in the streaming step would make a reopened or
 * reconnected DSH chat show that message and hide the CLI's text, and DSH rejects a stored log whose tool/call precedes
 * the message advertising it; its chat also drops nested calls that arrive before their row. So the whole row is
 * committed when the response ends: its tool-call message, its call, the nested calls, and a summary result.
 */
class NativeToolRows {
  private calls = new Map<string, NativeCall>();
  private settled: (NativeCall & { result: { text: string; isError: boolean } })[] = [];
  private finished = new Set<string>();
  private closed = false;
  private step?: { turn: number; step: number };
  private readonly session?: Session;
  constructor(context: ReturnType<ChatHost['step']>, private readonly options: GenerateOptions, private readonly title: string) {
    if (context) { this.session = context.session; this.step = { turn: context.turn, step: context.step }; }
  }
  write(entry: TimelineEntry): boolean {
    if (!this.session || !this.step || this.closed) return false;
    const item = entry.item, key = String(item.callId ?? entry.seqStart);
    if (this.finished.has(key)) return true;
    let call = this.calls.get(key);
    if (!call) {
      // Namespace native ids by DSH step: CLI call ids can repeat after a resume or a replay.
      call = { id: ToolCallId(`remote-${this.step.turn}-${this.step.step}-${hash(key).slice(0, 24)}`), name: typeof item.name === 'string' ? item.name : 'Remote tool',
        args: typeof item.detail === 'object' && item.detail !== null ? item.detail : {} };
      this.calls.set(key, call);
    }
    if (item.status !== 'running' && item.status !== 'pending') this.finish(key, typeof item.detail === 'string' ? item.detail : JSON.stringify(item.detail ?? {}), item.status === 'failed' || item.status === 'canceled');
    return true;
  }
  private finish(key: string, text: string, isError: boolean): void {
    const call = this.calls.get(key);
    if (!call) return;
    this.settled.push({ ...call, result: { text, isError } });
    this.calls.delete(key); this.finished.add(key);
  }
  close(text = 'Remote tool did not finish before this response ended.', isError = true): void {
    for (const key of this.calls.keys()) this.finish(key, text, isError);
    const session = this.session, step = this.step;
    if (!session || !step || this.closed || !this.settled.length) return;
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
interface NativeCall { id: ReturnType<typeof ToolCallId>; name: string; args: unknown }

export class RemoteCliAdapter extends LlmAdapter {
  private active = new Set<string>();
  private controllers = new Set<AbortController>();
  private released = false;
  private auxiliaryDirectories = new Map<string, string>();
  private woken = new Set<string>();
  constructor(readonly projects: ChatProjects, private readonly host: ChatHost, private readonly pollMs = 150, private readonly lapseMs = LAPSE_MS) { super(); }
  override providerInfo(provider: string) {
    const cli = Object.keys(CLI_NAMES).find(id => chatProviderId(id) === provider);
    return { id: provider, name: cli ? CLI_NAMES[cli] : 'Remote CLIs (legacy)' };
  }
  // Native turns are durable and at-most-once; the harness must not retry a failed CLI operation.
  override providerRetryPolicy() { return { mode: 'normal' as const, maxRetries: 0, retryableCodes: [], initialDelayMs: 1000, maxDelayMs: 1000, jitterRatio: 0 }; }
  override async listModels(provider: string): Promise<LlmModelInfo[]> {
    if (provider === CHAT_PROVIDER) return [];
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
  private route(providerRoute: string, modelId: string) {
    const [projectId, providerId, nativeModel, nativeTier, ...extra] = modelId.split('/');
    const project = this.projects.routes().find(p => p.id === projectId);
    let cli: string, model: string, serviceTier: string | undefined;
    try { cli = decodeURIComponent(providerId ?? ''); model = decodeURIComponent(nativeModel ?? ''); serviceTier = nativeTier === undefined ? undefined : decodeURIComponent(nativeTier); } catch { throw new LlmError('Invalid remote CLI model', 'INVALID_MODEL'); }
    const provider = project?.providers.find(p => p.id === cli && p.status === 'ready');
    const selected = provider?.models.find(m => m.id === model);
    const tierAvailable = serviceTier === undefined || !!selected?.serviceTiers?.some(t => t.id === serviceTier);
    if (!project || !provider || !selected || !tierAvailable || extra.length || (providerRoute !== CHAT_PROVIDER && providerRoute !== chatProviderId(provider.id))) throw new LlmError('This remote model is unavailable. Add its host or refresh models in Settings → Remote agents.', 'INVALID_MODEL');
    return { project, provider, model: selected, serviceTier };
  }
  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    signal?.throwIfAborted(); const route = this.route(provider, model);
    const advertised = (await this.listModels(provider)).find(m => m.id === model);
    // DSH picks a model's default effort whenever it is chosen in the menu: use the last explicit
    // selection while the model still offers it; otherwise use the CLI's own default.
    const defaultEffort = this.defaultEffort(model, route.model);
    return { provider, id: model, name: advertised?.name ?? route.model.label, inputModalities: inputModalitiesOf(route.provider.id, route.model),
      ...(route.model.thinkingOptions?.length ? { reasoning: { efforts: route.model.thinkingOptions.map(o => ({ id: ReasoningEffortId(o.id), name: o.label })),
        ...(defaultEffort ? { defaultEffort: ReasoningEffortId(defaultEffort) } : {}) } } : {}) };
  }
  /** Picker metadata and turns without an explicit effort must agree on the effective default. */
  private defaultEffort(route: string, model: Model): string | undefined {
    const remembered = this.projects.service.store.chatEffort(route);
    return remembered && model.thinkingOptions?.some(option => option.id === remembered) ? remembered : model.defaultThinkingOptionId;
  }
  /** Called when an advertised default effort changes, for the plugin to refresh DSH's model catalog. */
  onModelInfoChange(listener: () => void): () => void { return this.projects.onEffortChange(listener); }
  /**
   * Plugin unload or DSH shutdown: end local streams but leave remote turns running. A persistent
   * CLI keeps working; the conversation shows its remaining output with the next response.
   */
  close(): void { this.released = true; for (const controller of this.controllers) controller.abort(RELEASED); }
  /** The remote task a conversation's model route continues: the same route, or another model of the same CLI. */
  private bound(sessionId: string, route: string) {
    const store = this.projects.service.store;
    return store.task(t => t.chat?.sessionId === sessionId && t.chat.route === route)
      ?? store.task(t => t.chat?.sessionId === sessionId && route.startsWith(`${t.chat.route.split('/').slice(0, 2).join('/')}/`));
  }
  /** The conversation's remote task when its last response ended before all its output reached DSH. */
  private unsynced(sessionId: string, route: string) {
    const task = this.bound(sessionId, route);
    return task?.agentId && (task.chat?.history || task.chat?.delivered && !task.chat.delivered.done) ? task : undefined;
  }
  /**
   * Finished turns of a conversation's CLI session that the conversation never showed, because another DSH sharing the
   * host or Open sessions sent them, after the last turn it showed and before `until`, a message it just sent, and one
   * that is still running. Undefined when there are none, or when the turn the conversation showed last is no longer in
   * the history.
   */
  private async elsewhere(taskId: string, signal?: AbortSignal, until?: string): Promise<Elsewhere | undefined> {
    const service = this.projects.service, task = service.store.task(t => t.id === taskId), after = task?.chat?.delivered?.messageId;
    if (!task?.chat || task.chat.history || !after || after === until) return;
    // Read back from the end to the turn the conversation showed last, which is usually close to it.
    let entries: TimelineEntry[] = [], cursor: Cursor | undefined, end: Cursor | undefined, found = false, resets = 0;
    for (let pages = 0; pages < 100 && !found; pages++) {
      signal?.throwIfAborted();
      const page = await service.timeline(taskId, cursor, 'before');
      if (!page) return;
      // The history was replaced while it was read, as when another DSH took the session over: read it again.
      if (page.reset && cursor) { if (resets++ >= 3) return; entries = []; cursor = undefined; end = undefined; continue; }
      end ??= page.endCursor ?? undefined;
      const index = page.entries.findLastIndex(e => e.item.type === 'user_message' && e.item.clientMessageId === after);
      entries = [...page.entries.slice(index + 1), ...entries]; found = index >= 0;
      if (!page.hasOlder || !page.startCursor) break;
      cursor = page.startCursor;
    }
    const first = entries.findIndex(e => e.item.type === 'user_message');
    if (!found || first < 0) return;
    entries = entries.slice(first);
    const stop = until ? entries.findIndex(e => e.item.type === 'user_message' && e.item.clientMessageId === until) : -1;
    if (stop === 0) return;
    if (stop > 0) entries = entries.slice(0, stop);
    // Turns before `until` or before another message ended. The history says when the last one did. Without an end it is
    // running when the CLI is busy, and waits for a later look when not: right after another DSH sent a message its
    // running status may not have arrived yet. One left without an end, as by a CLI that vanished, counts as ended once
    // it has been quiet.
    const latest = entries.findLastIndex(e => e.item.type === 'user_message'), latestId = entries[latest]?.item.clientMessageId;
    const finished = !!until || entries.some(e => e.item.type === 'turn_end' && e.item.clientMessageId === latestId);
    const running = !finished && !!end && busy(await service.summary(taskId));
    if (!finished && !running && Date.now() - Date.parse(entries.at(-1)!.timestamp) <= QUIET_MS) entries = entries.slice(0, latest);
    // What a running CLI is still writing would be cut where this reading ends: following the turn picks it up whole.
    let resume = end, writing: string | undefined;
    if (running) {
      const written = entries.findLastIndex(e => e.item.type !== 'assistant_message' && e.item.type !== 'reasoning');
      if (written < entries.length - 1) writing = entries.slice(written + 1).map(e => e.item.type === 'assistant_message' ? String(e.item.text ?? '') : '').join('');
      resume = { epoch: end!.epoch, seq: entries[written].seqEnd };
      entries = entries.slice(0, written + 1);
    }
    const messages = entries.filter(e => e.item.type === 'user_message'), lastMessageId = messages.at(-1)?.item.clientMessageId;
    if (typeof lastMessageId !== 'string' || !lastMessageId) return;
    // Messages name the DSH that sent them since 0.2.75; a mix, or one without, reads as sent elsewhere. Turns the CLI
    // ran by itself, as after a background task finished, were sent by nobody: alone, they are headed as its own.
    const sent = messages.filter(e => e.item.unprompted !== true);
    const senders = sent.map(e => e.item.sentBy as { instance?: unknown; label?: unknown } | undefined);
    const [sender] = senders, label = typeof sender?.label === 'string' ? sender.label.replace(/\s+/g, ' ').replace(/[*_`[\]<>\\]/g, '').trim() : '';
    const from: TurnSource = typeof sender?.instance === 'string' && label && senders.every(s => s?.instance === sender.instance) ? service.sender(task.hostId, sender.instance, label) : undefined;
    const cli = CLI_NAMES[task.provider] ?? task.provider, turns = messages.length;
    const summary = sent.length ? `${cli} ${turns === 1 ? 'turn' : 'turns'} ${from && 'name' in from ? `on ${from.name}` : from ? 'in Open sessions' : 'sent elsewhere'}`
      : `${cli} continued on its own${turns > 1 ? `, ${turns} turns` : ''}`;
    return { text: transcript(entries, { cli, elsewhere: { from }, ...(writing !== undefined ? { writing } : {}) }).text, summary, lastMessageId, turns, ...(running ? { running: resume } : {}), ...(writing !== undefined ? { writing: true } : {}) };
  }
  /**
   * Show turns that another DSH sharing the host, or Open sessions, ran in this conversation's CLI session; one still
   * running streams on as it goes. Like `sync` it wakes the conversation with a notice and sends nothing to the CLI.
   */
  async catchUp(agent: SyncAgent): Promise<boolean> {
    const id = agent.session.id, config = agent.session.requestHeader()?.config;
    if (this.released || this.active.has(id) || !config || !CHAT_PROVIDERS.includes(config.provider)) return false;
    const task = this.bound(id, config.model);
    // A history or a cut-off response to show is `sync`'s; turns sent after it follow it in the same response.
    if (!task?.agentId || task.chat?.history || !task.chat?.delivered?.done) return false;
    const turns = await this.elsewhere(task.id).catch(() => undefined), key = turns && `${task.id}:elsewhere:${turns.lastMessageId}`;
    if (!key || this.woken.has(key) || this.released || this.active.has(id)) return false;
    this.woken.add(key);
    agent.send(notice(turns.summary, turns.turns === 1 ? 'It is shown below' : 'They are shown below'), 'next-turn', true);
    return true;
  }
  /**
   * Wake a conversation whose last remote response was cut off when DSH quit or reloaded the plugin. Its turn
   * streams the output produced meanwhile and waits for the remote turn to finish. Only a conversation still
   * routed to a remote CLI is woken: another model would answer the notice instead. A session continued from
   * another DSH is woken the same way to show its saved history; it has made no request yet, so it has no header.
   */
  sync(agent: SyncAgent): boolean {
    const id = agent.session.id, config = agent.session.requestHeader()?.config;
    if (this.released || this.active.has(id) || config && !CHAT_PROVIDERS.includes(config.provider)) return false;
    const task = config ? this.unsynced(id, config.model) : this.projects.service.store.task(t => t.chat?.sessionId === id && t.chat.history === 'pending' && !!t.agentId);
    const pending = task?.chat?.history ? 'history' : task?.chat?.delivered?.messageId;
    if (!task || !pending || this.woken.has(`${task.id}:${pending}`)) return false;
    this.woken.add(`${task.id}:${pending}`);
    const summary = pending === 'history' ? `Saved history of this ${CLI_NAMES[task.provider] ?? task.provider} session${task.shared?.creator ? `, started on ${task.shared.creator}` : ''}`
      : 'Remote CLI output produced while DSH was disconnected';
    agent.send(notice(summary), 'next-turn', true);
    return true;
  }
  /** A continued session's saved history, read from its start, as one markdown block. */
  private async history(taskId: string, signal: AbortSignal): Promise<ReturnType<typeof transcript> & { end?: Cursor }> {
    const service = this.projects.service, entries: TimelineEntry[] = [];
    let cursor: Cursor | undefined, resets = 0;
    while (true) {
      signal.throwIfAborted();
      const page = await service.timeline(taskId, cursor, 'after');
      if (!page) break;
      // The history was replaced while it was read, as when another DSH took the session over: read it again.
      if (page.reset && cursor && resets++ < 3) { entries.length = 0; cursor = undefined; continue; }
      entries.push(...page.entries);
      if (!page.hasNewer || !page.endCursor) { cursor = page.endCursor ?? cursor; break; }
      cursor = page.endCursor;
    }
    const task = service.store.task(t => t.id === taskId);
    return { ...transcript(entries, { cli: CLI_NAMES[task?.provider ?? ''] ?? task?.provider ?? 'Remote CLI', ...(task?.shared?.creator ? { creator: task.shared.creator } : {}) }), ...(cursor ? { end: cursor } : {}) };
  }
  override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    if (options.purpose === 'session-title') {
      const title = sessionTitleOf(options.messages.filter(m => m.role === 'user').map(m => blockText(m.content)).at(-1) ?? '');
      yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text: title };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: title } }; yield { type: 'finish', reason: { kind: 'stop' } }; return;
    }
    if (options.sessionId && this.host.tui?.(options.sessionId)) {
      // The CLI runs in the terminal and takes its messages there: a turn from anywhere else, such as another client, must
      // not start a second CLI beside it. Nothing reads the conversation's DSH history, so maintenance has nothing to do.
      const text = 'This conversation runs in its terminal.';
      yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }; yield { type: 'finish', reason: { kind: 'stop' } }; return;
    }
    if (options.purpose === 'compaction') {
      // Harness maintenance gets a disposable session, never an instruction injected into the live coding turn.
      const sessionId = `remote-compaction-${randomUUID()}` as NonNullable<GenerateOptions['sessionId']>;
      const cwd = options.sessionId ? this.host.cwd?.(options.sessionId) : undefined;
      if (cwd) this.auxiliaryDirectories.set(sessionId, cwd);
      const prompt = [options.system, ...options.messages.map(m => `${m.role}: ${blockText(m.content)}`)].filter(Boolean).join('\n\n');
      try { yield* this.stream({ ...options, purpose: undefined, sessionId, messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: `This is a conversation summarization request. Produce only the requested summary. Do not run commands, modify files, or use tools.\n\n${prompt}` }] })] }); }
      finally {
        this.auxiliaryDirectories.delete(sessionId);
        const task = this.projects.service.store.task(t => t.chat?.sessionId === sessionId);
        if (task) await this.projects.service.delete(task.id);
      }
      return;
    }
    const sessionId = options.sessionId;
    if (!sessionId) throw new LlmError('Select a remote CLI in a DSH conversation to use it.', 'SESSION_REQUIRED');
    // DSH adds context of its own after the notice, such as the time: the latest human message or notice decides.
    const final = options.messages.findLast(m => prompted(m) || m.role === 'user' && m.source?.kind === SYNC_SOURCE);
    const sync = final?.source?.kind === SYNC_SOURCE;
    if (this.active.has(sessionId)) throw new LlmError('This conversation already has a remote CLI response in progress.', 'REMOTE_BUSY');
    const { project, provider, model, serviceTier: routeTier } = this.route(options.provider, options.model), service = this.projects.service;
    // A route saved with a tier keeps it; otherwise the conversation's lightning switch picks the Fast tier.
    const serviceTier = routeTier ?? (service.store.chatFast(sessionId) ? fastTierOf(model)?.id : undefined);
    const lastUser = options.messages.findLast(prompted);
    // A conversation continued from another DSH starts with the notice that shows its history, before any message of its own.
    if (!sync && (!lastUser || lastUser.role !== 'user')) throw new LlmError('A user message is required for the remote CLI.', 'INVALID_REQUEST');
    const contentOf = (message: NonNullable<typeof lastUser>) => restoreFiles(message.content, message.id ? this.host.userContent?.(sessionId, message.id) : undefined);
    const content = lastUser ? contentOf(lastUser) : [];
    if (content.some(b => !['text', 'image', 'file'].includes(b.type))) throw new LlmError('This remote CLI input type is unsupported', 'UNSUPPORTED_INPUT');
    if (content.some(b => b.type === 'image' && !b.offloaded) && !inputModalitiesOf(provider.id, model).includes('image')) throw new LlmError('This remote CLI does not support image input', 'UNSUPPORTED_INPUT');
    const currentPrompt = blockText(content).trim() || (content.some(b => b.type === 'image' || b.type === 'file') ? 'Inspect the attached images and files.' : '');
    if (!currentPrompt && !sync) throw new LlmError('Enter a message for the remote CLI.', 'INVALID_REQUEST');
    const effort = options.reasoningEffort ?? this.defaultEffort(options.model, model);
    if (effort && !model.thinkingOptions?.some(o => o.id === effort)) throw new LlmError('This remote model does not support that thinking level.', 'INVALID_REQUEST');
    let task = service.store.task(t => t.chat?.sessionId === sessionId && t.chat.route === options.model)
      ?? service.store.task(t => t.chat?.sessionId === sessionId && t.chat.route.startsWith(`${project.id}/${encodeURIComponent(provider.id)}/`));
    // Recheck even saved routes: a previous model choice cannot authorize another workspace's machine.
    const selectedCwd = this.auxiliaryDirectories.get(sessionId) ?? this.host.cwd?.(sessionId);
    if (!selectedCwd) throw new LlmError('Choose a DSH workspace before starting a remote CLI conversation.', 'WORKSPACE_REQUIRED');
    const placement = await this.host.workspace?.(selectedCwd, options.signal);
    if (!placement?.cwd || !placement.hostIds.includes(project.hostId)) throw new LlmError('This remote model does not belong to the current workspace machine. Select a matching workspace and model.', 'WORKSPACE_MISMATCH');
    if (selectedCwd !== (this.auxiliaryDirectories.get(sessionId) ?? this.host.cwd?.(sessionId))) throw new LlmError('The workspace changed during verification. Select the model again.', 'WORKSPACE_MISMATCH');
    const cwd = remotePath(placement.cwd);
    if (task && task.cwd !== cwd || project.id !== project.hostId && project.cwd !== cwd) throw new LlmError('The remote conversation belongs to a different workspace directory. Start a new conversation.', 'WORKSPACE_MISMATCH');
    const userId = lastUser?.id ?? hash(JSON.stringify(options.messages));
    // A CLI that never started left only its first prompt. A new message starts afresh with that prompt as
    // context; retrying it would run the stale prompt first and reject this message as busy.
    if (!sync && task && !task.agentId && !this.active.has(sessionId) && task.id !== hash(hash(sessionId, task.chat?.receiptRoute ?? task.chat?.route ?? options.model), userId)) {
      await service.delete(task.id); task = undefined;
    }
    const binding = hash(sessionId, task?.chat?.receiptRoute ?? task?.chat?.route ?? options.model);
    const messageId = hash(binding, userId);
    const controller = new AbortController(), signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    signal.throwIfAborted();
    const currentIndex = lastUser ? options.messages.lastIndexOf(lastUser) : -1;
    // A bound CLI session already holds its own replies, including what sync turns showed, such as a continued session's
    // history: only human messages and other models' replies are context. A new session has none of them, so it gets all.
    const own = (m: (typeof options.messages)[number]) => {
      const source = m.role === 'assistant' ? m.source as { provider?: unknown; model?: unknown } | undefined : undefined;
      return !!task && !!source && CHAT_PROVIDERS.includes(String(source.provider)) && String(source.model ?? '').startsWith(`${project.id}/${encodeURIComponent(provider.id)}/`);
    };
    // Everything before the CLI's latest reply reached it too. The message sent last can be gone from the conversation,
    // as after editing or resending it, or a compaction: without this bound the whole history and its files went again.
    const previousIndex = task?.chat?.lastUserId ? options.messages.findIndex(m => m.id === task.chat?.lastUserId) : -1;
    const lastOwn = task ? options.messages.slice(0, Math.max(currentIndex, 0)).findLastIndex(own) : -1;
    const contextStart = Math.max(previousIndex + 1, lastOwn + 1);
    const previous = options.messages.slice(contextStart, currentIndex).filter(m => m.role === 'assistant' ? !own(m) : prompted(m) || flowReport(m))
      .map(m => `${m.role}: ${blockText(m.role === 'user' ? contentOf(m) : m.content)}`).filter(t => t.trim() !== 'user:' && t.trim() !== 'assistant:').join('\n\n');
    const unattended = this.host.unattended?.(sessionId) === true, member = this.host.teamMember?.(sessionId);
    // A team member's new CLI session learns once how the team tools replace the DSH tools it does not have.
    const note = member && !task ? `${teamMemberNote(member, unattended)}\n\n` : '';
    const prompt = note + (previous ? `Conversation context (already occurred; do not repeat completed actions):\n${previous}\n\nCurrent user request:\n${currentPrompt}` : currentPrompt);
    const taskId = task?.id ?? messageId;
    let admitted = false, settled = false, index = 0;
    /** The message is waiting for a turn the CLI started itself, which Stop then stops. */
    let waitingForOwnTurn = false;
    const rows = new NativeToolRows(this.host.step(sessionId), options, `${provider.label} on ${project.label}:${cwd}`);
    const questions = new Map<string, AbortController>(); let permissionFailure: unknown, permissionNotice = false;
    let open: { type: 'text' | 'reasoning'; index: number; text: string } | undefined;
    /** The latest closed text block, or an empty one in its place, which the line about running tools follows; and that line. */
    let tail: { index: number; text: string } | undefined, status = '';
    const endBlock = function* (): Generator<StreamChunk> {
      if (!open) return;
      yield { type: 'block-end', index: open.index, block: { type: open.type, text: open.text } };
      if (open.type === 'text') tail = { index: open.index, text: open.text };
      open = undefined;
    };
    /**
     * Show, change or clear the line about running tools. It is never saved, even when the turn is stopped: DSH keeps a block
     * as it closed and ignores what follows, while its chat goes on applying chunks. Text after a closed block therefore only
     * shows, and closing that block again takes the text back.
     */
    const setStatus = function* (next: string): Generator<StreamChunk> {
      if (next === status) return;
      yield* endBlock();
      if (status) yield { type: 'block-end', index: tail!.index, block: { type: 'text', text: tail!.text } };
      status = next;
      if (!next) return;
      // Nothing is written yet, so the line gets a block of its own. It saves as empty text, which every model route leaves out.
      if (!tail) {
        tail = { index: index++, text: '' };
        yield { type: 'block-start', index: tail.index, blockType: 'text' }; yield { type: 'block-end', index: tail.index, block: { type: 'text', text: '' } };
      }
      yield { type: 'text-delta', index: tail.index, text: `${tail.text ? '\n\n' : ''}${next}` };
    };
    const textChunk = function* (type: 'text' | 'reasoning', text: string): Generator<StreamChunk> {
      if (!text) return;
      yield* setStatus('');
      if (open?.type !== type) { yield* endBlock(); open = { type, index: index++, text: '' }; yield { type: 'block-start', index: open.index, blockType: type }; }
      open!.text += text;
      yield type === 'text' ? { type: 'text-delta', index: open!.index, text } : { type: 'reasoning-delta', index: open!.index, text };
    };
    // Remote CLIs name images by workspace path; the DSH chat can only show files on the DSH host.
    const imageDirectory = join(service.store.directory, CHAT_IMAGES);
    const images = new ChatImageLinks(async path => {
      const data = await this.host.image?.(sessionId, path, signal);
      return data && saveChatImage(imageDirectory, path, data);
    });
    // Images the CLI looked at with its tools, such as screenshots it read, appear in the reply where it read them, once each.
    // Codex's view_image names only a path; a DSH without the copy fetches it, each path once per reply.
    const shownImages = new Set<string>(), fetched = new Map<string, Promise<string | undefined>>();
    const fetchImage = (path: string) => {
      let local = fetched.get(path);
      if (!local) {
        local = (async () => {
          const data = await this.host.viewedImage?.(sessionId, path, signal), extension = data && imageExtensionOf(data);
          return extension ? writeChatImage(imageDirectory, chatImageName(data, extension), data) : undefined;
        })().catch(() => undefined);
        fetched.set(path, local);
      }
      return local;
    };
    const viewed = async function* (item: TimelineEntry['item']): AsyncGenerator<StreamChunk> {
      const markdown = await viewedImageMarkdown(imageDirectory, item.images, shownImages, fetchImage);
      if (markdown) { yield* textChunk('text', markdown); yield* endBlock(); }
    };
    // Record what reached this conversation, so output produced while DSH was away is shown later.
    let savedAt = 0, reached: { id: string; cursor: Cursor | undefined } | undefined, followed = false, unfinished = false;
    const delivered = async (id: string, cursor: Cursor | undefined, done = false, force = false) => {
      if (!done) reached = { id, cursor };
      // Progress is re-derivable: a lost second of this cursor only re-shows already-seen output, deduplicated by id.
      if (!done && !force && Date.now() - savedAt < 1000) return;
      savedAt = Date.now();
      await service.store.update(state => { const saved = state.tasks.find(t => t.id === taskId); if (saved?.chat) saved.chat.delivered = { messageId: id, cursor: cursor ?? null, ...(done ? { done: true } : {}) }; }).catch(() => {});
    };
    /**
     * Stream one message's output until its turn ends. A recovered turn reports failures as text. `patient`: a turn another
     * DSH drives, whose running status can lapse while that DSH goes away and another takes over; see {@link LAPSE_MS}.
     */
    const follow = async function* (id: string, from: Cursor | undefined, recovered: boolean, patient = false): AsyncGenerator<StreamChunk, boolean> {
      const interrupted = yield* timeline(id, from, recovered, patient);
      yield* setStatus('');
      yield* textChunk('text', images.flush());
      return interrupted;
    };
    const timeline = async function* (this: RemoteCliAdapter, id: string, from: Cursor | undefined, recovered: boolean, patient: boolean): AsyncGenerator<StreamChunk, boolean> {
      let cursor = from, interrupted = false, lapsed: number | undefined;
      /** Characters of the progress sentence being shown, when there is one; and the tools Claude is running. */
      let progress = 0;
      const running = new Map<string, TimelineEntry['item']>();
      while (true) {
        signal.throwIfAborted(); if (permissionFailure) throw permissionFailure;
        if (permissionNotice) {
          permissionNotice = false;
          yield* textChunk('reasoning', 'Approval is still pending. Open Remote agents to respond, or stop this turn.\n');
        }
        // State first, history second: the idle flag can be set just before the final append settles.
        const state = await service.state(taskId), page = await service.messageTimeline(taskId, id, cursor);
        if (!page.found) throw new LlmError('Remote message delivery was not recorded. Retry without changing the message.', 'REMOTE_DELIVERY_UNKNOWN');
        if (page.entries.length) lapsed = undefined;
        for (const entry of page.entries) {
          if (showsOutput(entry)) followed = true;
          if (progress && entry.item.type !== 'reasoning' && showsOutput(entry)) { yield* endBlock(); progress = 0; }
          if (entry.item.type === 'assistant_message') { yield* textChunk('text', await images.push(String(entry.item.text ?? ''))); continue; }
          yield* textChunk('text', images.flush());
          if (entry.item.type === 'reasoning') {
            const thought = String(entry.item.text ?? '');
            // What a delegated CLI writes is its result for whoever delegated: sentences about its progress stay out of it.
            if (provider.id !== 'claude' || unattended || member) yield* textChunk('reasoning', thought);
            // A hidden block between two sentences comes as empty deltas, so each sentence reads as its own paragraph.
            else if (!thought) { if (progress) yield* endBlock(); progress = 0; }
            else {
              if (!progress) yield* endBlock();
              progress += thought.length;
              yield* textChunk(progress <= PROGRESS_LIMIT ? 'text' : 'reasoning', thought);
            }
          }
          if (entry.item.type === 'tool_call') {
            yield* endBlock(); if (!rows.write(entry)) yield* textChunk('reasoning', `${entry.item.name ?? 'Tool'} · ${entry.item.status ?? ''}\n${typeof entry.item.detail === 'string' ? entry.item.detail : JSON.stringify(entry.item.detail ?? {})}\n`);
            yield* viewed(entry.item);
            // Whoever follows a delegated CLI has no other sign of what it does, whichever CLI it is.
            if (provider.id === 'claude' || unattended) {
              const call = String(entry.item.callId ?? entry.seqStart);
              if (entry.item.status === 'running') running.set(call, entry.item); else running.delete(call);
              yield* setStatus(toolStatus([...running.values()], currentPrompt));
            }
          }
          if (entry.item.type === 'error') { if (recovered) yield* textChunk('text', `\n\n${String(entry.item.message)}\n`); else throw new LlmError(String(entry.item.message), 'REMOTE_CLI_FAILED'); }
          if (entry.item.type === 'model_switch') yield* textChunk('text', `\n\n> ${modelSwitchNote(entry.item, currentPrompt)}\n\n`);
          if (entry.item.type === 'interrupted') interrupted = true;
        }
        cursor = page.endCursor ?? cursor;
        await delivered(id, cursor);
        for (const [key, pending] of questions) if (!state.permissions.some(p => p.id === key)) { pending.abort(); questions.delete(key); }
        for (const permission of state.permissions) {
          if (questions.has(permission.id)) continue;
          const agent = this.host.agent(sessionId), pending = new AbortController(); questions.set(permission.id, pending);
          if (!unattended && (!agent || !this.host.approval || !this.host.userQuestions)) throw new LlmError('DSH approvals are unavailable. Enable approval and userQuestions services before using remote CLI chat.', 'APPROVAL_UNAVAILABLE');
          const questionSignal = AbortSignal.any([signal, pending.signal]);
          // DSH rejects every prompt of an unattended subagent; deny here so the CLI goes on rather than cancelling the turn.
          void (unattended ? Promise.resolve(unattendedAnswer(permission)) : decidePermission({ approval: this.host.approval!, userQuestions: this.host.userQuestions! }, permission,
            { agent, callId: `remote-${taskId}-${permission.id}`, signal: questionSignal }, questionSignal, `${provider.label} on ${project.label}:${cwd}`))
            .then(async answer => {
              if (questionSignal.aborted) return;
              if (!answer) { permissionNotice = true; return; }
              await service.respond(taskId, permission.id, answer);
            }).catch(async error => {
              // The session panel or another client can answer while the native prompt is open.
              if (questionSignal.aborted) return;
              try { if ((await service.state(taskId)).permissions.some(p => p.id === permission.id)) permissionFailure = error; }
              catch { permissionFailure = error; }
            });
        }
        if (page.hasNewer) continue;
        if (!busy(state.agent) || page.hasFollowingMessage || page.terminalStatus) {
          // A followed turn ends by its record. Without one, nothing says it ended, however long it stays silent.
          if (patient && !page.hasFollowingMessage && !page.terminalStatus) {
            lapsed ??= Date.now();
            if (Date.now() - lapsed <= this.lapseMs) { await pause(this.pollMs, undefined, { signal }); continue; }
            unfinished = true;
          }
          if (recovered) return interrupted || page.terminalStatus === 'canceled';
          if (!page.deliveryConfirmed) throw new LlmError('Remote message delivery was not confirmed. It will not be resent automatically; send a new message to continue.', 'REMOTE_DELIVERY_UNKNOWN');
          if (page.terminalStatus === 'canceled') interrupted = true;
          if (page.terminalStatus === 'failed') throw new LlmError(state.agent.error ?? 'The remote CLI turn failed.', 'REMOTE_CLI_FAILED');
          if (!page.terminalStatus && !page.hasFollowingMessage) {
            if (!state.agent.attached && !interrupted) throw new LlmError('The remote CLI disconnected before this response finished. Saved output is shown; send a new message to resume its session.', 'REMOTE_TURN_INTERRUPTED');
            if (state.agent.status === 'error' || (state.agent.status === 'closed' && !interrupted)) throw new LlmError(state.agent.error ?? 'Remote CLI session ended', 'REMOTE_CLI_FAILED');
          }
          return interrupted;
        }
        lapsed = undefined;
        await pause(this.pollMs, undefined, { signal });
      }
    }.bind(this);
    if (this.active.has(sessionId)) throw new LlmError('This conversation already has a remote CLI response in progress.', 'REMOTE_BUSY');
    this.active.add(sessionId); this.controllers.add(controller);
    try {
      if (sync) {
        // A catch-up turn only shows what the remote CLI did meanwhile; it never sends anything.
        const saved = task && service.store.task(t => t.id === task!.id)?.chat, pending = saved?.delivered;
        let shown = true;
        if (saved?.history) {
          const { text, lastMessageId, end } = await this.history(taskId, signal);
          yield* textChunk('text', text);
          // A turn still running where the session was started streams on here, as a catch-up does.
          const following = !!lastMessageId && busy(await service.summary(taskId));
          await service.store.update(state => {
            const chat = state.tasks.find(t => t.id === taskId)?.chat;
            if (!chat) return;
            delete chat.history;
            if (lastMessageId) chat.delivered = { messageId: lastMessageId, cursor: end ?? null, ...(following ? {} : { done: true as const }) };
          });
          if (following) {
            admitted = true; yield* textChunk('text', '\n\n---\n\n');
            yield* follow(lastMessageId!, end, true);
            await delivered(lastMessageId!, undefined, true);
          }
          settled = true;
        } else if (pending && !pending.done) {
          admitted = true;
          yield* follow(pending.messageId, pending.cursor ?? undefined, true);
          settled = true; await delivered(pending.messageId, undefined, true);
          shown = followed;
        } else { settled = true; shown = false; }
        // Then the turns another DSH or Open sessions ran since, once they finished. A failed read leaves them for the next message.
        const turns = task && await this.elsewhere(taskId, signal).catch(() => undefined);
        signal.throwIfAborted();
        if (turns) {
          yield* endBlock(); yield* textChunk('text', `${index ? '\n\n---\n\n' : ''}${turns.text}`); shown = true;
          // A turn still running streams on after what it wrote so far. Stop here stops it, as it does any turn shown here.
          if (turns.running) {
            admitted = true; settled = false; reached = { id: turns.lastMessageId, cursor: turns.running };
            yield* textChunk('text', turns.writing ? '\n\n' : '\n\n---\n\n');
            yield* follow(turns.lastMessageId, turns.running, true, true);
            settled = true;
          }
          // What a followed turn writes after this one gave up on it still shows here, through `sync` or ahead of the next reply.
          if (unfinished) {
            yield* textChunk('text', '\n\nThe DSH running this turn went away. Any further output appears here later.');
            await delivered(reached!.id, reached!.cursor, false, true);
          } else await service.store.update(state => { const chat = state.tasks.find(t => t.id === taskId)?.chat; if (chat) chat.delivered = { messageId: turns.lastMessageId, cursor: null, done: true }; });
        }
        if (!shown) yield* textChunk('text', 'The remote CLI produced no further output.');
        yield* endBlock(); rows.close(); yield { type: 'finish', reason: { kind: 'stop' } }; return;
      }
      const blocks = options.messages.slice(contextStart, currentIndex + 1).flatMap(m => prompted(m) ? [...contentOf(m)] : []);
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
          ...(composerMode ? { modeId: composerMode } : provider.id === 'codex' ? { modeId: 'inherit' } : provider.id !== 'claude' && provider.defaultModeId ? { modeId: provider.defaultModeId } : {}), ...(effort ? { thinkingOptionId: effort } : {}), ...(serviceTier ? { serviceTier } : {}) },
        { title: currentPrompt.replace(/\s+/g, ' ').slice(0, 80), chat: { sessionId, route: options.model, lastUserId: userId }, ...(unattended ? { unattended } : {}), signal });
        if (!agent.started) throw new LlmError(agent.error ?? 'The remote CLI could not start. Retry this response.', 'REMOTE_START_FAILED');
      } else {
        // A receipt left by a failed HTTP/model response is replayed, never delivered again.
        if (!task.agentId) await service.retry(task.id, signal);
        const page = await service.messageTimeline(task.id, messageId);
        if (!page.found) {
          // A previous response may have continued while DSH was closed: show the rest before this one.
          const previous = service.store.task(t => t.id === task.id)?.chat?.delivered;
          if (previous && !previous.done && previous.messageId !== messageId) {
            const rest = await service.messageTimeline(task.id, previous.messageId, previous.cursor ?? undefined).catch(() => undefined);
            if (rest?.found && (rest.hasNewer || rest.entries.some(showsOutput) || busy(await service.summary(task.id)))) {
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
          if (mode && mode !== service.store.task(t => t.id === task.id)?.modeId) await service.setMode(task.id, mode);
          // Claude may be running a turn it started itself, as after a background task finished. As in its terminal, the
          // message waits for that turn to end. The turn shows here meanwhile (see `elsewhere`), ahead of the reply.
          let shownOwn = false;
          for (let summary = await service.summary(task.id), noted = false; busy(summary) && summary.unprompted; summary = await service.summary(task.id)) {
            waitingForOwnTurn = true;
            if (!noted) { noted = true; yield* textChunk('reasoning', `${ownTurnWaitNote(provider.label, currentPrompt)}\n`); yield* endBlock(); }
            const own = await this.elsewhere(task.id, signal).catch(() => undefined);
            if (!own?.running) { await pause(this.pollMs, undefined, { signal }); continue; }
            yield* textChunk('text', own.text);
            if (own.writing) yield* textChunk('text', '\n\n'); else yield* endBlock();
            shownOwn = true; reached = { id: own.lastMessageId, cursor: own.running };
            yield* follow(own.lastMessageId, own.running, true, true);
            await delivered(own.lastMessageId, undefined, true); reached = undefined;
          }
          waitingForOwnTurn = false;
          if (shownOwn) yield* textChunk('text', '\n\n---\n\n');
          admitted = true; await service.send(task.id, { id: messageId, text, ...(attachments.length ? { attachments } : {}) }, { interrupt: false, signal });
        } else admitted = true;
      }
      // A Stop or shutdown from here on concerns this message, even before any of its output is read.
      reached = { id: messageId, cursor: undefined };
      // Turns another DSH or Open sessions ran since this conversation's last response come first, in the order they ran.
      const turns = task && await this.elsewhere(taskId, signal, messageId).catch(() => undefined);
      if (turns) yield* textChunk('text', `${turns.text}\n\n---\n\n`);
      const receipt = await service.messageTimeline(taskId, messageId);
      if (!receipt.hasFollowingMessage) await service.store.update(state => { const saved = state.tasks.find(t => t.id === taskId); if (saved?.chat) saved.chat.lastUserId = userId; });
      const interrupted = yield* follow(messageId, undefined, false);
      settled = true; await delivered(messageId, undefined, true);
      yield* endBlock(); rows.close(); yield { type: 'finish', reason: interrupted ? { kind: 'aborted', failure: { code: 'ABORTED', message: 'The remote CLI turn was interrupted.' } } : { kind: 'stop' } };
    } catch (error) {
      yield* setStatus('');
      // DSH unloads the plugin before its turn loop on quit or reload. The remote turn keeps running and its output
      // catches up once DSH reattaches (see sync), so end this turn normally instead of recording a failure.
      if (!admitted || settled || options.signal?.aborted || !this.released && !service.stopped) throw error;
      yield* textChunk('text', images.flush()); yield* endBlock(); rows.close('Still running on the remote CLI; its result appears when DSH reconnects.', false);
      yield* textChunk('text', `${index ? '\n\n' : ''}DSH disconnected while the remote CLI was still working. It keeps running, and its output appears here when DSH reconnects.`);
      yield* endBlock(); yield { type: 'finish', reason: { kind: 'stop' } };
    } finally {
      for (const pending of questions.values()) pending.abort();
      // Only a user's Stop interrupts the remote turn. Shutdown and plugin reloads leave it running.
      const shutdown = this.released || service.stopped || disposal(controller.signal.reason) || disposal(options.signal?.reason);
      try {
        if (reached && !settled) await delivered(reached.id, reached.cursor, false, true);
        // A failed read while a message waits says nothing about the CLI's turn: only Stop ends that.
        const stops = waitingForOwnTurn ? signal.aborted : admitted && !settled;
        if (stops && !shutdown && service.store.task(t => t.id === taskId)) {
          await service.stop(taskId);
          // The CLI took the Stop, so this turn goes no further and nothing is left to catch up on. A CLI out of reach
          // never hears it and may still be running: what it writes then appears later, as after a disconnect.
          const agent = reached && await service.summary(taskId).catch(() => undefined);
          if (reached && agent?.attached && !busy(agent)) await delivered(reached.id, reached.cursor, true);
        }
      }
      finally { try { rows.close(); } finally { this.active.delete(sessionId); this.controllers.delete(controller); } }
    }
  }
}
