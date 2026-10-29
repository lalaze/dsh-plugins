/** Remote images larger than this stay as alt text: each one is copied over SSH while the reply streams. */
export declare const CHAT_IMAGE_LIMIT: number;
/** A workspace path from a Markdown image destination, or undefined for URLs, anchors and non-image files. */
export declare function imagePathOf(destination: string): string | undefined;
/** Save a remote image under `directory` by content hash; the same bytes reuse one file. */
export declare function saveChatImage(directory: string, path: string, data: Uint8Array): Promise<string>;
/**
 * Rewrites Markdown images that name remote workspace files so they point at local copies. The DSH chat
 * reads image paths on the DSH host, where a remote workspace's files do not exist. Text arrives in
 * deltas, so an image that is still incomplete is held back until it closes.
 */
export declare class ChatImageLinks {
    private readonly resolve;
    private pending;
    private readonly resolved;
    /** `resolve` returns a local absolute path for a remote workspace path, or undefined to leave it as written. */
    constructor(resolve: (path: string) => Promise<string | undefined>);
    /** Add streamed text; returns the text that is ready to show. */
    push(text: string): Promise<string>;
    /** Release held text as written, when the text block ends. */
    flush(): string;
    /** Where an image that may still be completing begins in `text`. */
    private holdFrom;
    private rewrite;
}
