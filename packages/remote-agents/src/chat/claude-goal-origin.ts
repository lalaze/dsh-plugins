import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { GoalIdentity } from './claude-goal.js';
import { CLAUDE_GOAL_MCP, CLAUDE_GOAL_TOOLS } from './claude-goal.js';

interface Send extends GoalIdentity { uuid: string; nativeSessionId: string }
export interface ClaudeGoalOrigin extends Send { sourceProofVersion: 1; callId: string; responseId: string; name: string; arguments: unknown }
type Fact = { kind: 'send'; send: Send } | { kind: 'close'; uuid: string } | { kind: 'modern' }
  | { kind: 'response'; key: string; owner: Send | null } | { kind: 'reject-response'; key: string }
  | { kind: 'call'; key: string; origin: ClaudeGoalOrigin | null };
const key = (nativeSessionId: string, id: string) => JSON.stringify([nativeSessionId, id]);
// A reconnect can construct a replacement parser before its predecessor's IO drains.
const pendingWrites = new Map<string, Promise<void>>();
const seenCalls = new Map<string, Set<string>>();
const seenResponses = new Map<string, Map<string, Send | null>>();
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const replay = (frame: any) => frame.historical === true || frame.isReplay === true;
export const legacyClaudeVersion = (version: unknown): boolean => {
  const match = typeof version === 'string' && /^(\d+)\.(\d+)\.(\d+)(?:\D|$)/.exec(version);
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major < 2 || major === 2 && (minor < 1 || minor === 1 && patch < 319);
};
const root = (frame: any) => frame.parent_tool_use_id == null && !replay(frame);

/** Host-only append-only provenance ledger, separate from replaceable/truncatable display history.
 * Neither loading a ledger nor sending a prompt establishes a native reply's authority. Only a
 * matching native user_message_uuid establishes the root turn; response/call IDs never rebind.
 * Frames within that ordered root stream inherit its attested turn until result/next host send.
 */
