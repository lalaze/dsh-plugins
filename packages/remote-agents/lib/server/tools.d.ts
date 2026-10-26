import { type Permission, type PermissionAnswer } from './domain.js';
import type { RemoteAgentsService } from './service.js';
/** The narrow DSH host surface used by the delegation tools. */
export interface ToolHost {
    approval: {
        request(input: {
            agent: unknown;
            toolName: string;
            callId?: string;
            reason?: string;
            signal?: AbortSignal;
        }): Promise<string>;
    };
    userQuestions: {
        ask(input: {
            agent: unknown;
            signal: AbortSignal;
            questions: {
                id: string;
                header?: string;
                question: string;
                options: {
                    label: string;
                    description?: string;
                }[];
                multiSelect: boolean;
            }[];
        }): Promise<{
            answers?: {
                id: string;
                selected?: string[];
                custom?: string;
            }[];
        }>;
    };
}
export interface ToolCall {
    callId: string;
    agent?: unknown;
    signal: AbortSignal;
}
type Schema = Record<string, unknown>;
/** Structurally a `@deepseek-ai/dsh-tools` ToolDefinition; raw schemas stay within its enforced subset. */
export interface ToolDefinition {
    name: string;
    description: string;
    parameters: Schema;
    output: {
        schema: Schema;
        render(args: unknown, value: unknown): {
            type: 'text';
            text: string;
        }[];
    };
    execute(args: unknown, exec: ToolCall): Promise<unknown>;
    isConcurrencySafe?(args: unknown): boolean;
}
export interface AgentReport {
    id: string;
    title: string;
    host: string;
    cwd: string;
    provider: string;
    model: string;
    mode?: string;
    status: string;
    error?: string;
    waitingFor?: string[];
    reply?: string;
}
export interface WaitResult {
    agents: AgentReport[];
    timedOut: boolean;
}
export declare function decidePermission(host: ToolHost, permission: Permission, exec: ToolCall, signal: AbortSignal, subject: string): Promise<PermissionAnswer | undefined>;
/**
 * Paseo-style delegation for the DSH agent: start remote CLI agents, message them and collect their
 * replies. Permission requests are forwarded to the user as native DSH prompts while a call waits;
 * unanswered requests remain pending and can be shown again by another wait.
 */
export declare function delegationTools(host: ToolHost, service: RemoteAgentsService): ToolDefinition[];
export {};
