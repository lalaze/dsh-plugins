import type { Cursor, MessageTimeline, TimelineEntry, TimelinePage } from './domain.js';
export declare class TaskHistory {
    private readonly directory;
    private readonly taskId;
    private entries;
    private queue;
    private failure?;
    readonly epoch: string;
    constructor(directory: string, taskId: string);
    open(): Promise<void>;
    append(item: TimelineEntry['item'], turnId?: string): Promise<void>;
    page(cursor?: Cursor, direction?: 'before' | 'after'): Promise<TimelinePage>;
    hasMessage(id: string): Promise<boolean>;
    messagePage(messageId: string, cursor?: Cursor): Promise<MessageTimeline>;
    /** Assistant text written since the latest user message, for delegation results. */
    lastReply(): Promise<string>;
    flush(): Promise<void>;
    remove(): Promise<void>;
}
export declare function messageTimeline(all: TimelineEntry[], epoch: string, messageId: string, cursor?: Cursor): MessageTimeline;
