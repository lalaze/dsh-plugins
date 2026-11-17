import type { TurnUsage } from './core/domain.js';
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
export declare const ANTIGRAVITY_CALLS_PER_READ = 2000;
/** How many steps one read fetches at most; there are a few per call, and a few bytes of each. */
export declare const ANTIGRAVITY_STEPS_PER_READ = 20000;
/** One model call: the step it came after, its model, what it used and how long it took. */
export interface AntigravityCall {
    index: number;
    step?: number;
    model?: string;
    usage?: TurnUsage;
    durationMs: number;
}
/** A `gen_metadata` row, or nothing for one that cannot be read. */
export declare function antigravityCall(index: number, data: Uint8Array): AntigravityCall | undefined;
/** When a step began, from the first bytes of its `metadata`. */
export declare function antigravityStepTime(head: Uint8Array): number | undefined;
/**
 * Antigravity's finished turns in what was read, and where reading got to: `read.calls` and `read.steps` are the
 * first call and step not yet read. Steps are taken only as far as the calls read reach, as a prompt is placed among
 * the calls by them; the rest are read again with the calls after them.
 * @param fallbackModel - for a call that names no model.
 */
export declare function readAntigravityUsage(previous: TuiUsageCursor | undefined, chunks: readonly TuiUsageChunk[], fallbackModel: string, now?: number): {
    cursor: TuiUsageCursor;
    turns: TuiTurn[];
};
