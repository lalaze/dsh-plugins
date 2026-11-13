import { type Aspect } from './domain.js';
export interface Options {
    prompt: string;
    out: string;
    refs: string[];
    aspect: Aspect;
    transparent: boolean;
}
export declare function parseArgs(argv: string[]): Promise<Options | 'help'>;
/** Generates and saves; answers what to print. `root` is the project folder, the one that holds `.game-assets`. */
export declare function generate(root: string, options: Options, cwd?: string): Promise<Record<string, unknown>>;
