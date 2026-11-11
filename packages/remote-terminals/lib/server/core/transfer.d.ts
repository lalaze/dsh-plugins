/** Requests carry this header, which a page of another origin cannot add without the browser asking first. */
export declare const requireClient: (request: Request) => void;
export declare const transferFailure: (error: unknown) => Response;
/** The size an upload declares. */
export declare function transferSize(request: Request): number;
/** An upload's body as it arrives, held to exactly the size it declared. */
export declare function transferBody(request: Request, size: number): AsyncGenerator<Uint8Array>;
