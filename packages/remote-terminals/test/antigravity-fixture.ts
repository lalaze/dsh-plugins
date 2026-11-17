/** Rows as Antigravity writes them to a conversation's database, built from the fields tui-usage-antigravity.ts reads. */

const varint = (value: number) => {
  const out: number[] = [];
  do { let byte = value % 128; value = Math.floor(value / 128); if (value) byte |= 0x80; out.push(byte); } while (value);
  return out;
};
/** A protocol buffer field: a number as a varint, text or bytes as length-delimited. */
export const field = (number: number, value: number | string | Uint8Array): number[] => {
  if (typeof value === 'number') return [...varint(number * 8), ...varint(value)];
  const bytes = typeof value === 'string' ? Buffer.from(value) : value;
  return [...varint(number * 8 + 2), ...varint(bytes.length), ...bytes];
};
export const message = (...fields: number[][]) => Uint8Array.from(fields.flat());
const time = (at: string) => { const ms = Date.parse(at); return message(field(1, Math.floor(ms / 1000)), field(2, (ms % 1000) * 1e6)); };
const duration = (ms: number) => message(field(1, Math.floor(ms / 1000)), field(2, (ms % 1000) * 1e6));
/** Fields Antigravity writes that are not read: an unsigned 64-bit maximum, fixed-size numbers, a nested copy. */
const noise = () => [
  [...varint(9 * 8 + 2), 11, 0x10, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01],
  [...varint(13 * 8 + 1), 1, 2, 3, 4, 5, 6, 7, 8], [...varint(14 * 8 + 5), 1, 2, 3, 4],
  [...varint(30 * 8), 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01],
  field(21, 'Gemini 4 Carbon (Medium)'),
];

export interface CallFixture { step: number; model?: string; input: number; output: number; cached?: number; thinking?: number; waitMs?: number; writeMs?: number }
/** A `gen_metadata` row's `data`. */
export function callRow(call: CallFixture): Uint8Array {
  const usage = message(field(1, 1437), field(2, call.input), field(3, call.output), ...(call.cached ? [field(5, call.cached)] : []), field(6, 24), ...(call.thinking ? [field(9, call.thinking)] : []), field(10, 145));
  const pair = (key: string, value: string) => field(20, message(field(1, key), field(2, value)));
  return message(
    field(2, Uint8Array.from([1, 2, 3])),
    field(1, message(field(3, 1437), field(4, usage), ...noise(), field(11, duration(call.waitMs ?? 0)), field(12, duration(call.writeMs ?? 0)),
      ...(call.model ? [field(19, call.model)] : []), pair('cascade_id', 'c'), pair('last_step_index', String(call.step)), pair('used_claude', 'false'))),
    field(4, '39575dc6-8969-4f12-8ef7-27ba31fc308e'),
  );
}
/** A `steps` row's `metadata`: when it began, then what follows it. */
export const stepRow = (at: string) => message(field(1, time(at)), field(3, 2), field(12, 'x'.repeat(200)), field(26, message(field(1, 3), field(2, time(at)))));
export const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex').toUpperCase();
/** Lines as `TuiRemote.tuiUsageLines` sends them. */
export const callLine = (index: number, call: CallFixture) => JSON.stringify({ g: index, d: hex(callRow(call)) });
export const stepLine = (index: number, type: number, at: string) => JSON.stringify({ s: index, t: type, m: hex(stepRow(at).subarray(0, 32)) });
export const stateLine = (running: boolean) => JSON.stringify({ status: running ? 'CASCADE_RUN_STATUS_RUNNING' : 'CASCADE_RUN_STATUS_IDLE', busy: running ? 1 : 0 });
export const PROMPT = 14, RESPONSE = 15, TOOL = 132;