export class ClaudeGoalOrigins {
  private sends = new Map<string, Send>();
  private closed = new Set<string>();
  private responses = new Map<string, Send | null>();
  private calls = new Map<string, ClaudeGoalOrigin | null>();
  private pending?: Send;
  private nativeTurn?: Send;
  private modern = false;
  private legacy = false;
  private ready = false;
  private beforeOpen = new Set<string>();
  private failed = false;
  private writes = Promise.resolve();
  private readonly sharedCalls: Set<string>;
  private readonly sharedResponses: Map<string, Send | null>;
  constructor(private readonly file: string) {
    this.sharedCalls = seenCalls.get(file) ?? new Set(); seenCalls.set(file, this.sharedCalls);
    this.sharedResponses = seenResponses.get(file) ?? new Map(); seenResponses.set(file, this.sharedResponses);
  }
  async open(priorCalls: { nativeSessionId: string; callId: string }[] = []): Promise<void> {
    try {
      await pendingWrites.get(this.file);
      let data = '';
      try { data = await readFile(this.file, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (data && !data.endsWith('\n')) throw new Error('Incomplete Claude origin ledger');
      for (const line of data.split('\n').filter(Boolean)) this.apply(JSON.parse(line));
      // A reconnect never infers a live native turn from a prior grant or display cursor.
      this.nativeTurn = undefined; this.ready = true;
      for (const call of priorCalls) if (!this.sharedCalls.has(key(call.nativeSessionId, call.callId))) this.record({ kind: 'call', key: key(call.nativeSessionId, call.callId), origin: null });
      for (const callKey of this.beforeOpen) if (!this.sharedCalls.has(callKey)) this.record({ kind: 'call', key: callKey, origin: null });
      this.beforeOpen.clear();
      await this.flush();
    } catch { this.failed = true; this.ready = true; }
  }
  private apply(fact: Fact): void {
    switch (fact.kind) {
      case 'send':
        if (!text(fact.send?.uuid) || !text(fact.send.messageId) || !text(fact.send.epoch) || !text(fact.send.nativeSessionId) || this.sends.has(fact.send.uuid)) throw new Error('Invalid or repeated send identity');
        if (this.pending) this.closed.add(this.pending.uuid);
        this.pending = Object.freeze({ ...fact.send }); this.sends.set(fact.send.uuid, this.pending); this.nativeTurn = undefined; return;
      case 'close': if (!text(fact.uuid)) throw new Error('Invalid close'); this.closed.add(fact.uuid); if (this.nativeTurn?.uuid === fact.uuid) this.nativeTurn = undefined; return;
      case 'modern': this.modern = true; return;
      case 'response':
        if (!text(fact.key) || this.responses.has(fact.key) || fact.owner !== null && (!fact.owner || !this.sends.has(fact.owner.uuid))) throw new Error('Invalid response identity');
        this.responses.set(fact.key, fact.owner); if (!this.sharedResponses.has(fact.key)) this.sharedResponses.set(fact.key, fact.owner); return;
      case 'reject-response': if (!text(fact.key)) throw new Error('Invalid response'); this.responses.set(fact.key, null); this.sharedResponses.set(fact.key, null); return;
      case 'call':
        if (!text(fact.key) || this.calls.has(fact.key) || fact.origin !== null && (!fact.origin || fact.origin.sourceProofVersion !== 1 || !this.sends.has(fact.origin.uuid))) throw new Error('Invalid call identity');
        this.calls.set(fact.key, fact.origin); this.sharedCalls.add(fact.key); return;
      default: throw new Error('Unknown Claude origin fact');
    }
  }
  private record(fact: Fact): void {
    // Snapshot before queuing IO. Reserve IDs immediately, publish proof only after flush().
    const line = JSON.stringify(fact), saved = JSON.parse(line) as Fact;
    this.apply(saved);
    if (this.failed) return;
    this.writes = (pendingWrites.get(this.file) ?? this.writes).then(async () => {
      if (this.failed) return;
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      await appendFile(this.file, line + '\n', { mode: 0o600 });
    }).catch(() => { this.failed = true; });
    pendingWrites.set(this.file, this.writes);
  }
  async flush(): Promise<boolean> { await this.writes; return this.ready && !this.failed; }
  async send(identity: Send): Promise<void> { this.record({ kind: 'send', send: identity }); await this.flush(); }
  /** Local Stop/close does not leave a stamp usable by a later send. */
  close(): void { if (this.pending && !this.closed.has(this.pending.uuid)) this.record({ kind: 'close', uuid: this.pending.uuid }); this.nativeTurn = undefined; }
  /** A legacy declaration disables goal proofs, never grants them. Unknown versions remain strict. */
  noteInit(frame: any, nativeSessionId: string): void {
    if (frame.type === 'system' && frame.subtype === 'init' && root(frame) && frame.session_id === nativeSessionId) this.legacy = legacyClaudeVersion(frame.claude_code_version);
  }
  private live(owner: Send | null | undefined, nativeSessionId: string, activeMessage?: string): owner is Send {
    return !!owner && owner.nativeSessionId === nativeSessionId && owner.messageId === activeMessage
      && owner.uuid === this.pending?.uuid && !this.closed.has(owner.uuid);
  }
  observe(frame: any, nativeSessionId: string, activeMessage?: string): ClaudeGoalOrigin[] {
    if (!this.ready) {
      if (frame.type === 'assistant' && Array.isArray(frame.message?.content)) for (const block of frame.message.content) if (block?.type === 'tool_use' && text(block.id)) this.beforeOpen.add(key(nativeSessionId, block.id));
      return [];
    }
    const top = root(frame) && frame.session_id === nativeSessionId;
    const uuid = frame.user_message_uuid;
    if (top && text(uuid) && !this.modern) this.record({ kind: 'modern' });
    if (frame.parent_tool_use_id == null && (!top || text(uuid) && !this.live(this.sends.get(uuid), nativeSessionId, activeMessage))) this.nativeTurn = undefined;
    let owner: Send | null = null;
    const responseId = frame.type === 'assistant' ? frame.message?.id : frame.type === 'stream_event' ? frame.api_message_id ?? frame.event?.message?.id : undefined;
    if (text(responseId)) {
      const responseKey = key(nativeSessionId, responseId), previous = this.sharedResponses.get(responseKey);
      if (this.sharedResponses.has(responseKey)) {
        // A conflicting or historical replay cannot upgrade or reuse a known response.
        if (!top || text(uuid) && previous?.uuid !== uuid) this.record({ kind: 'reject-response', key: responseKey });
        else owner = previous ?? null;
      } else {
        const stamped = text(uuid) ? this.sends.get(uuid) : undefined;
        if (top && text(uuid)) {
          if (this.live(stamped, nativeSessionId, activeMessage)) { owner = stamped; this.nativeTurn = stamped; }
          else this.nativeTurn = undefined;
        } else if (top && this.live(this.nativeTurn, nativeSessionId, activeMessage)) owner = this.nativeTurn;
        this.record({ kind: 'response', key: responseKey, owner });
      }
    }
    const origins: ClaudeGoalOrigin[] = [];
    if (frame.type !== 'assistant' || !Array.isArray(frame.message?.content)) return origins;
    for (const block of frame.message.content) {
      if (block?.type !== 'tool_use' || !text(block.id)) continue;
      const callKey = key(nativeSessionId, block.id);
      if (this.sharedCalls.has(callKey)) continue;
      const prefix = `mcp__${CLAUDE_GOAL_MCP}__`, name = typeof block.name === 'string' && block.name.startsWith(prefix) ? block.name.slice(prefix.length) : '';
      const origin = top && !this.legacy && !this.failed && this.live(owner, nativeSessionId, activeMessage) && text(responseId)
        && (CLAUDE_GOAL_TOOLS as readonly string[]).includes(name)
        ? { ...owner, sourceProofVersion: 1 as const, responseId, callId: block.id, name, arguments: block.input } : null;
      this.record({ kind: 'call', key: callKey, origin });
      if (origin) origins.push(structuredClone(origin));
    }
    return origins;
  }
  /** A stale A result never completes B. Explicitly identified legacy producers may finish ordinary output, but
   * they never produce goal-call proofs. Unknown unstamped results are not attributed. */
  resultMatches(frame: any, nativeSessionId: string, activeMessage?: string): boolean {
    if (!this.ready || !root(frame) || frame.session_id !== undefined && frame.session_id !== nativeSessionId) return false;
    if (text(frame.user_message_uuid)) {
      if (!this.modern) this.record({ kind: 'modern' });
      const owner = this.sends.get(frame.user_message_uuid);
      if (!this.live(owner, nativeSessionId, activeMessage)) return false;
      this.record({ kind: 'close', uuid: owner.uuid }); return true;
    }
    if (!this.legacy) return false;
    this.close(); return true;
  }
}
