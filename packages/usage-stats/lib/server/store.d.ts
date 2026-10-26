import { type UsageRecord } from './domain.js';
/** Each plugin and running stream holds a lease until it no longer uses the file. */
export declare function acquireUsageStore(path: string): {
    ready: Promise<UsageStore>;
    release: () => void;
};
/** Serialized atomic snapshots: a failed write never replaces the last committed file. */
export declare class UsageStore {
    private readonly path;
    private records;
    private queue;
    failedWrites: number;
    constructor(path: string);
    load(): Promise<void>;
    snapshot(): readonly UsageRecord[];
    append(record: UsageRecord): Promise<void>;
}
