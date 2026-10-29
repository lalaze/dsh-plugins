/**
 * Runs on the SSH host and keeps the session registry every DSH connected to this SSH account shares.
 *
 * `serve <base> <instance>` answers JSON-RPC requests on stdin and reports changed sessions as
 * `changed` notifications. Each session directory holds `manifest.json` (the portable task record),
 * `events.jsonl` (its history, one timeline entry per line, appended in sequence), `head.json` (the
 * history length), `lease.json` (the DSH instance driving the CLI) and `live.json` (that instance's
 * live status). Only the lease holder may append history, so two instances can never interleave a
 * session's history. A deleted session leaves `deleted.json` so other instances forget it too.
 */
export declare const SHARED_SCRIPT: string;
export declare const SHARED_VERSION: string;
