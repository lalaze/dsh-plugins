/** Pixel sizes read from the first bytes of an image file. */
/** Enough for a PNG, GIF or WebP header, an SVG's root element, and most JPEG frame headers. */
export declare const HEADER_BYTES: number;
/** The pixel size of a PNG, GIF, WebP, JPEG or SVG; undefined when the bytes are none of these or are cut short. */
export declare function imageSize(data: Buffer): {
    width: number;
    height: number;
} | undefined;
