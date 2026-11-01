/**
 * Host half of dsh-device-sync. It listens for the paired machine on this machine's Tailscale address, keeps
 * read-only copies of that machine's sessions in its own storage, and serves the browser client through DSH's
 * authenticated connection.
 */
import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { DeviceSync } from './server/service.js';
export declare const name = "dsh-device-sync";
export declare const inject: string[];
export interface Config {
    stateDir?: string;
    port?: number;
    listenHost?: string;
    advertise?: string;
    anyNetwork?: boolean;
}
export declare const Config: Schema<Schemastery.ObjectS<NoInfer<{
    stateDir: Schema<string, string, "defined">;
    port: Schema<number, number, "defined">;
    listenHost: Schema<string, string, "plain">;
    advertise: Schema<string, string, "plain">;
    anyNetwork: Schema<boolean, boolean, "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    stateDir: Schema<string, string, "defined">;
    port: Schema<number, number, "defined">;
    listenHost: Schema<string, string, "plain">;
    advertise: Schema<string, string, "plain">;
    anyNetwork: Schema<boolean, boolean, "defined">;
}>>, "plain">;
export declare function apply(ctx: Context, config?: Config): Promise<void>;
export declare function handleLocal(sync: DeviceSync, request: Request): Promise<Response>;
export declare function handleLive(sync: DeviceSync, request: Request): Promise<Response>;
export declare function handleAttachment(sync: DeviceSync, request: Request): Promise<Response>;
