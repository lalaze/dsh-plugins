import type { Item, ItemImage, Source } from './domain.js';
export declare const MANUAL = "manual";
/** `attached` counts pictures that are not sent here because DSH already keeps them; the text still gets a mark for each. */
export interface ManualInput {
    title?: unknown;
    body?: unknown;
    labels?: unknown;
    images?: unknown;
    attached?: unknown;
}
export declare class ManualSource implements Source {
    private readonly directory;
    readonly id = "manual";
    /** A page shows this in its own language. */
    readonly name = "Manual";
    private next;
    constructor(directory: string);
    private folder;
    /** Numbers go up and are never used twice, also across restarts. */
    private number;
    /** Checks what was typed and keeps the pictures; the item still has to be handed to the pool. */
    create(input: ManualInput): Promise<Item>;
    image(item: Item, index: number): Promise<ItemImage | undefined>;
    discard(item: Item): Promise<void>;
}
