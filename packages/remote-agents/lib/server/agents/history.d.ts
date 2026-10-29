import type { Cursor, MessageTimeline, RelayPosition, TimelineEntry, TimelinePage } from '../core/domain.js';
export declare class TaskHistory {
    private readonly directory;
    private readonly taskId;
    private entries;
    private queue;
    private failure?;
    /** Raised when entries are replaced, so readers holding cursors start over. */
    private generation;
    /** Called after entries written here are saved; a shared host copies them to its registry. Not called for imports. */
    onAppend?: () => void;
    constructor(directory: string, taskId: string);
    get epoch(): string;
    private get file();
    open(): Promise<void>;
    append(item: TimelineEntry['item'], turnId?: string, relay?: RelayPosition): Promise<void>;
    /**
     * One write for everything a CLI output line produced. Every entry records the relay byte
     * offset after that line, so a restarted DSH resumes there without repeating or losing output.
     */
    appendBatch(items: {
        item: TimelineEntry['item'];
        turnId?: string;
    }[], relay?: RelayPosition): Promise<void>;
    /** Number of saved entries, once queued writes finished. */
    length(): Promise<number>;
    /** Entries `from`…`to` (1-based, inclusive) as saved lines. */
    lines(from: number, to?: number): Promise<string[]>;
    /** Append entries another DSH recorded. They must continue this history's sequence. */
    importLines(lines: string[]): Promise<void>;
    /** Keep only the first `seq` entries: what this DSH recorded after losing a shared session is replaced by the shared history. */
    truncate(seq: number): Promise<void>;
    /** Where to resume reading a relay: after the last output line whose entries were saved. */
    checkpoint(relayId: string): Promise<RelayPosition | undefined>;
    /** The latest submitted message and everything recorded after it. */
    turn(): Promise<{
        message?: TimelineEntry;
        entries: TimelineEntry[];
    }>;
    page(cursor?: Cursor, direction?: 'before' | 'after'): Promise<TimelinePage>;
    hasMessage(id: string): Promise<boolean>;
    messagePage(messageId: string, cursor?: Cursor): Promise<MessageTimeline>;
    /** Assistant text written since the latest user message, for delegation results. */
    lastReply(): Promise<string>;
    flush(): Promise<void>;
    remove(): Promise<void>;
}
export declare function messageTimeline(all: TimelineEntry[], epoch: string, messageId: string, cursor?: Cursor): MessageTimeline;
