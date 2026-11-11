import type { Context } from '@deepseek-ai/cordis';
export declare const name = "dsh-game-assets";
export declare const inject: string[];
/**
 * Host half: scans the workspace of a conversation for images and for the code that names them, and serves the images to
 * the Assets tab; on request it retires images and saves tags there (manage.ts). A workspace on a remote machine is
 * worked on through Remote Agents' connection to it, by a script sent to that machine (remote-agent.ts).
 */
export declare function apply(ctx: Context): void;
