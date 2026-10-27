import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { type UsageRecord } from './domain.js';
declare module '@deepseek-ai/cordis' {
    interface Events {
        /** Sent by dsh-remote-agents for remote CLI turns that no DSH model call covered, such as delegated agents. */
        'remote-agents/usage'(record: UsageRecord): void;
    }
}
export declare const name = "dsh-usage-stats";
export declare const inject: string[];
export declare const Config: Schema<Schemastery.ObjectS<NoInfer<{
    stateDir: Schema<string, string, "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    stateDir: Schema<string, string, "defined">;
}>>, "plain">;
export declare function apply(ctx: Context, config?: {
    stateDir?: string;
}): Promise<void>;
