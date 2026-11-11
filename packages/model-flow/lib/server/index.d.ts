import type { Context } from '@deepseek-ai/cordis';
import { type Chunk } from './activity.js';
import { type Role } from './routes.js';
import { type CardEnd, type CardStep } from './shared.js';
/** The parts of DSH this plugin uses. */
interface ChildSession {
    header: {
        parentSession?: unknown;
    };
    append(type: string, data: Record<string, unknown>): void;
}
interface LiveAgent {
    id: string;
    provider?: string;
    model?: string;
    phase?: {
        kind?: string;
        lastTurn?: number;
    };
    session: ChildSession & {
        deriveMessages?(): unknown[];
    };
}
type PreStep = {
    kind: 'reject';
} | {
    kind: 'enter';
    messages: unknown[];
};
declare module '@deepseek-ai/cordis' {
    interface Events {
        'agent/created'(payload: {
            agent: LiveAgent;
        }): undefined | Promise<undefined>;
        'agent/error'(payload: {
            agent: LiveAgent;
            error: unknown;
        }): void;
        'agent/assistant-stream'(payload: {
            agent: LiveAgent;
            frame: {
                type: string;
                chunk?: Chunk;
            };
        }): void;
        'agent/pre-step'(payload: {
            agent: LiveAgent;
        }, next: () => Promise<PreStep>): Promise<PreStep>;
    }
}
export declare const name = "dsh-model-flow";
export declare const inject: string[];
/** How a flow ended, with its report and the steps it went through, for a plugin that started it. */
export interface ModelFlowResult {
    end: CardEnd;
    report?: string;
    steps: CardStep[];
}
export interface ModelFlowRun {
    done: Promise<ModelFlowResult>;
    stop(): void;
}
/**
 * What other DSH plugins may do, as the service `modelFlow`: run a flow in a conversation, as a typed /flow does, and
 * learn how it ended. `agent` is the conversation's live agent; `models` are /flow's plan=, impl= and review= values.
 * The conversation keeps its title. Starting rejects with the message /flow would show.
 */
export interface ModelFlowService {
    readonly version: 1;
    start(agent: unknown, input: {
        goal: string;
        rounds?: number;
        models?: Partial<Record<Role, string>>;
        attachments?: readonly unknown[];
    }): Promise<ModelFlowRun>;
}
export declare function apply(ctx: Context): Promise<void>;
export {};
