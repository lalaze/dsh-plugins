import type { Context } from '@deepseek-ai/cordis';
import { type Chunk } from './activity.js';
import { type Role } from './routes.js';
import { type CardEnd, type CardStep, type LiveCard } from './shared.js';
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
        header: {
            cwd?: string;
        };
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
/** `progress` is the flow's card as it is now, without the steps' results; `stepBody` is one finished step's result. */
export interface ModelFlowRun {
    done: Promise<ModelFlowResult>;
    stop(): void;
    progress(): LiveCard;
    stepBody(index: number): string | undefined;
}
/**
 * What other DSH plugins may do, as the service `modelFlow`: run a flow in a conversation, as a typed /flow does, and
 * learn how it ended. `agent` is the conversation's live agent; `models` are /flow's plan=, impl= and review= values.
 * The conversation keeps its title. Starting rejects with the message /flow would show. `tag` names the flow for the
 * plugin that started it, as `<plugin>:<its own words>`: the card carries it, and that plugin's page may add to the card.
 */
export interface ModelFlowService {
    readonly version: 2;
    start(agent: unknown, input: {
        goal: string;
        rounds?: number;
        models?: Partial<Record<Role, string>>;
        attachments?: readonly unknown[];
        tag?: string;
    }): Promise<ModelFlowRun>;
}
export declare function apply(ctx: Context): Promise<void>;
export {};
