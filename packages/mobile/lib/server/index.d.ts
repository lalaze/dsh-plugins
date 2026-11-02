/**
 * Host half of dsh-mobile. It connects this machine to a relay, so paired phones can read and steer its sessions
 * from anywhere, and serves the desktop settings page and a copy of the phone app through DSH's own connection.
 */
import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { Hub } from './server/hub.js';
export declare const name = "dsh-mobile";
export declare const inject: string[];
export interface Config {
    stateDir?: string;
    relay?: string;
    appUrl?: string;
}
export declare const Config: Schema<Schemastery.ObjectS<NoInfer<{
    stateDir: Schema<string, string, "defined">;
    relay: Schema<string, string, "plain">;
    appUrl: Schema<string, string, "plain">;
}>>, Schemastery.ObjectT<NoInfer<{
    stateDir: Schema<string, string, "defined">;
    relay: Schema<string, string, "plain">;
    appUrl: Schema<string, string, "plain">;
}>>, "plain">;
export declare function apply(ctx: Context, config?: Config): Promise<void>;
export declare function handleLocal(hub: Hub, request: Request): Promise<Response>;
/**
 * DSH's rule for an exact route: `/api` followed by segments of letters, digits and `_$.-`, none empty. A path it
 * refuses makes route registration throw, which unloads the whole plugin.
 */
export declare const isRoutePath: (path: string) => boolean;
/** The phone app's files DSH can serve: one exact route each, since DSH routes do not match prefixes. */
export declare const appFiles: (files: string[]) => string[];
