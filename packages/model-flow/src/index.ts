import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-connection';
import { Activity, firstLine, type Chunk } from './activity.js';
import { brief, flowText, hasCjk, runFlow, type ChildRequest, type ChildResult, type FlowEnd, type StepRow } from './engine.js';
import { API_PATH, createHandler } from './http.js';
import { DEFAULT_ROUNDS, MAX_ROUNDS, parseLine } from './line.js';
import { attachmentNote } from './prompts.js';
import { machineOf, machinesFor, misplaced, nameParts, OFF, resolveSpec, settle, type CatalogModel, type Place, type Role, type Route, type Routes } from './routes.js';
import { cut, MARK, MAX_STEP_BODY, rowText, type CardEnd, type CardState, type CardStep, type EffortOption, type LiveCard, type Locale } from './shared.js';
import { CardStore, FlowStore, ReportStore } from './store.js';

/** The parts of DSH this plugin uses. */
interface ChildSession {
  header: { parentSession?: unknown };
  append(type: string, data: Record<string, unknown>): void;
}
interface LiveAgent { id: string; provider?: string; model?: string; phase?: { kind?: string; lastTurn?: number }; session: ChildSession & { header: { cwd?: string }; deriveMessages?(): unknown[] } }
type RowResult = { kind: 'success' | 'error'; text?: string };
type PreStep = { kind: 'reject' } | { kind: 'enter'; messages: unknown[] };
interface Activation { childId: string; result: Promise<{ output: readonly { type: string; text?: string }[]; stopReason: string; diagnostic?: string }>; dispose(): Promise<void> }
/** Materialized DSH blocks; all payload fields are forwarded unchanged. */
interface Attachment { type: 'image' | 'file' }
interface Host {
  commands: {
    register(definition: { name: string; description: string; recordInput?: boolean; input?: { hint: string; attachments?: boolean }; handler(invocation: { commandId: string; agent: LiveAgent; rawInput: string; attachments?: readonly Attachment[] }): RowResult | Promise<RowResult> }): () => void;
    execute(agent: LiveAgent, line: string, attachments: readonly never[], signal: AbortSignal): Promise<unknown>;
  };
  subagents: { list(): readonly string[]; startActivation(spec: Record<string, unknown>): Promise<Activation> };
  llm: {
    listProviders(): { id: string; name: string }[];
    listModels(provider: string): Promise<{ provider: string; id: string; name: string }[]>;
    resolveModelInfo(provider: string, model: string): Promise<{ inputModalities?: readonly string[]; reasoning?: { efforts: readonly { id: string; label?: string; name?: string }[] } }>;
  };
}
interface Permissions { current(session: unknown): string; resolve(name: string): { sandbox: string } }
/** dsh-remote-agents' service `remoteAgentsMachines`, as far as a flow needs it; absent without that plugin. */
interface Machines { hosts(): { id: string; label: string }[]; resolve(path: string | undefined, signal?: AbortSignal): Promise<{ hostIds: string[]; cwd?: string }> }
declare module '@deepseek-ai/cordis' {
  interface Events {
    'agent/created'(payload: { agent: LiveAgent }): undefined | Promise<undefined>;
    'agent/error'(payload: { agent: LiveAgent; error: unknown }): void;
    'agent/assistant-stream'(payload: { agent: LiveAgent; frame: { type: string; chunk?: Chunk } }): void;
    'agent/pre-step'(payload: { agent: LiveAgent }, next: () => Promise<PreStep>): Promise<PreStep>;
  }
}

export const name = 'dsh-model-flow';
export const inject = ['connection', 'commands', 'subagents', 'llm'];
const COMMAND = 'flow';
const stateDir = () => join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'storages', name);
/**
 * DSH treats a session with no turn as blank: it shows the start page whatever rows the session holds, and hands the
 * session out again as the next new conversation. An empty finished turn makes it a conversation without calling a model.
 * The agent reads its last turn number once, so that has to move with the log or DSH later refuses to load it.
 */
