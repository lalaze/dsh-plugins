import type { Cursor, MessageTimeline } from '../core/domain.js';
import type { GenerateOptions } from '@deepseek-ai/dsh-llm';
import type { SharedTool } from '../sharing/sharing.js';
export declare const CLAUDE_GOAL_SERVER = ".claude-goal";
export declare const CLAUDE_GOAL_MCP = "dsh-goal";
export declare const CLAUDE_GOAL_TOOLS: readonly ["create_goal", "get_goal", "update_goal"];
type Message = GenerateOptions['messages'][number];
export declare const isGoalContinuation: (message: Message) => boolean;
export declare const goalContinuationPrompt: (message: Message, text: string) => string;
export interface GoalIdentity {
    readonly epoch: string;
    readonly messageId: string;
}
export interface GoalRequest extends GoalIdentity {
    readonly callId: string;
}
export type GoalOriginCheck = (request: GoalRequest, name: string, args: unknown, signal: AbortSignal) => Promise<boolean>;
/** Origin is recorded by CliSession from a root assistant tool_use frame, never inferred from MCP input. */
export declare function verifyClaudeGoalOrigin(read: (cursor?: Cursor) => Promise<MessageTimeline>, foreground: (nativeSessionId: string) => Promise<boolean>, origin: GoalRequest, name: string, args: unknown, signal: AbortSignal): Promise<boolean>;
/** Optional public 0.2.2 API: mutations use native tools; shutdown uses public disarm only. */
export declare class ClaudeGoalBridge {
    private readonly get;
    private readonly taskOwner?;
    private readonly optedIn;
    private grants;
    private owners;
    constructor(get: (name: string) => any, taskOwner?: ((taskId: string) => string | undefined) | undefined, optedIn?: (sessionId: string) => boolean);
    private runtime;
    support(sessionId: string): {
        schemas: SharedTool[];
        executor?: any;
        reason?: string;
    };
    available(sessionId: string): boolean;
    schemas(sessionId: string): SharedTool[];
    /** Host launch path only. Never offered as a wire operation or a mutable credential pointer. */
    launchIdentity(taskId: string, sessionId: string): GoalIdentity | undefined;
    matches(taskId: string, sessionId: string, identity: Partial<GoalIdentity>): boolean;
    /** A trusted native session failure revokes only the matching foreground grant. */
    invalidate(taskId: string, messageId: string, reason: string): void;
    /** Host lifecycle shutdown: revoke capabilities and park active goals via the public API. */
    shutdown(): void;
    /** Authenticate the exact message at the live open-turn boundary; history is not authority. */
    private admission;
    validateContinuation(sessionId: string, message: Message): void;
    /** A stream owns the grant until it settles; TCP callbacks cannot manufacture a new driver lifetime. */
    begin(taskId: string, sessionId: string, message: Message, signal: AbortSignal, remoteActive?: GoalOriginCheck, remoteMessageId?: string): (() => Promise<void>) | undefined;
    call(taskId: string, sessionId: string, name: string, args: unknown, signal: AbortSignal, origin: GoalRequest): Promise<unknown>;
}
export {};
