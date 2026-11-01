/** Read JSON, or undefined when the file does not exist. An unreadable file is moved aside and treated as missing. */
export declare function readJson<T>(path: string): Promise<T | undefined>;
/** Replace a file in one step, readable only by this user: a crash leaves the old or the new file, never half of one. */
export declare function writeJsonAtomic(path: string, value: unknown): Promise<void>;
export declare function writeAtomic(path: string, data: string | Uint8Array): Promise<void>;
export declare function appendLines(path: string, lines: readonly string[]): Promise<void>;
/** Runs tasks one at a time, in order; a failed task does not stop the ones after it. */
export declare class Serial {
    private tail;
    run<T>(task: () => Promise<T>): Promise<T>;
}
