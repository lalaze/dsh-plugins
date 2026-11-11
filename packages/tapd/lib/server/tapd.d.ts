/** TAPD's open API for bugs: the ones a person owns, one by ID, and writing a status or a comment back. */
import type { Bug, TapdSettings } from './settings.js';
/** TAPD has two names for a status: the API value (`in_progress`) and what the workspace shows (`处理中`). */
export declare const isApiStatus: (value: string) => boolean;
export declare function statusQuery(statuses: readonly string[]): Record<string, string>;
export declare const statusField: (status: string) => Record<string, string>;
export declare function parseBugs(payload: unknown): Bug[];
/** The pictures in a bug's description, in order, each once. */
export declare function imageSources(description: string): string[];
/** A description as plain text for a model: paragraphs kept, pictures as `[image N]` in their place. */
export declare function descriptionText(description: string): string;
export interface TapdImage {
    bytes: Uint8Array;
    mediaType: string;
    extension: string;
}
export declare class TapdClient {
    private readonly settings;
    private readonly fetcher;
    constructor(settings: () => TapdSettings, fetcher?: typeof fetch);
    private authorization;
    private request;
    /** The owner's bugs in the chosen statuses, across the configured TAPD projects. */
    listBugs(signal?: AbortSignal): Promise<Bug[]>;
    getBug(workspaceId: string, id: string, signal?: AbortSignal): Promise<Bug | undefined>;
    /** A status, a comment, or both. */
    update(bug: Pick<Bug, 'id' | 'workspaceId'>, change: {
        status?: string;
        comment?: string;
    }, signal?: AbortSignal): Promise<void>;
    /** Where a description's picture really is. TAPD writes its own as `/tfl/…`, served by the web site, not the API. */
    imageUrl(source: string): URL | undefined;
    /** One picture; undefined when it is not a picture a model can read. The sign-in goes only to TAPD's own hosts. */
    image(source: string, signal?: AbortSignal): Promise<TapdImage | undefined>;
}
/** The bug's page for a person. */
export declare const bugUrl: (bug: Pick<Bug, "id" | "workspaceId">) => string;
