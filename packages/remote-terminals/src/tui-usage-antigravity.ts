import type { TurnUsage } from '@dsh-plugins/remote-core/domain.js';
import type { TuiTurn, TuiUsageChunk, TuiUsageCursor } from './tui-usage.js';

/**
 * Antigravity's usage in a TUI conversation. Antigravity logs no usage; it keeps each conversation in a SQLite database
 * of its own, `~/.gemini/antigravity-cli/conversations/<id>.db`, and that is read instead (see `TuiRemote.tuiUsageLines`).
 * Its rows are protocol buffers whose schema Antigravity does not publish; what is read here was matched, token for
 * token, against the usage its ACP server reports for the same turns (agy 1.5.10):
 *
 * - `gen_metadata`, one row per model call, in order: field 1 holds the call, in which 4 is its usage (2 input not read
 *   from the cache, 3 output with the thinking in it, 5 read from the cache, 9 thinking), 11 and 12 how long it waited
 *   and how long it wrote (`Duration`s), 19 the model's ID, and 20 string pairs, among them `last_step_index`, the
 *   step the call came after.
 * - `steps`, the conversation's steps in order, `step_type` 14 being a prompt; their `metadata` starts with field 1,
 *   when the step began (a `Timestamp`), so only its first bytes are fetched.
 * - `conversation_summaries.status` in the summary database is `CASCADE_RUN_STATUS_RUNNING` while a turn runs, and
 *   `not_fully_idle` is set until it has wholly ended.
 *
 * A turn is a prompt and the calls after it until the next prompt. It counts when Antigravity says it is idle, when the
 * next prompt comes, or after its database has been quiet a while, as when the CLI was killed during the turn.
 */

/** How many model calls one read fetches at most (each is about 1.3 KB, twice that as hex). */
export const ANTIGRAVITY_CALLS_PER_READ = 2_000;
/** How many steps one read fetches at most; there are a few per call, and a few bytes of each. */
export const ANTIGRAVITY_STEPS_PER_READ = 20_000;
/** Antigravity's step for a prompt. */
const PROMPT_STEP = 14;
/** A turn that never ends, as when the CLI was killed, counts once nothing has happened for this long. */
const QUIET_MS = 30 * 60_000;

type Value = number | Uint8Array;
/** The fields of a protocol buffer message, by number; numbers that do not fit a double are approximate. */
function message(bytes: Uint8Array, partial = false): Map<number, Value[]> {
  const fields = new Map<number, Value[]>();
  let at = 0;
  const varint = () => {
    let value = 0, scale = 1;
    for (let i = 0; i < 10; i++) {
      if (at >= bytes.length) throw new RangeError('Truncated varint');
      const byte = bytes[at++];
      value += (byte & 0x7f) * scale; scale *= 128;
      if (!(byte & 0x80)) return value;
    }
    throw new RangeError('Varint too long');
  };
  while (at < bytes.length) {
    const start = at;
    try {
      const key = varint(), field = Math.floor(key / 8), wire = key % 8;
      let value: Value;
      if (wire === 0) value = varint();
      else if (wire === 2) {
        const length = varint();
        if (at + length > bytes.length) throw new RangeError('Truncated field');
        value = bytes.subarray(at, at + length); at += length;
      } else if (wire === 1 || wire === 5) { at += wire === 1 ? 8 : 4; if (at > bytes.length) throw new RangeError('Truncated field'); continue; }
      else throw new RangeError(`Unknown wire type ${wire}`);
      if (!field) throw new RangeError('Field 0');
      fields.set(field, [...fields.get(field) ?? [], value]);
    } catch (error) {
      // A prefix of a message ends wherever it was cut.
      if (partial && start > 0) break;
      throw error;
    }
  }
  return fields;
}
const bytesOf = (fields: Map<number, Value[]>, field: number) => fields.get(field)?.find((value): value is Uint8Array => value instanceof Uint8Array);
const numberOf = (fields: Map<number, Value[]> | undefined, field: number) => { const value = fields?.get(field)?.find((v): v is number => typeof v === 'number'); return value !== undefined && Number.isSafeInteger(value) ? value : undefined; };
const text = (bytes: Uint8Array | undefined) => bytes ? new TextDecoder().decode(bytes) : undefined;
/** Milliseconds of a `Timestamp` or `Duration`. */
function millis(bytes: Uint8Array | undefined): number | undefined {
  if (!bytes) return undefined;
  const fields = message(bytes), seconds = numberOf(fields, 1) ?? 0, nanos = numberOf(fields, 2) ?? 0;
  return seconds * 1000 + Math.floor(nanos / 1e6);
}
const hex = (value: unknown) => typeof value === 'string' && /^(?:[0-9A-Fa-f]{2})*$/.test(value) ? Uint8Array.from(Buffer.from(value, 'hex')) : undefined;

