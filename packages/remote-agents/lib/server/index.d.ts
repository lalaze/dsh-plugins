import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import type { TurnUsage } from './domain.js';
/** One finished remote turn's usage, in dsh-usage-stats' record shape. */
export interface RemoteUsageRecord {
    id: string;
    startedAt: string;
    provider: string;
    model: string;
    sessionId?: string;
    purpose: 'delegation' | 'remote-session';
    status: 'completed' | 'error';
    durationMs: number;
    usage: TurnUsage;
}
declare module '@deepseek-ai/cordis' {
    interface Events {
        /** A remote CLI turn that no DSH model call covered, such as delegated agents and turns sent from the sessions panel. */
        'remote-agents/usage'(record: RemoteUsageRecord): void;
    }
}
export declare const name = "dsh-remote-agents";
export declare const inject: string[];
export declare const Config: Schema<Schemastery.ObjectS<NoInfer<{
    stateDir: Schema<string, string, "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    stateDir: Schema<string, string, "defined">;
}>>, "plain">;
export declare function apply(ctx: Context, config?: {
    stateDir?: string;
}): Promise<void>;
