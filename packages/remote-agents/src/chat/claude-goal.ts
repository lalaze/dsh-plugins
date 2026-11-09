import { randomUUID, randomBytes } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import type { Cursor, MessageTimeline } from '../core/domain.js';
import { isDeepStrictEqual } from 'node:util';
import type { GenerateOptions } from '@deepseek-ai/dsh-llm';
import type { SharedTool } from '../sharing/sharing.js';

export const CLAUDE_GOAL_SERVER = '.claude-goal';
export const CLAUDE_GOAL_MCP = 'dsh-goal';
export const CLAUDE_GOAL_TOOLS = ['create_goal', 'get_goal', 'update_goal'] as const;
type Message = GenerateOptions['messages'][number];
const sourceOf = (message: Message) => message.source as { kind?: string; goalId?: string; revision?: number; round?: number } | undefined;
export const isGoalContinuation = (message: Message) => message.role === 'user' && sourceOf(message)?.kind === 'goal' && Number(sourceOf(message)?.round) > 0;
export const goalContinuationPrompt = (message: Message, text: string) => `DSH automatic goal continuation (not a new human request). Original source: ${JSON.stringify(message.source)}\n\n${text}`;
const fail = (text: string) => { throw new Error(`Claude goal bridge: ${text}`); };
export interface GoalIdentity { readonly epoch: string; readonly messageId: string }
export interface GoalRequest extends GoalIdentity { readonly callId: string }
export type GoalOriginCheck = (request: GoalRequest, name: string, args: unknown, signal: AbortSignal) => Promise<boolean>;
/** Origin is recorded by CliSession from a root assistant tool_use frame, never inferred from MCP input. */
export async function verifyClaudeGoalOrigin(read: (cursor?: Cursor) => Promise<MessageTimeline>, foreground: (nativeSessionId: string) => Promise<boolean>, origin: GoalRequest, name: string, args: unknown, signal: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + 5000;
  do {
    signal.throwIfAborted();
    let cursor: Cursor | undefined;
    for (let pages = 0; pages < 100; pages++) {
      const page = await read(cursor); signal.throwIfAborted();
      if (!page.found || page.hasFollowingMessage || page.terminalStatus || page.reset) return false;
      const observed = page.entries.find(e => e.item.type === 'claude_goal_origin' && e.item.callId === origin.callId);
      if (observed) return observed.item.sourceProofVersion === 1 && typeof observed.item.uuid === 'string' && typeof observed.item.responseId === 'string' && typeof observed.item.nativeSessionId === 'string'
        && observed.item.epoch === origin.epoch && observed.item.messageId === origin.messageId
        && observed.item.name === name && isDeepStrictEqual(observed.item.arguments, args) && await foreground(observed.item.nativeSessionId);
      if (!page.hasNewer || !page.endCursor) break;
      cursor = page.endCursor;
    }
    // CLI output and MCP requests use different transports; wait briefly for the attestation,
    // but never substitute the current message/epoch when it does not arrive.
    await pause(25, undefined, { signal });
  } while (Date.now() < deadline);
  return false;
}
async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  try { return await Promise.race([work, new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  })]); } finally { signal.removeEventListener('abort', abort); }
}
interface Grant {
  sessionId: string; agent: any; boundary: number; signal: AbortSignal; controller: AbortController;
  identity: GoalIdentity; executor: any; calls: Map<string, { input: unknown; operation: Promise<unknown> }>;
  pending: Set<Promise<unknown>>; closed: boolean; remoteActive?: GoalOriginCheck;
}

