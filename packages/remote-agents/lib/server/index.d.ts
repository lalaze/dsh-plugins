import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { type RemoteUsageRecord } from './usage.js';
declare module '@deepseek-ai/cordis' {
    interface Events {
        /** Every finished remote CLI turn: main-chat replies, delegated agents and turns sent from the sessions panel. */
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
