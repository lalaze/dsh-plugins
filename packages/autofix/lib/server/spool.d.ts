/**
 * Files on a machine that two DSHes can both reach: the one a bug is typed into leaves requests there, the one that runs
 * fixes takes them and writes back how each task is doing. Read and written through that machine's shell, the way the
 * repository itself is reached, so neither DSH needs an address or a password for the other.
 */
import type { Machine } from './workplaces.js';
/** In the account's own folder on that machine; its mode keeps other accounts out. */
export declare const SPOOL_ROOT = "$HOME/.dsh-autofix";
/** A task's key as a file name. */
export declare const fileName: (key: string) => string;
export declare class Spool {
    private readonly machine;
    private readonly root;
    constructor(machine: Pick<Machine, 'shell'>, root?: string);
    /** Quoted for the shell; only names this code makes itself get here. */
    private path;
    private sh;
    /** A file's bytes; undefined when it is not there. */
    read(relative: string, signal?: AbortSignal): Promise<Buffer | undefined>;
    readJson<T>(relative: string, signal?: AbortSignal): Promise<T | undefined>;
    /** Whole or not at all: a reader never sees half a file. */
    write(relative: string, data: string | Uint8Array, signal?: AbortSignal): Promise<void>;
    writeJson(relative: string, value: unknown, signal?: AbortSignal): Promise<void>;
    /** A file, or a folder with what is in it. */
    remove(relative: string, signal?: AbortSignal): Promise<void>;
    /** Every *.json in a folder with its text, in one round trip; then what is older than a day in `sweep` is cleared. */
    collect(folder: string, sweep?: string, signal?: AbortSignal): Promise<{
        name: string;
        text: string;
    }[]>;
}
