import { existsSync, readFileSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { nativeDigest, type NativeEvent } from './native-protocol.js';
import { NativeWorkNotAccepted, type NativeWorkRequest } from './native-autonomy.js';

export type AdmissionKind = 'queue' | 'goal';
interface Admission {
  kind: AdmissionKind; sessionId: string; cut: number; prefix: string;
  state: 'pending' | 'accepted' | 'rejected';
  proofSeq?: number; proofDigest?: string; noop?: boolean;
}
/** Local admission metadata only. Native history stays append-only and exact.
 * The cut excludes imported/source inbox records with the same message ID. */
export class NativeAdmissionReceipts {
  private rows: Record<string, Admission>;
  constructor(readonly path: string) {
    const data = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { schema: 1, rows: {} };
    if (data.schema !== 1 || !data.rows || typeof data.rows !== 'object') throw new Error('Unsupported native admission receipts; preserve for recovery');
    this.rows = data.rows;
  }
  key(kind: AdmissionKind, sessionId: string, payload: unknown): string { return nativeDigest({ kind, sessionId, payload }); }
  get(key: string): Admission | undefined { return this.rows[key]; }
  begin(kind: AdmissionKind, sessionId: string, payload: unknown, events: readonly NativeEvent[]): string {
    const key = this.key(kind, sessionId, payload);
    if (!this.rows[key] && Object.keys(this.rows).length >= 2000) throw new NativeWorkNotAccepted('native_receipt_capacity', 'Native admission receipt capacity reached; no work was submitted');
    const previous = this.rows[key];
    this.rows[key] = { kind, sessionId, cut: events.length, prefix: nativeDigest(events), state: 'pending' };
    try { this.save(); }
    catch (error) {
      if (previous) this.rows[key] = previous; else delete this.rows[key];
      throw new NativeWorkNotAccepted('native_receipt_write', `No native work was submitted: ${String(error)}`);
    }
    return key;
  }
  proof(key: string, event: NativeEvent, noop = false): void {
    Object.assign(this.rows[key], { proofSeq: event.seq, proofDigest: nativeDigest(event), ...(noop ? { noop: true } : {}) }); this.save();
  }
  accepted(key: string): void { this.rows[key].state = 'accepted'; this.save(); }
  rejected(key: string): void { this.rows[key].state = 'rejected'; this.save(); }
  evidence(request: NativeWorkRequest, events: readonly NativeEvent[]): 'accepted' | 'absent' | 'unknown' | 'conflict' {
    if (request.kind !== 'queue' && request.kind !== 'goal') return 'unknown';
    const key = this.key(request.kind, request.sessionId, request.payload);
    if (key !== request.requestDigest) return 'conflict';
    const row = this.rows[key];
    if (!row) return 'unknown';
    if (row.kind !== request.kind || row.sessionId !== request.sessionId || events.length < row.cut || nativeDigest(events.slice(0, row.cut)) !== row.prefix) return 'conflict';
    if (row.state === 'rejected') return 'absent';
    // A process can stop after the native synchronous append but before proof()
    // saves. The durable pre-call boundary plus an exact, unique native identity
    // still proves acceptance. No match does NOT prove non-acceptance.
    let event: NativeEvent | undefined;
    if (row.proofSeq === undefined) {
      const candidates = events.slice(row.cut).filter(e => request.kind === 'queue'
        ? queueAdmissionEvent([e], 0, request.payload.target, request.payload.message) !== undefined
        : goalAdmissionEvent(e, request.payload));
      if (!candidates.length) return 'unknown';
      if (candidates.length !== 1) return 'conflict';
      event = candidates[0];
    } else {
      event = events.find(e => e.seq === row.proofSeq);
      if (!event || nativeDigest(event) !== row.proofDigest) return 'conflict';
    }
    if (!row.noop && event.seq < row.cut) return 'conflict';
    if (request.kind === 'queue') {
      const { message, target } = request.payload;
      if (event.type !== 'agent/inbox/spliced' || !(event.data.target === target || target === 'next-step' && event.data.target === 'next-turn')) return 'conflict';
      const matches = event.data.inserted.filter((m: any) => m.id === message.id);
      return matches.length === 1 && nativeDigest(matches[0]) === nativeDigest(message) ? 'accepted' : 'conflict';
    }
    return goalAdmissionEvent(event, request.payload, !!row.noop) ? 'accepted' : 'conflict';
  }
  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${randomUUID()}.tmp`, fd = openSync(temp, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify({ schema: 1, rows: this.rows })); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, this.path);
    const directory = openSync(dirname(this.path), 'r'); try { fsyncSync(directory); } finally { closeSync(directory); }
  }
}

export function queueAdmissionEvent(events: readonly NativeEvent[], cut: number, target: string, message: any): NativeEvent | undefined {
  return events.slice(cut).find(event => event.type === 'agent/inbox/spliced'
    && (event.data.target === target || target === 'next-step' && event.data.target === 'next-turn')
    && event.data.inserted.some((m: any) => m.id === message.id && nativeDigest(m) === nativeDigest(message)));
}

export function goalAdmissionEvent(event: NativeEvent, packet: any, noop = false): boolean {
  const goal = packet?.state, d = event.data;
  return event.type === 'goal/change' && d?.kind === 'goal/change' && d.version === 1
    && (noop ? d.goal?.phase === 'complete' : d.operation === 'resume' && d.goal?.phase === 'active')
    && d.goal.id === goal?.id && d.goal.revision === goal.revision + (noop ? 0 : 1)
    && d.goal.objective === goal.objective && d.goal.maxGoalRounds === goal.maxGoalRounds;
}