function ensureConversation(agent: LiveAgent): void {
  if (agent.phase?.kind !== 'idle' || agent.phase.lastTurn || agent.session.deriveMessages?.().length) return;
  agent.session.append('turn/start', { turn: 1 });
  agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  agent.phase.lastTurn = 1;
}
/** remote-agents passes messages of this kind on to a remote CLI as context. */
const REPORT_SOURCE = 'model-flow';
const LABELS: Readonly<Record<Role, string>> = { plan: 'flow · plan', implement: 'flow · implement', review: 'flow · review' };

/** How a flow ended, with its report and the steps it went through, for a plugin that started it. */
export interface ModelFlowResult { end: CardEnd; report?: string; steps: CardStep[] }
export interface ModelFlowRun { done: Promise<ModelFlowResult>; stop(): void }
/**
 * What other DSH plugins may do, as the service `modelFlow`: run a flow in a conversation, as a typed /flow does, and
 * learn how it ended. `agent` is the conversation's live agent; `models` are /flow's plan=, impl= and review= values.
 * The conversation keeps its title. Starting rejects with the message /flow would show.
 */
export interface ModelFlowService {
  readonly version: 1;
  start(agent: unknown, input: { goal: string; rounds?: number; models?: Partial<Record<Role, string>>; attachments?: readonly unknown[] }): Promise<ModelFlowRun>;
}

