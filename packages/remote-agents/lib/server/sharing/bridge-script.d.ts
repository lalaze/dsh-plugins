/**
 * Runs on the SSH host beside the relay and shares DSH's MCP servers and skills with remote CLIs.
 *
 * - `proxy <task file> <server>`: a stdio MCP server for one DSH MCP server. Each list and call goes to DSH over
 *   the reverse-forwarded socket named in `bridge/current`, authenticated with the task's token. While DSH is
 *   away it lists the last tools it saw and fails calls with a reason the model can relay.
 * - `skills <shared dir>`: a stdio MCP server that loads the skills synced from DSH. It needs no DSH connection.
 * - `manifest <shared dir>` / `sync <shared dir>`: report and replace the synced skills; `sync` reads its JSON
 *   payload from stdin. The shared directory is also a Claude Code plugin, so Claude loads the skills natively.
 *
 * Each DSH instance has its own socket pointer, tool cache and shared directory: one remote account may be
 * used from several computers.
 *
 * The source is embedded in a template literal: it must not contain backticks or dollar-brace sequences.
 */
export declare const BRIDGE_SCRIPT: string;
export declare const BRIDGE_VERSION: string;
