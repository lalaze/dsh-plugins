import type { Context } from '@deepseek-ai/cordis';
export declare const name = "dsh-tapd";
export declare const inject: string[];
export declare const API_PATH = "/api/tapd";
export declare function apply(ctx: Context): Promise<void>;
