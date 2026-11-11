import type { Context } from '@deepseek-ai/cordis';
import { COMMAND } from './command.js';
import { API_PATH } from './http.js';
export declare const name = "dsh-autofix";
export declare const inject: string[];
export { API_PATH, COMMAND };
export type { Autofix, Item, ItemEvent, Message, Source } from './domain.js';
export declare function apply(ctx: Context): Promise<void>;