export async function apply(ctx: Context): Promise<void> {
  const host = ctx as unknown as Context & Host;
  const store = new FlowStore(join(stateDir(), 'config.json'));
  await store.open();
  const reports = new ReportStore(join(stateDir(), 'reports.json'));
  await reports.open();
  const running = new Map<string, { controller: AbortController; routes: Routes; goal: string; startedAt: number }>();
  const readOnly = new Set<string>();
  const failures = new Map<string, string | undefined>();
  const saved = new CardStore(join(stateDir(), 'cards.json'));
  await saved.open();
  // Rows in the chat are command results: the one way to add to a conversation without a model turn. Only this process knows the mark.
  const cardMark = `${MARK}${randomUUID()}`;
  /** A step as its card shows it, with the latest thing its model said. */
  interface LiveStepState extends CardStep { startedAt: number; activity: Activity; said?: string }
  /** A flow's card is one command that stays unfinished until the flow ends, so DSH shows it running and the result lands in the same row. */
  interface Card { id: string; startedAt: number; controller: AbortController; state: Omit<CardState, 'steps'> & { steps: LiveStepState[] }; done: Promise<RowResult>; commandId?: string }
  const cards = new Map<string, Card>(), cardByCommand = new Map<string, Card>(), stepByChild = new Map<string, LiveStepState>();
  /** Typed /flow lines still being handled: while they run, their row draws nothing. */
  const typed = new Set<string>();
  const stepsOf = (card: Card, bodyLimit: number, now = Date.now()): CardStep[] => card.state.steps.map(({ startedAt, activity: _activity, said: _said, body, ...step }) => ({
    ...step, ...(step.ms === undefined && step.status === 'running' ? { ms: now - startedAt } : {}), ...(bodyLimit > 0 && body ? { body: cut(body, bodyLimit)! } : {}),
  }));
  /** What a card can still show if DSH stops before the flow ends. */
  const snapshot = (card: Card): CardState => {
    const { parentId, zh, rounds, planned } = card.state;
    return { parentId, zh, rounds, planned, steps: stepsOf(card, 4000).map(step => step.status === 'running' ? { ...step, ms: undefined } : step) };
  };
  const view = (card: Card): LiveCard => {
    const now = Date.now(), { parentId, zh, rounds, planned, end } = card.state, steps = card.state.steps;
    let activity = '';
    // A model goes quiet between its outputs; the card keeps its last line until it says something new.
    for (let index = steps.length - 1; index >= 0; index--) {
      const step = steps[index];
      if (step.status !== 'running') continue;
      const now = step.activity.current();
      if (now) step.said = now;
      activity = step.said ?? '';
      break;
    }
    return { parentId, zh, rounds, planned, ...(end ? { end } : {}), steps: stepsOf(card, 0, now), elapsed: (end ? card.startedAt + end.ms : now) - card.startedAt, ...(activity ? { activity } : {}) };
  };
  /** The newest typed /flow: the new-session page stays where it is after a command, so the client opens this conversation. */
  let lastCommand: { sessionId: string; at: number } | undefined;
  /** Replies outside a flow have no goal to take their language from; the client says which one it shows. */
  let locale: Locale = 'en';
  const say = (en: string, zh: string, text = '') => locale === 'zh' || /[\u3400-\u9fff]/u.test(text) ? zh : en;

  const catalog = async (): Promise<CatalogModel[]> => {
    const providers = host.llm.listProviders();
    const lists = await Promise.all(providers.map(async provider => {
      try { return (await host.llm.listModels(provider.id)).map(model => ({ provider: provider.id, providerName: provider.name, id: model.id, name: model.name })); }
      catch { return []; }
    }));
    return lists.flat();
  };
  const efforts = async (provider: string, model: string): Promise<EffortOption[]> => {
    const info = await host.llm.resolveModelInfo(provider, model);
    return (info.reasoning?.efforts ?? []).map(effort => ({ id: String(effort.id), label: effort.label ?? effort.name ?? String(effort.id) }));
  };
  ctx.connection.fetch.register({ path: API_PATH, methods: ['GET', 'POST'], requestBody: 'buffered', fetch: createHandler(store, {
    catalog, efforts,
    lastCommand: maxAge => lastCommand && Date.now() - lastCommand.at <= maxAge ? lastCommand.sessionId : undefined,
    setLocale: value => { locale = value; },
    card: commandId => {
      if (typed.has(commandId)) return { start: true };
      const live = cardByCommand.get(commandId);
      if (live) return { card: view(live) };
      const stale = saved.get(commandId);
      return stale ? { card: { ...stale, elapsed: 0, interrupted: true } } : {};
    },
    stepBody: (commandId, index) => cardByCommand.get(commandId)?.state.steps[index]?.body ?? saved.get(commandId)?.steps[index]?.body,
    stop: commandId => {
      const card = cardByCommand.get(commandId);
      if (!card || card.state.end) return false;
      card.controller.abort();
      return true;
    },
  }) });

  // Runs before the child's first turn and is durable in its log, so a child reopened later stays read-only.
  ctx.on('agent/created', ({ agent }) => {
    // DSH derives a session's preset from this knob, so a preset inherited from the parent (auto, full access) stops applying.
    if (readOnly.delete(agent.id)) agent.session.append('sandbox/mode', { mode: 'read-only', source: 'delegation' });
    return undefined;
  }, { global: true });
  // A child that fails often settles with no diagnostic at all; this is where the actual reason shows.
  ctx.on('agent/error', ({ agent, error }) => {
    if (failures.has(agent.id)) failures.set(agent.id, error instanceof Error ? error.message : String(error));
  }, { global: true });

  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    const step = stepByChild.get(agent.id);
    if (!step) return;
    if (frame.type === 'start') step.activity.restart();
    else if (frame.type === 'chunk' && frame.chunk) step.activity.push(frame.chunk);
  }, { global: true });

  // The conversation's model took no part in a flow. It hears how it ended with the next message, ahead of that message.
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next();
    if (decision.kind !== 'enter') return decision;
    const report = reports.take(agent.id);
    if (!report) return decision;
    const message = { id: randomUUID(), role: 'user', source: { kind: REPORT_SOURCE, form: 'notice', summary: flowText(report).reportSummary }, content: [{ type: 'text', text: report }] };
    return { ...decision, messages: [message, ...decision.messages] };
  }, { global: true });

  const runChild = (parent: LiveAgent, attachments: readonly Attachment[]) => async (request: ChildRequest): Promise<ChildResult> => {
    const childId = randomUUID();
    request.row.attach(childId);
    if (request.readOnly) readOnly.add(childId);
    failures.set(childId, undefined);
    let activation: Activation;
    try {
      activation = await host.subagents.startActivation({
        provider: 'spawn', childId, delivery: 'caller', signal: request.signal,
        label: `${LABELS[request.role]}${request.round > 0 ? ` ${request.round}` : ''}`,
        request: {
          prompt: [{ type: 'text', text: request.prompt + (attachments.length ? `\n\n${attachmentNote}` : '') }, ...attachments], parent,
          agentOptions: { provider: request.route.provider, model: request.route.model, ...(request.route.effort ? { reasoningEffort: request.route.effort } : {}) },
        },
      });
    } catch (error) { failures.delete(childId); throw error; }
    finally { readOnly.delete(childId); }
    // Stopping must end the flow even if the child never settles.
    let stop: () => void = () => undefined;
    const stopped = new Promise<never>((_, reject) => { stop = () => { void activation.dispose().catch(() => undefined); reject(new Error('stopped')); }; });
    if (request.signal.aborted) stop(); else request.signal.addEventListener('abort', stop, { once: true });
    try {
      const result = await Promise.race([activation.result, stopped]);
      const texts = result.output.flatMap(block => block.type === 'text' && block.text?.trim() ? [block.text.trim()] : []);
      const diagnostic = result.diagnostic || failures.get(childId);
      return { text: texts.join('\n\n'), ...(texts.length ? { closing: texts.at(-1)! } : {}), stopReason: result.stopReason, ...(diagnostic ? { diagnostic } : {}) };
    } finally { request.signal.removeEventListener('abort', stop); failures.delete(childId); }
  };

  /** Where the conversation works; undefined when nobody can tell, and Remote Agents judges each step as before. */
  async function placeOf(agent: LiveAgent): Promise<Place | undefined> {
    try {
      const machines = ctx.get('remoteAgentsMachines' as never) as Machines | undefined;
      if (!machines?.resolve) return undefined;
      let folder: string | undefined;
      try { folder = (ctx.get('workingDirectory' as never) as { get(session: unknown): string } | undefined)?.get(agent.session); } catch { /* The log's own folder below. */ }
      folder ||= agent.session.header.cwd;
      if (!folder) return undefined;
      const placement = await machines.resolve(folder, AbortSignal.timeout(10_000)), saved = machines.hosts();
      const here = placement.cwd ? placement.hostIds : [], name = saved.find(host => host.id === here[0])?.label;
      return { machines: here, saved: saved.map(host => host.id), local: !placement.cwd, ...(name ? { name } : {}) };
    } catch { return undefined; }
  }
  async function chooseRoutes(agent: LiveAgent, overrides: Partial<Record<Role, string>>, goal: string): Promise<Routes> {
    const [models, place] = await Promise.all([catalog(), placeOf(agent)]), saved = store.config;
    // A remote CLI only works in workspaces of its machine, so that machine's copy of each model is the one to use.
    const machines = machinesFor(place, machineOf({ provider: agent.provider, model: agent.model }));
    const pick = (role: Role): Route | undefined => {
      const spec = overrides[role];
      if (spec !== undefined) return OFF.has(spec.toLowerCase()) && role === 'plan' ? undefined : settle(resolveSpec(spec, models, machines[0]), models, machines);
      const route = saved[role];
      return route && settle(route, models, machines);
    };
    const implement = pick('implement'), review = pick('review'), plan = pick('plan');
    if (!implement || !review) throw new Error(say(`Choose the models first: Settings → Model flow, or /${COMMAND} impl=codex review=claude <goal>`, `请先选择模型：设置 → 模型分工，或者 /${COMMAND} impl=codex review=claude <目标>`));
    const routes = { ...(plan ? { plan } : {}), implement, review };
    const refusal = place && misplaced(routes, place, models, say('en', 'zh', goal) === 'zh');
    if (refusal) throw new Error(refusal);
    return routes;
  }
  function start(agent: LiveAgent, goal: string, routes: Routes, rounds: number, attachments: readonly Attachment[]): ModelFlowRun {
    const controller = new AbortController(), startedAt = Date.now();
    let resolveDone: (result: ModelFlowResult) => void = () => undefined;
    const done = new Promise<ModelFlowResult>(resolve => { resolveDone = resolve; });
    running.set(agent.id, { controller, routes, goal, startedAt });
    let settle: (result: RowResult) => void = () => undefined;
    const card: Card = { id: randomUUID(), startedAt, controller, state: { parentId: agent.id, zh: hasCjk(goal), rounds, planned: !!routes.plan, steps: [] }, done: new Promise(resolve => { settle = resolve; }) };
    cards.set(card.id, card);
    const persist = () => { if (card.commandId && !card.state.end) saved.put(card.commandId, snapshot(card)); };
    const openRow = ({ role, round, route }: { role: Role; round: number; route: Route }): StepRow => {
      const names = nameParts(route.provider, route.label);
      const step: LiveStepState = { role, round, model: names.name, ...(names.machine ? { machine: names.machine } : {}), status: 'running', startedAt: Date.now(), activity: new Activity() };
      card.state.steps.push(step);
      persist();
      return {
        attach(childId) { step.childId = childId; stepByChild.set(childId, step); persist(); },
        async close({ status, body }) {
          step.status = status; step.ms = Date.now() - step.startedAt;
          const kept = cut(body, MAX_STEP_BODY);
          if (kept) step.body = kept;
          // What went wrong reads in the card without opening the step.
          if (kept && (status === 'sentBack' || status === 'noVerdict' || status === 'failed')) step.note = firstLine(kept);
          if (step.childId) stepByChild.delete(step.childId);
          persist();
        },
      };
    };
    let executed: Promise<unknown> = Promise.resolve(), ended = false;
    const finish = async ({ report, ...end }: FlowEnd) => {
      if (ended) return;
      ended = true;
      card.state.end = end;
      const { parentId, zh, planned } = card.state;
      settle({ kind: end.kind === 'failed' || end.kind === 'noVerdict' ? 'error' : 'success', text: rowText({ title: flowText(goal).ended(end), ...(report ? { body: report } : {}), card: { parentId, zh, rounds, planned, steps: stepsOf(card, MAX_STEP_BODY), end } }) });
      resolveDone({ end, ...(report ? { report } : {}), steps: stepsOf(card, MAX_STEP_BODY) });
      await executed;
      cards.delete(card.id);
      for (const step of card.state.steps) if (step.childId) stepByChild.delete(step.childId);
      const commandId = card.commandId;
      if (commandId) {
        // Kept, ended, in case DSH stops before the chat has saved the result: the card can still say how the flow ended.
        saved.put(commandId, { ...snapshot(card), end });
        // A poll may still be on its way: it should find the finished card rather than nothing.
        setTimeout(() => cardByCommand.delete(commandId), 10_000).unref?.();
      }
    };
    // After the handler returns, so the card follows the /flow line.
    setTimeout(() => {
      executed = host.commands.execute(agent, `/${COMMAND} ${cardMark}${card.id}`, [], new AbortController().signal)
        .catch(error => { ctx.logger?.warn?.(`model flow: could not add the card: ${String(error)}`); });
      void runFlow({ goal, routes, rounds, signal: controller.signal }, { run: runChild(agent, attachments), openRow, finish, report: text => reports.put(agent.id, text) })
        .catch(error => finish({ kind: 'failed', role: card.state.steps.at(-1)?.role ?? 'plan', reason: error instanceof Error ? error.message : String(error), ms: Date.now() - startedAt }))
        // Whatever happened, the card must not stay running.
        .finally(() => { running.delete(agent.id); void finish({ kind: 'stopped', ms: Date.now() - startedAt }); });
    }, 0);
    return { done, stop: () => controller.abort() };
  }
  /** The checks and choices a flow starts with, whoever asks for it. Throws what the chat should say. */
  async function begin(agent: LiveAgent, input: { goal: string; rounds?: number; overrides: Partial<Record<Role, string>>; attachments: readonly Attachment[]; prepare?(goal: string): Promise<void> }): Promise<{ run: ModelFlowRun; goal: string; routes: Routes; rounds: number }> {
    const { attachments } = input;
    if (running.has(agent.id)) throw new Error(say(`A flow is already running here. /${COMMAND} stop ends it.`, `这个对话里已有流程在运行。/${COMMAND} stop 可以结束它。`, input.goal));
    if (!host.subagents.list().includes('spawn')) throw new Error('This DSH has no subagent provider "spawn".');
    const presets = ctx.get('permissionPresets' as never) as Permissions | undefined;
    let readOnlyParent = false;
    try { readOnlyParent = !!presets && presets.resolve(presets.current(agent.session)).sandbox === 'read-only'; }
    catch { /* A custom permission has no preset to read; the implementer reports what it could not do. */ }
    if (readOnlyParent) throw new Error(say('This conversation is read-only, so the implementing model could not change files. Switch it to Workspace Write first.', '这个对话是只读权限，实现模型改不了文件。请先切换到 Workspace Write。', input.goal));
    const routes = await chooseRoutes(agent, input.overrides, input.goal), rounds = input.rounds ?? store.config.rounds ?? DEFAULT_ROUNDS;
    const goal = input.goal || say('Do what the attached images and files ask.', '按附件里的图片和文件的要求来做。');
    if (attachments.some(block => block.type === 'image')) {
      for (const role of ['plan', 'implement', 'review'] as const) {
        const route = routes[role];
        if (!route) continue;
        let modalities: readonly string[] | undefined;
        try { modalities = (await host.llm.resolveModelInfo(route.provider, route.model)).inputModalities; }
        catch { /* Unknown capabilities: let the step report any model failure. */ }
        // A caller that started the flow itself can tell this refusal apart and try again without the pictures.
        if (modalities && !modalities.includes('image')) throw Object.assign(new Error(say(
          `${flowText(goal).roleName(role)} model ${route.label} (${route.model}) does not support images.`,
          `${flowText(goal).roleName(role)}模型 ${route.label}（${route.model}）不支持图片。`, goal)), { code: 'flow/images-unsupported' });
      }
    }
    await input.prepare?.(goal);
    // Another flow may have started here while the models were being looked up.
    if (running.has(agent.id)) throw new Error(say(`A flow is already running here. /${COMMAND} stop ends it.`, `这个对话里已有流程在运行。/${COMMAND} stop 可以结束它。`, goal));
    return { run: start(agent, goal, routes, rounds, attachments), goal, routes, rounds };
  }
  const titleFor = async (agent: LiveAgent, goal: string) => {
    if (agent.session.deriveMessages?.().length) return;
    const line = goal.split(/\r?\n/u).map(part => part.trim()).find(Boolean);
    const controller = ctx.get('sessionController' as never) as { rename?(input: { sessionId: string; title: string }): Promise<unknown> } | undefined;
    if (line) await controller?.rename?.({ sessionId: agent.id, title: [...line].slice(0, 60).join('').trim() }).catch(() => undefined);
  };

  ctx.effect(() => host.commands.register({
    name: COMMAND, recordInput: false,
    description: 'one model plans, one implements, one reviews, and rejected work goes back',
    input: { hint: '[plan=model] [impl=model] [review=model] [rounds=n] <goal> | stop', attachments: true },
    handler: async ({ commandId, agent, rawInput, attachments = [] }) => {
      const input = rawInput.trimStart();
      if (input.startsWith(cardMark)) {
        const card = cards.get(input.slice(cardMark.length));
        if (!card) return { kind: 'error', text: say('This flow is no longer running.', '这个流程已经不在运行。') };
        card.commandId = commandId; cardByCommand.set(commandId, card); saved.put(commandId, snapshot(card));
        return card.done;
      }
      if (commandId) typed.add(commandId);
      try { return await typedCommand(agent, rawInput, attachments); }
      finally { if (commandId) typed.delete(commandId); }
    },
  }));
  async function typedCommand(agent: LiveAgent, rawInput: string, attachments: readonly Attachment[]): Promise<RowResult> {
    lastCommand = { sessionId: agent.id, at: Date.now() };
    ensureConversation(agent);
    try {
      const line = parseLine(rawInput, attachments.length > 0), current = running.get(agent.id);
      if (line.kind === 'stop') {
        if (attachments.length) return { kind: 'error', text: say('Remove the attachments before using /flow stop.', '请先移除附件，再使用 /flow stop。') };
        if (!current) return { kind: 'error', text: say('No flow is running in this conversation.', '这个对话里没有正在运行的流程。') };
        current.controller.abort();
        return { kind: 'success', text: flowText(current.goal).stopped };
      }
      if (line.kind === 'status') {
        if (current) return { kind: 'success', text: `${flowText(current.goal).started(current.routes, store.config.rounds)}. ${brief(current.goal, 120)}` };
        const { plan, implement, review, rounds } = store.config;
        const usage = `/${COMMAND} [plan=model] [impl=model] [review=model] [rounds=1-${MAX_ROUNDS}] <goal>`;
        return { kind: 'success', text: say(
          `Plan: ${plan?.label ?? 'skipped'}. Implement: ${implement?.label ?? 'not chosen'}. Review: ${review?.label ?? 'not chosen'}. Up to ${rounds} review rounds. ${usage}`,
          `计划：${plan?.label ?? '跳过'}。实现：${implement?.label ?? '未选择'}。审核：${review?.label ?? '未选择'}。最多审核 ${rounds} 轮。${usage}`) };
      }
      if (current) return { kind: 'error', text: say(`A flow is already running here. /${COMMAND} stop ends it.`, `这个对话里已有流程在运行。/${COMMAND} stop 可以结束它。`, line.goal) };
      const { goal, routes, rounds } = await begin(agent, { goal: line.goal, ...(line.rounds ? { rounds: line.rounds } : {}), overrides: line.overrides, attachments, prepare: goal => titleFor(agent, goal) });
      // The card that follows is the flow, so this row draws nothing; the text is for DSH without this plugin.
      return { kind: 'success', text: rowText({ title: flowText(goal).started(routes, rounds, attachments.length), body: brief(goal, 160), start: true }) };
    } catch (error) {
      return { kind: 'error', text: error instanceof Error ? error.message : String(error) };
    }
  }
  const service: ModelFlowService = {
    version: 1,
    async start(agent, input) {
      const live = agent as LiveAgent, attachments = (input.attachments ?? []) as readonly Attachment[], goal = input.goal.trim();
      if (!goal && !attachments.length) throw new Error('A flow needs a goal.');
      if (input.rounds !== undefined && (!Number.isSafeInteger(input.rounds) || input.rounds < 1 || input.rounds > MAX_ROUNDS)) throw new Error(`rounds must be a whole number from 1 to ${MAX_ROUNDS}`);
      ensureConversation(live);
      return (await begin(live, { goal, ...(input.rounds ? { rounds: input.rounds } : {}), overrides: input.models ?? {}, attachments })).run;
    },
  };
  ctx.provide('modelFlow', service);
  ctx.effect(() => () => { for (const flow of running.values()) flow.controller.abort(); });
}
