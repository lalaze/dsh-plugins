import type { Context } from '@deepseek-ai/cordis';
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
declare module '@deepseek-ai/cordis' {
    interface Events {
        'agent/created'(payload: {
            agent: LiveAgent;
        }): undefined | Promise<undefined>;
        'agent/error'(payload: {
            agent: LiveAgent;
            error: unknown;
        }): void;
    }
}
export declare const name = "dsh-model-flow";
export declare const inject: string[];
export declare function apply(ctx: Context): Promise<void>;
export {};
