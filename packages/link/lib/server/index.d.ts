import Schema from '@deepseek-ai/schemastery';
import { SELF } from './attention-board.js';
import type { HostContext } from './dsh.js';
export declare const name = "dsh-link";
export declare const inject: string[];
export interface Config {
    name: string;
    port: number;
    listen: boolean;
    discover: boolean;
    peers: string[];
    tailscale: string;
    refreshSeconds: number;
    allowSelf: boolean;
    listenHost: string;
}
export declare const Config: Schema<Config>;
export declare function apply(ctx: HostContext, config: Config): void;
export { SELF };
