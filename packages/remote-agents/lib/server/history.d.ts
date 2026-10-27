import type { Cursor, MessageTimeline, RelayPosition, TimelineEntry, TimelinePage } from './domain.js';
export declare class TaskHistory {
    private readonly directory;
    private readonly taskId;
    private entries;
    private queue;
    private failure?;
    readonly epoch: string;
    constructor(directory: string, taskId: string);
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
