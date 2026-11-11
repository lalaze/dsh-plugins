import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import type { RemoteAgentsMachines } from './core/machines.js';
import type { RemoteUsageRecord } from './core/usage.js';
import { type Terminals } from './install.js';
declare module '@deepseek-ai/cordis' {
    interface Events {
        /** A finished turn of a TUI conversation, once per model it used, as Remote Agents announces its own turns. */
        'remote-agents/usage'(record: RemoteUsageRecord): void;
    }
}
/** What Remote Agents asks this plugin, as the service `remoteTerminals`. */
export interface RemoteTerminals {
    readonly version: 1;
    /** Whether a DSH conversation's view is a CLI in a terminal, which then answers its turns itself. */
    isTui(sessionId: string): boolean;
}
export declare const name = "dsh-remote-terminals";
export declare const inject: string[];
export declare const Config: Schema<{
    stateDir?: string;
}, {
    stateDir: string;
}>;
/** The plugin's requests. Until Remote Agents provides its machines there is nothing to work on, and they say so. */
export declare function createHandler(live: () => {
    terminals: Terminals;
    machines: RemoteAgentsMachines;
} | undefined): (request: Request) => Promise<Response>;
export declare function apply(ctx: Context, config?: {
    stateDir?: string;
}): Promise<void>;
