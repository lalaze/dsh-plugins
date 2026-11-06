import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-connection';
import { Activity, type Chunk } from './activity.js';
import { brief, flowText, runFlow, type ChildRequest, type ChildResult, type StepRow } from './engine.js';
import { API_PATH, createHandler } from './http.js';
import { DEFAULT_ROUNDS, MAX_ROUNDS, parseLine } from './line.js';
import { attachmentNote } from './prompts.js';
import { machineOf, OFF, relocate, resolveSpec, type CatalogModel, type Role, type Route, type Routes } from './routes.js';
import { rowText, type EffortOption, type LiveStep, type Locale } from './shared.js';
import { FlowStore, ReportStore } from './store.js';

/** The parts of DSH this plugin uses. */
interface ChildSession {
  header: { parentSession?: unknown };
  append(type: string, data: Record<string, unknown>): void;
}
interface LiveAgent { id: string; provider?: string; model?: string; phase?: { kind?: string; lastTurn?: number }; session: ChildSession & { deriveMessages?(): unknown[] } }
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

export async function apply(ctx: Context): Promise<void> {
  const host = ctx as unknown as Context & Host;
  const store = new FlowStore(join(stateDir(), 'config.json'));
  await store.open();
  const reports = new ReportStore(join(stateDir(), 'reports.json'));
  await reports.open();
  const running = new Map<string, { controller: AbortController; routes: Routes; goal: string; startedAt: number }>();
  const readOnly = new Set<string>();
  const failures = new Map<string, string | undefined>();
  // Rows in the chat are command results: the one way to add to a conversation without a model turn. Only this process knows the mark.
  const noteMark = `⁣${randomUUID()}`, stepMark = `⁣${randomUUID()}`;
  /** A step's row is a command that stays unfinished until the step ends, so DSH shows it running and the result lands in the same row. */
  interface OpenStep { title: () => string; elapsed: () => string; activity: Activity; parentId: string; childId?: string; done: Promise<RowResult>; commandId?: string }
  const openSteps = new Map<string, OpenStep>(), stepByCommand = new Map<string, OpenStep>(), stepByChild = new Map<string, OpenStep>();
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
    step: commandId => {
      const step = stepByCommand.get(commandId);
      return step && { title: step.title(), elapsed: step.elapsed(), activity: step.activity.current(), parentId: step.parentId, ...(step.childId ? { childId: step.childId } : {}) } satisfies LiveStep;
    },
    stop: commandId => {
      const step = stepByCommand.get(commandId), flow = step && running.get(step.parentId);
      flow?.controller.abort();
      return !!flow;
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

  async function chooseRoutes(agent: LiveAgent, overrides: Partial<Record<Role, string>>): Promise<Routes> {
    const models = await catalog(), machine = machineOf({ provider: agent.provider, model: agent.model }), saved = store.config;
    const pick = (role: Role): Route | undefined => {
      const spec = overrides[role];
      if (spec !== undefined) return OFF.has(spec.toLowerCase()) && role === 'plan' ? undefined : resolveSpec(spec, models, machine);
      const route = saved[role];
      return route && relocate(route, models, machine);
    };
    const implement = pick('implement'), review = pick('review'), plan = pick('plan');
    if (!implement || !review) throw new Error(say(`Choose the models first: Settings → Model flow, or /${COMMAND} impl=codex review=claude <goal>`, `请先选择模型：设置 → 模型分工，或者 /${COMMAND} impl=codex review=claude <目标>`));
    return { ...(plan ? { plan } : {}), implement, review };
  }
  function start(agent: LiveAgent, goal: string, routes: Routes, rounds: number, attachments: readonly Attachment[]): void {
    const controller = new AbortController();
    running.set(agent.id, { controller, routes, goal, startedAt: Date.now() });
    const note = async (text: string) => {
      try { await host.commands.execute(agent, `/${COMMAND} ${noteMark}${text}`, [], new AbortController().signal); }
      catch (error) { ctx.logger?.warn?.(`model flow: could not add a note: ${String(error)}`); }
    };
    const openRow = (title: string): StepRow => {
      const id = randomUUID(), startedAt = Date.now(), words = flowText(goal);
      let settle: (result: RowResult) => void = () => undefined;
      const step: OpenStep = { title: () => title, elapsed: () => words.time(Date.now() - startedAt), activity: new Activity(), parentId: agent.id, done: new Promise(resolve => { settle = resolve; }) };
      openSteps.set(id, step);
      // The command logs its start before it first waits, so rows keep the order of the steps.
      const executed = host.commands.execute(agent, `/${COMMAND} ${stepMark}${id}`, [], new AbortController().signal)
        .catch(error => { ctx.logger?.warn?.(`model flow: could not add a row: ${String(error)}`); });
      return {
        attach(childId) { step.childId = childId; stepByChild.set(childId, step); },
        async close({ kind, title: done, body }) {
          openSteps.delete(id);
          if (step.commandId) stepByCommand.delete(step.commandId);
          if (step.childId) stepByChild.delete(step.childId);
          settle({ kind, text: rowText({ title: done, ...(body ? { body } : {}), parentId: agent.id, ...(step.childId ? { childId: step.childId } : {}) }) });
          await executed;
        },
      };
    };
    // After the handler returns, so the first step's rows follow the "started" row.
    setTimeout(() => {
      void runFlow({ goal, routes, rounds, signal: controller.signal }, { run: runChild(agent, attachments), note, openRow, report: text => reports.put(agent.id, text) })
        .catch(error => note(`${String(error)}`))
        .finally(() => running.delete(agent.id));
    }, 0);
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
      if (input.startsWith(noteMark)) return { kind: 'success', text: input.slice(noteMark.length) };
      if (input.startsWith(stepMark)) {
        const step = openSteps.get(input.slice(stepMark.length));
        if (!step) return { kind: 'error' };
        step.commandId = commandId; stepByCommand.set(commandId, step);
        return step.done;
      }
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
        if (!host.subagents.list().includes('spawn')) return { kind: 'error', text: 'This DSH has no subagent provider "spawn".' };
        const presets = ctx.get('permissionPresets' as never) as Permissions | undefined;
        try { if (presets && presets.resolve(presets.current(agent.session)).sandbox === 'read-only') return { kind: 'error', text: say('This conversation is read-only, so the implementing model could not change files. Switch it to Workspace Write first.', '这个对话是只读权限，实现模型改不了文件。请先切换到 Workspace Write。', line.goal) }; }
        catch { /* A custom permission has no preset to read; the implementer reports what it could not do. */ }
        const routes = await chooseRoutes(agent, line.overrides), rounds = line.rounds ?? store.config.rounds ?? DEFAULT_ROUNDS;
        const goal = line.goal || say('Do what the attached images and files ask.', '按附件里的图片和文件的要求来做。');
        if (attachments.some(block => block.type === 'image')) {
          for (const role of ['plan', 'implement', 'review'] as const) {
            const route = routes[role];
            if (!route) continue;
            let modalities: readonly string[] | undefined;
            try { modalities = (await host.llm.resolveModelInfo(route.provider, route.model)).inputModalities; }
            catch { /* Unknown capabilities: let the step report any model failure. */ }
            if (modalities && !modalities.includes('image')) return { kind: 'error', text: say(
              `${flowText(goal).roleName(role)} model ${route.label} (${route.model}) does not support images.`,
              `${flowText(goal).roleName(role)}模型 ${route.label}（${route.model}）不支持图片。`, goal) };
          }
        }
        await titleFor(agent, goal);
        start(agent, goal, routes, rounds, attachments);
        // Rows show one line, so the part that changes comes first; the conversation's title carries the goal.
        return { kind: 'success', text: `${flowText(goal).started(routes, rounds, attachments.length)}\n${brief(goal, 160)}` };
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) };
      }
    },
  }));
  ctx.effect(() => () => { for (const flow of running.values()) flow.controller.abort(); });
}