/** One model call: the step it came after, its model, what it used and how long it took. */
export interface AntigravityCall { index: number; step?: number; model?: string; usage?: TurnUsage; durationMs: number }
/** A `gen_metadata` row, or nothing for one that cannot be read. */
export function antigravityCall(index: number, data: Uint8Array): AntigravityCall | undefined {
  try {
    const call = bytesOf(message(data), 1);
    if (!call) return undefined;
    const fields = message(call), usage = bytesOf(fields, 4) ? message(bytesOf(fields, 4)!) : undefined;
    let step: number | undefined;
    for (const pair of fields.get(20) ?? []) {
      if (!(pair instanceof Uint8Array)) continue;
      const entry = message(pair);
      if (text(bytesOf(entry, 1)) !== 'last_step_index') continue;
      const value = Number(text(bytesOf(entry, 2)));
      if (Number.isSafeInteger(value) && value >= 0) step = value;
    }
    const input = numberOf(usage, 2) ?? 0, output = numberOf(usage, 3) ?? 0, cached = numberOf(usage, 5) ?? 0, thinking = numberOf(usage, 9) ?? 0;
    const counted: TurnUsage | undefined = usage && input + output + cached > 0
      ? { inputTokens: input, outputTokens: output, ...(cached ? { cacheReadTokens: cached } : {}), ...(thinking ? { reasoningTokens: thinking } : {}), totalTokens: input + output + cached }
      : undefined;
    const model = text(bytesOf(fields, 19))?.trim();
    return { index, ...(step !== undefined ? { step } : {}), ...(model ? { model } : {}), ...(counted ? { usage: counted } : {}), durationMs: (millis(bytesOf(fields, 11)) ?? 0) + (millis(bytesOf(fields, 12)) ?? 0) };
  } catch { return undefined; }
}
/** When a step began, from the first bytes of its `metadata`. */
export function antigravityStepTime(head: Uint8Array): number | undefined {
  try { return millis(bytesOf(message(head, true), 1)); } catch { return undefined; }
}

const USAGE_KEYS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens'] as const;
function add(into: TurnUsage | undefined, usage: TurnUsage): TurnUsage {
  const sum: TurnUsage = { inputTokens: 0, outputTokens: 0, ...into };
  for (const key of USAGE_KEYS) if (usage[key]) sum[key] = (sum[key] ?? 0) + usage[key]!;
  return sum;
}
function finish(open: NonNullable<TuiUsageCursor['open']>): TuiTurn | undefined {
  const models = Object.entries(open.models).filter(([, usage]) => USAGE_KEYS.some(key => (usage[key] ?? 0) > 0)).map(([model, usage]) => ({ model, usage }));
  return models.length ? { startedAt: open.startedAt, durationMs: Math.max(0, Date.parse(open.seen) - Date.parse(open.startedAt)), models } : undefined;
}
const iso = (at: number) => new Date(at).toISOString();
const json = (line: string) => { try { return JSON.parse(line); } catch { return undefined; } };

/**
 * Antigravity's finished turns in what was read, and where reading got to: `read.calls` and `read.steps` are the
 * first call and step not yet read. Steps are taken only as far as the calls read reach, as a prompt is placed among
 * the calls by them; the rest are read again with the calls after them.
 * @param fallbackModel - for a call that names no model.
 */
