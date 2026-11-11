/** Pictures a person adds on a page: what the bytes really are, and how many and how large they may be. */
import type { ItemImage } from './domain.js';
export declare const MAX_PICTURES = 8;
export declare const MAX_PICTURE_BYTES: number;
export declare const EXTENSIONS: Record<string, string>;
/** What the bytes are, whatever the page said they were. */
export declare function sniff(data: Uint8Array): string | undefined;
/** Pictures as a page sends them, `{ name, data: base64 }`, checked. Throws what to tell the person. */
export declare function decodePictures(raw: unknown): ItemImage[];
