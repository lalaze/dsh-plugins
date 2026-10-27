import type { AccountUsage, ContextUsage, HostConfig, NativeProtocol, Task, TokenUsage, TurnUsage } from './domain.js';
import type { JsonlPeer } from './ssh.js';
/** Context fill, or nothing until the CLI has reported a window size. */
export declare function contextUsage(used: unknown, max: unknown): ContextUsage | undefined;
/** Codex `thread/tokenUsage/updated`: the last request's total is what the context window holds. */
export declare const codexContext: (usage: any) => ContextUsage | undefined;
/** One finished remote turn's usage, in dsh-usage-stats' record shape, with the machine and remote directory it ran in. */
export interface RemoteUsageRecord {
    id: string;
    startedAt: string;
    provider: string;
    model: string;
    sessionId?: string;
    purpose: 'conversation' | 'delegation' | 'remote-session';
    status: 'completed' | 'error';
    durationMs: number;
    usage: TurnUsage;
    host?: string;
    workspace?: string;
}
/** Providers match the `remote-cli-<cli>` chat routes; sessions are the DSH conversation, or the agent for other turns. */
export declare function remoteUsageRecord(task: Task, hosts: readonly HostConfig[], usage: TurnUsage, turn: {
    startedAt: string | null;
    failed: boolean;
}, now?: number): RemoteUsageRecord;
/** Claude's `result.usage`: the whole turn, across every model call it made. */
export declare function claudeTurnUsage(usage: any): TurnUsage | undefined;
/** Codex reports running thread totals; a turn used the difference since the previous turn ended. */
export declare function codexTurnUsage(total: any, before: any): TurnUsage | undefined;
/** ACP's optional `PromptResponse.usage` for one prompt turn. */
export declare function acpTurnUsage(usage: any): TurnUsage | undefined;
/** Claude API usage of one assistant message: everything sent plus what it generated. */
export declare function claudeMessageTokens(usage: any): number | undefined;
/** Codex input already includes cached input; snapshots must not be added together. */
export declare function codexTokenUsage(usage: any): TokenUsage | undefined;
/** Claude's uncached input, cache reads and cache writes are disjoint counters. */
export declare function claudeTokenUsage(usage: any): TokenUsage | undefined;
/** Codex `account/read` and `account/rateLimits/read`. Extra metered buckets follow the main one. */
export declare function codexAccountUsage(account: any, limits: any, checkedAt?: string): AccountUsage;
/** Claude `initialize` account details and the `get_usage` control response behind `/usage`. */
export declare function claudeAccountUsage(account: any, usage: any, checkedAt?: string): AccountUsage;
/** Read plan limits through the CLI itself, so credentials never leave the SSH host. */
export declare function readAccountUsage(peer: JsonlPeer, protocol: NativeProtocol, claudeAccount?: unknown): Promise<AccountUsage>;
