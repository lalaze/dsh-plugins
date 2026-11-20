import { type ProjectInfo } from './domain.js';
/** `status` answers the request with it; the message is a sentence the tab can show. */
export declare class StatusError extends Error {
    readonly status: number;
    constructor(message: string, status?: number);
}
export interface StoredStatus {
    text: string;
    revision: string;
    updatedAt?: number;
}
/**
 * Status files, one per project, in a folder of the DSH host. The files are the record: agents edit them with their own
 * tools while the tab is open, so nothing read here is kept, and a save names the text it started from. Beside them
 * `index.json` remembers which project each file belongs to, for listing them without a conversation in each.
 */
export declare class StatusStore {
    private readonly directory;
    private queue;
    private index;
    constructor(directory: string);
    file(id: string): string;
    read(id: string): Promise<StoredStatus>;
    /** @param base - the revision the new text was made from; another one in the file means someone wrote meanwhile. */
    write(id: string, text: string, base: string): Promise<StoredStatus>;
    /** Notes which project a file is for. Nothing is written when it is already known as it is. */
    remember(project: ProjectInfo): Promise<void>;
    projects(): Promise<ProjectInfo[]>;
    private loadIndex;
    /** Whole or not at all: a reader never sees half a file, and a failed write leaves the old one. */
    private replace;
    /** One write at a time, so a check against the file and the write after it are not interleaved with another's. */
    private queued;
}
