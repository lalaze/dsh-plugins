/** Server-Sent Events: writing them, and an incremental parser both Node and the page use. No Node imports. */
export interface SseEvent {
    event: string;
    data: string;
}
/** Feeds text chunks, calls back per complete event. */
export declare class SseParser {
    private readonly onEvent;
    private buffer;
    private event;
    private data;
    constructor(onEvent: (event: SseEvent) => void);
    push(chunk: string): void;
    private line;
}
/** One event in the wire format. */
export declare const sseFrame: (event: string, value: unknown) => string;