export function readAntigravityUsage(previous: TuiUsageCursor | undefined, chunks: readonly TuiUsageChunk[], fallbackModel: string, now = Date.now()): { cursor: TuiUsageCursor; turns: TuiTurn[] } {
  const cursor: TuiUsageCursor = structuredClone(previous ?? { read: {} }), turns: TuiTurn[] = [];
  const part = (file: string) => chunks.find(chunk => chunk.file === file);
  const callsPart = part('calls'), stepsPart = part('steps'), statePart = part('state');
  const calls: AntigravityCall[] = [];
  let callsEnd = cursor.read.calls ?? 0;
  for (const line of callsPart?.lines ?? []) {
    const row = json(line), index = row?.g;
    if (!Number.isSafeInteger(index) || index < callsEnd) continue;
    const data = hex(row.d), call = data && antigravityCall(index, data);
    // A row that cannot be read is passed over, not read again.
    if (call) calls.push(call);
    callsEnd = index + 1;
  }
  if (callsPart) callsEnd = Math.max(callsEnd, callsPart.end);
  // Steps as far as the calls read reach: the last step one came after, and the step that call began. Later steps
  // wait for their calls: a call still running has begun its step but is written only once done, and a prompt placed
  // without the calls after it could fall before the last calls of the turn before.
  const reach = Math.max(-1, ...calls.map(call => call.step ?? -1)) + 1;
  const steps = new Map<number, { type: number; at?: number }>();
  let stepsEnd = cursor.read.steps ?? 0;
  for (const line of stepsPart?.lines ?? []) {
    const row = json(line), index = row?.s;
    if (!Number.isSafeInteger(index) || index < stepsEnd || index > reach) continue;
    const head = hex(row.m), at = head && antigravityStepTime(head);
    steps.set(index, { type: Number(row.t), ...(at !== undefined ? { at } : {}) });
  }
  const prompts = [...steps].filter(([, step]) => step.type === PROMPT_STEP).map(([index, step]) => ({ index, at: step.at }));
  if (steps.size) stepsEnd = Math.max(stepsEnd, ...steps.keys()) + 1;

  // In the order they happened: a call after the step it came after, so after the prompt that began its turn.
  let place = -1;
  const events = [
    ...calls.map(call => ({ place: (place = call.step ?? place) + 0.5, call })),
    ...prompts.map(prompt => ({ place: prompt.index, prompt })),
  ].sort((a, b) => a.place - b.place);
  for (const event of events) {
    if ('prompt' in event && event.prompt) {
      if (cursor.open) { const turn = finish(cursor.open); if (turn) turns.push(turn); }
      const at = iso(event.prompt.at ?? (cursor.open ? Date.parse(cursor.open.seen) : now));
      cursor.open = { startedAt: at, seen: at, models: {} };
    } else if ('call' in event && event.call) {
      const { call } = event, usage = call.usage;
      if (!usage) continue;
      // A call begins its response step, the one after the step it came after.
      const began = call.step !== undefined ? steps.get(call.step + 1)?.at ?? steps.get(call.step)?.at : undefined;
      const start = began ?? (cursor.open ? Date.parse(cursor.open.seen) : now), end = iso(start + call.durationMs);
      cursor.open ??= { startedAt: iso(start), seen: iso(start), models: {} };
      const model = call.model ?? fallbackModel;
      cursor.open.models[model] = add(cursor.open.models[model], usage);
      if (end > cursor.open.seen) cursor.open.seen = end;
    }
  }
  cursor.read = { ...cursor.read, calls: callsEnd, steps: stepsEnd };

  // The state was read before the calls, so a turn it says has ended had all its calls written by then.
  const state = statePart?.lines.map(json).find(row => row && typeof row.status === 'string');
  const idle = !!state && state.status !== 'CASCADE_RUN_STATUS_RUNNING' && !state.busy;
  const quiet = !calls.length && !!cursor.open && now - Date.parse(cursor.open.seen) >= QUIET_MS;
  if (cursor.open && !callsPart?.capped && (idle || quiet)) {
    const turn = finish(cursor.open);
    if (turn) turns.push(turn);
    delete cursor.open;
  }
  return { cursor, turns };
}
