import type { Context } from '@deepseek-ai/cordis';
export declare const name = "dsh-game-assets";
export declare const inject: string[];
/**
 * Host half: scans the workspace of a conversation for images and for the code that names them, and serves the images to
 * the Assets tab. It reads files only; the one thing it writes is which folders each workspace scans, in the DSH home.
 */
export declare function apply(ctx: Context): void;
