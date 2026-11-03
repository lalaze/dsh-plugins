/** Remote images larger than this stay as alt text: each one is copied over SSH while the reply streams. */
export declare const CHAT_IMAGE_LIMIT: number;
/** A workspace path from a Markdown image destination, or undefined for URLs, anchors and non-image files. */
export declare function imagePathOf(destination: string): string | undefined;
/** Where copies of remote images are kept, under the plugin's state directory. */
export declare const CHAT_IMAGES = "chat-images";
/** A copy's file name: the hash of its bytes and the extension it is shown with. */
export declare const chatImageName: (data: Uint8Array, extension: string) => string;
/** Save a remote image under `directory` by content hash; the same bytes reuse one file. */
export declare function saveChatImage(directory: string, path: string, data: Uint8Array): Promise<string>;
/** Save `data` as `directory/name` unless that file exists already. */
export declare function writeChatImage(directory: string, name: string, data: Uint8Array): Promise<string>;
/**
 * An image a remote CLI looked at or made with a tool, such as a screenshot it read or a picture it generated. The
 * tool's `tool_call` item lists it under `images`. `file` names a copy in `chat-images/`, saved from the bytes in the
 * CLI's output by the DSH that read it. `path` is where the image is on the remote machine: Codex's `view_image` reports
 * only that, and a DSH without the copy, such as another one following a shared session, fetches it from there.
 */
export interface ViewedImage {
    file?: string;
    path?: string;
    name: string;
}
/** The extension an image tool result of this media type is saved with, or undefined when the chat cannot show it. */
export declare const viewedImageExtension: (mediaType: unknown) => string | undefined;
/** The extension for an image's bytes, from their signature; undefined for anything else, which is never shown. */
export declare function imageExtensionOf(data: Uint8Array): string | undefined;
/** An absolute remote path to an image file, the only kind of path fetched for a tool's image. */
export declare const viewedImagePath: (path: unknown) => path is string;
/**
 * Markdown showing the images a tool call recorded, one per line, from the copies under `directory`. An image without a
 * copy here is fetched by its remote path with `fetch`, which returns the local copy it saved. Images already in
 * `shown`, a set of copy names, and images that cannot be found are left out; shown ones are added.
 */
export declare function viewedImageMarkdown(directory: string, images: unknown, shown: Set<string>, fetch?: (path: string) => Promise<string | undefined>): Promise<string>;
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
