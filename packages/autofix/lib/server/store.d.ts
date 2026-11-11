import { type Assignment, type Settings, type Task } from './domain.js';
import type { Pool } from './pool.js';
/** Where the files are: this computer's disk now, a shared folder on a saved machine later. */
export interface Files {
    read(name: string): Promise<string | undefined>;
    write(name: string, text: string): Promise<void>;
}
export declare class LocalFiles implements Files {
    private readonly directory;
    constructor(directory: string);
    read(name: string): Promise<string | undefined>;
    write(name: string, text: string): Promise<void>;
}
export declare class Store {
    private readonly files;
    settings: Settings;
    pool: Pool;
    tasks: Record<string, Task>;
    /** Where bugs like earlier ones went, learned from accepted tasks; keys as in pool.ts. */
    memory: Record<string, Assignment>;
    /** Per source: when it was last fetched, and what went wrong if that failed. */
    fetch: Record<string, {
        at?: number;
        error?: string;
    }>;
    private queue;
    constructor(files: Files);
    private load;
    open(now?: number): Promise<void>;
    /** Writes run one at a time, so an earlier one cannot land after a later one. */
    private write;
    saveSettings(settings: Settings): Promise<void>;
    savePool(): Promise<void>;
    saveMemory(): Promise<void>;
    saveTasks(): Promise<void>;
}
