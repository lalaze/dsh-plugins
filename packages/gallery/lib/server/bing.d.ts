import { type Market, type Wallpaper } from './domain.js';
type Fetch = typeof globalThis.fetch;
export declare function parseBingFeed(value: unknown, market: Market): Wallpaper[];
/** Fixed upstream endpoints only; the route never accepts arbitrary URLs. */
export declare class BingService {
    private request;
    private now;
    private cache;
    private pending;
    constructor(request?: Fetch, now?: () => number);
    feed(market: string): Promise<Wallpaper[]>;
    image(id: string): Promise<Uint8Array<ArrayBuffer>>;
}
export declare function createGalleryHandler(service?: BingService): (request: Request) => Promise<Response>;
export {};
