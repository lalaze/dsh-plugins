import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';
import type { DshPermission } from './domain.js';
/** DSH's logger, when the host provides one. */
export declare const loggerOf: (ctx: Context) => {
    info?(text: string): void;
    warn?(text: string): void;
} | undefined;
/** A conversation's preset (composer or /permission), mapped through its sandbox so renamed presets still match; `custom` has no mapping. */
export declare function permissionOf(ctx: Context, session: Session | undefined): DshPermission | undefined;
/**
 * How a remote CLI may act for a conversation. A subagent DSH delegated with the `never` approval policy is
 * unattended: nobody answers its prompts, and its knobs (workspace sandbox, never ask) match no preset, so its
 * sandbox sets the CLI's limits. Other conversations keep {@link permissionOf}, where `custom` keeps the CLI's mode.
 * `never`: DSH refuses this conversation's approval requests without showing them.
 */
export declare function accessOf(ctx: Context, session: Session | undefined): {
    permission?: DshPermission;
    unattended: boolean;
    never: boolean;
};
/**
 * Full access: the conversation lets its agent act without asking, and DSH would refuse unseen whatever a CLI still asks.
 * A preset with a full-access sandbox that does ask keeps its prompts.
 */
export declare const fullAccess: (access: {
    permission?: DshPermission;
    never: boolean;
}) => boolean;
type Schema = Record<string, unknown>;
/** The narrow DSH host surface the plugin's tools use: approvals and questions in the calling conversation. */
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
export {};