/** Optional public 0.2.2 API: mutations use native tools; shutdown uses public disarm only. */
export class ClaudeGoalBridge {
  private grants = new Map<string, Grant>();
  private owners = new Map<string, WeakRef<object>>();
  constructor(private readonly get: (name: string) => any, private readonly taskOwner?: (taskId: string) => string | undefined,
    private readonly optedIn: (sessionId: string) => boolean = () => false) {}
  private runtime() {
    const agents = this.get('agents'), tools = this.get('tools'), goals = this.get('goals');
    // Older DSH releases used a single-call execute API. Never guess which signature to dispatch.
    return agents?.withInitiator && agents?.turnBoundaryOf && tools?.resolve && tools?.selectExecutor && tools?.guard && goals?.get ? { agents, tools, goals } : undefined;
  }
  support(sessionId: string): { schemas: SharedTool[]; executor?: any; reason?: string } {
    if (!this.optedIn(sessionId)) return { schemas: [], reason: 'Claude goal bridge is disabled for this session. Explicitly list its DSH session ID in claudeGoalSessions to opt in to isolated-process mode, which terminates in-process background work between turns.' };
    const runtime = this.runtime(), agent = runtime?.agents.get(sessionId);
    if (!runtime || !agent) return { schemas: [], reason: 'native goal/batch/agent services are unavailable' };
    try {
      const executor = runtime.tools.selectExecutor(agent);
      // Registry definitions are not executor capabilities (PTC accepts only run_code).
      const advertised = executor.describe(runtime.tools.definitions(agent)).schemas ?? [];
      const names = new Set(advertised.map((schema: SharedTool) => schema.name));
      const schemas = runtime.tools.schemas(agent).filter((tool: SharedTool) => (CLAUDE_GOAL_TOOLS as readonly string[]).includes(tool.name));
      if (schemas.length !== CLAUDE_GOAL_TOOLS.length) return { schemas: [], reason: 'the three native goal tools are not visible in this session' };
      if (!CLAUDE_GOAL_TOOLS.every(name => names.has(name))) return { schemas: [], reason: 'selected scoped executor does not support direct goal calls (PTC is not supported)' };
      return { schemas, executor };
    } catch { return { schemas: [], reason: 'selected scoped executor is unavailable or cannot describe direct goal calls' }; }
  }
  available(sessionId: string): boolean { return this.support(sessionId).schemas.length === CLAUDE_GOAL_TOOLS.length; }
  schemas(sessionId: string): SharedTool[] { return this.support(sessionId).schemas; }
  /** Host launch path only. Never offered as a wire operation or a mutable credential pointer. */
  launchIdentity(taskId: string, sessionId: string): GoalIdentity | undefined {
    const grant = this.grants.get(taskId);
    return this.optedIn(sessionId) && grant && !grant.closed && !grant.signal.aborted && grant.sessionId === sessionId ? grant.identity : undefined;
  }
  matches(taskId: string, sessionId: string, identity: Partial<GoalIdentity>): boolean {
    const current = this.launchIdentity(taskId, sessionId);
    return !!current && current.epoch === identity.epoch && current.messageId === identity.messageId;
  }
  /** A trusted native session failure revokes only the matching foreground grant. */
  invalidate(taskId: string, messageId: string, reason: string): void {
    const grant = this.grants.get(taskId);
    if (!grant || grant.identity.messageId !== messageId) return;
    grant.controller.abort(new Error(reason));
    try {
      const agents = this.get('agents'), goals = this.get('goals');
      if ((!this.taskOwner || this.taskOwner(taskId) === grant.sessionId) && agents?.get(grant.sessionId) === grant.agent && typeof goals?.disarm === 'function') goals.disarm(grant.agent);
    } catch { /* The grant is already revoked even if the host is unloading. */ }
  }
  /** Host lifecycle shutdown: revoke capabilities and park active goals via the public API. */
  shutdown(): void {
    const agents = this.get('agents'), goals = this.get('goals');
    for (const grant of this.grants.values()) grant.controller.abort(new Error('Claude goal driver unloaded'));
    // The native driver may be between turns, with no open grant yet. Park those sessions
    // too, but do not park an agent that has since switched to another model provider.
    for (const [sessionId, reference] of this.owners) {
      const agent = reference.deref() as any; if (!agent) continue;
      try {
        const config = agent.session.requestHeader?.()?.config;
        if (config && config.provider !== 'remote-cli-claude' && !(config.provider === 'remote-cli' && config.model?.split('/')[1] === 'claude')) continue;
        if (agents?.get(sessionId) === agent && typeof goals?.disarm === 'function') goals.disarm(agent);
      } catch { /* Never rearm during teardown. */ }
    }
    this.owners.clear();
  }
  /** Authenticate the exact message at the live open-turn boundary; history is not authority. */
  private admission(sessionId: string, message: Message) {
    const runtime = this.runtime();
    if (!runtime) return fail('native goal services are unavailable');
    const agent = runtime.agents.get(sessionId);
    if (!agent || agent.id !== sessionId || agent.session.id !== sessionId || agent.status !== 'running') return fail('no exact running session agent');
    const boundary = runtime.agents.turnBoundaryOf(agent.session).openTurnStartSeq;
    if (boundary === null || boundary === undefined) return fail('no open model turn');
    if (!message.id) return fail('message identity is missing');
    const event = agent.session.snapshotEvents().slice(boundary + 1).find((e: any) => e.type === 'user/message' && e.data.id === message.id);
    if (!event || !isDeepStrictEqual(event.data.source, message.source) || !isDeepStrictEqual(event.data.content, message.content)) return fail('message is not committed in this turn');
    const source = sourceOf(message);
    if (source?.kind === 'goal') {
      const goal = runtime.goals.get(agent);
      if (!isGoalContinuation(message) || !goal || goal.phase !== 'active' || goal.activation !== 'armed' || goal.id !== source.goalId || goal.revision !== source.revision || goal.roundsStarted !== source.round) return fail('goal continuation is stale, paused, complete or disarmed');
    } else if (source?.kind !== 'user') return fail('synthetic input cannot authorize goal controls');
    return { agent, boundary };
  }
  validateContinuation(sessionId: string, message: Message): void {
    const support = this.support(sessionId); if (!support.executor) return fail(support.reason!);
    this.admission(sessionId, message);
  }
  /** A stream owns the grant until it settles; TCP callbacks cannot manufacture a new driver lifetime. */
  begin(taskId: string, sessionId: string, message: Message, signal: AbortSignal, remoteActive?: GoalOriginCheck, remoteMessageId = String(message.id ?? '')): (() => Promise<void>) | undefined {
    const support = this.support(sessionId); if (!support.executor) return;
    // A history replay or team assignment can still run normally, but receives no goal authority.
    let admitted: ReturnType<ClaudeGoalBridge['admission']>;
    try { admitted = this.admission(sessionId, message); } catch (error) { if (isGoalContinuation(message)) throw error; return; }
    if (this.grants.has(taskId)) return fail('task already has an active goal grant');
    const controller = new AbortController();
    const grant: Grant = { ...admitted, sessionId, controller, signal: AbortSignal.any([signal, controller.signal]), pending: new Set(), closed: false, remoteActive, executor: support.executor, calls: new Map(), identity: Object.freeze({ epoch: randomBytes(32).toString('hex'), messageId: remoteMessageId }) };
    this.grants.set(taskId, grant); this.owners.set(sessionId, new WeakRef(admitted.agent));
    return async () => {
      grant.closed = true; controller.abort();
      if (this.grants.get(taskId) === grant) this.grants.delete(taskId);
      await Promise.allSettled([...grant.pending]);
    };
  }
  async call(taskId: string, sessionId: string, name: string, args: unknown, signal: AbortSignal, origin: GoalRequest): Promise<unknown> {
    if (!(CLAUDE_GOAL_TOOLS as readonly string[]).includes(name)) return fail('tool is outside the goal allowlist');
    if (!this.optedIn(sessionId)) return fail('session is not opted in to claudeGoalSessions');
    const grant = this.grants.get(taskId), runtime = this.runtime();
    if (!grant || !runtime || grant.closed || grant.sessionId !== sessionId) return fail('no active grant for this task and session');
    if (!origin || typeof origin.callId !== 'string' || !origin.callId || !this.matches(taskId, sessionId, origin)) return fail('stale or missing process epoch/message identity');
    origin = Object.freeze({ ...origin }); args = structuredClone(args);
    const check = () => {
      grant.signal.throwIfAborted(); signal.throwIfAborted();
      if (!this.optedIn(sessionId)) return fail('session opt-in was revoked');
      if (this.taskOwner && this.taskOwner(taskId) !== sessionId) return fail('task session binding changed');
      if (runtime.tools.selectExecutor(grant.agent) !== grant.executor) return fail('selected scoped executor changed');
      if (grant.closed || this.grants.get(taskId) !== grant || runtime.agents.get(sessionId) !== grant.agent || grant.agent.status !== 'running' || runtime.agents.turnBoundaryOf(grant.agent.session).openTurnStartSeq !== grant.boundary) return fail('driver lifetime changed');
    };
    check();
    const input = structuredClone({ name, args });
    const previous = grant.calls.get(origin.callId);
    if (previous) { if (!isDeepStrictEqual(previous.input, input)) return fail('tool call identity reused with different arguments'); return previous.operation; }
    const operation = Promise.resolve().then(async () => {
      check();
      const callSignal = AbortSignal.any([grant.signal, signal]);
      if (grant.remoteActive && !await abortable(grant.remoteActive(origin, name, args, callSignal), callSignal)) return fail('remote tool origin is not the active foreground message');
      check();
      return runtime.agents.withInitiator(grant.agent, async () => {
        // Native executor retains schema validation, scope restrictions, policies, approvals, guards,
        // goal authority, revision CAS and deferred context. No direct definition.execute or goals mutation.
        const callId = `claude-goal-${randomUUID()}`;
        // Native guards run after asynchronous policy/approval gates. Recheck the grant there
        // too: a delayed approval must not carry an old turn or task binding into a new one.
        const unguard = runtime.tools.guard((exec: { callId: string }) => {
          if (exec.callId !== callId) return;
          try { check(); } catch (error) { return String(error); }
        });
        let batch;
        try {
          batch = await runtime.tools.execute({ agent: grant.agent, signal: AbortSignal.any([grant.signal, signal]),
            calls: [{ type: 'tool-call', id: callId, name, arguments: JSON.stringify(args) }] });
        } finally { await unguard(); }
        const result = batch.results[0]?.result;
        if (!result) return fail('native executor returned no result');
        const content = [...result.content];
        for (const context of batch.additionalContexts) {
          // Claude is already inside its own tool loop: return the native wrapup there, without
          // injecting a second DSH model step (which could repeat the last human message).
          content.push({ type: 'text', text: `DSH tool context; source=${JSON.stringify(context.source)}\n${context.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n')}` });
        }
        return { content, ...(result.isError ? { isError: true } : {}) };
      });
    });
    grant.calls.set(origin.callId, { input, operation });
    grant.pending.add(operation);
    try { return await operation; } finally { grant.pending.delete(operation); }
  }
}
