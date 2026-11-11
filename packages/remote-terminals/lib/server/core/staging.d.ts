import type { Attachment } from './domain.js';
/** Stream one source into private staging; `describe` may reject the bytes before they are published. */
export declare function stage(dir: string, source: Iterable<Uint8Array> | AsyncIterable<Uint8Array>, describe: (sha256: string, bytes: number) => Attachment, signal?: AbortSignal): Promise<Attachment>;
