/** Pixel sizes read from the first bytes of an image file. */
/** Enough for a PNG, GIF or WebP header, an SVG's root element, and most JPEG frame headers. */
export const HEADER_BYTES = 64 * 1024;
const positive = (width, height) => width > 0 && height > 0 ? { width, height } : undefined;
function jpegSize(data) {
    let offset = 2;
    while (offset + 9 < data.length) {
        if (data[offset] !== 0xff) {
            offset++;
            continue;
        }
        const marker = data[offset + 1];
        // Fill bytes and markers without a length.
        if (marker === 0xff) {
            offset++;
            continue;
        }
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
            offset += 2;
            continue;
        }
        // Start of frame, except the Huffman table (C4), JPEG extension (C8) and arithmetic conditioning (CC) markers.
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
            return positive(data.readUInt16BE(offset + 7), data.readUInt16BE(offset + 5));
        offset += 2 + data.readUInt16BE(offset + 2);
    }
    return undefined;
}
function webpSize(data) {
    if (data.length < 30)
        return undefined;
    const chunk = data.toString('latin1', 12, 16);
    if (chunk === 'VP8X')
        return positive(1 + data.readUIntLE(24, 3), 1 + data.readUIntLE(27, 3));
    if (chunk === 'VP8L' && data[20] === 0x2f) {
        const bits = data.readUInt32LE(21);
        return positive(1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff));
    }
    if (chunk === 'VP8 ' && data[23] === 0x9d && data[24] === 0x01 && data[25] === 0x2a)
        return positive(data.readUInt16LE(26) & 0x3fff, data.readUInt16LE(28) & 0x3fff);
    return undefined;
}
function svgSize(data) {
    const tag = /<svg\b[^>]*>/i.exec(data.toString('utf8'))?.[0];
    if (!tag)
        return undefined;
    const length = (name) => {
        const value = new RegExp(`\\s${name}\\s*=\\s*["']\\s*([0-9.]+)(?:px)?\\s*["']`, 'i').exec(tag)?.[1];
        return value ? Math.round(Number(value)) : NaN;
    };
    const width = length('width'), height = length('height');
    if (width > 0 && height > 0)
        return { width, height };
    const box = /\sviewBox\s*=\s*["']\s*[-0-9.]+[\s,]+[-0-9.]+[\s,]+([0-9.]+)[\s,]+([0-9.]+)\s*["']/i.exec(tag);
    return box ? positive(Math.round(Number(box[1])), Math.round(Number(box[2]))) : undefined;
}
/** The pixel size of a PNG, GIF, WebP, JPEG or SVG; undefined when the bytes are none of these or are cut short. */
export function imageSize(data) {
    try {
        if (data.length >= 24 && data.readUInt32BE(0) === 0x89504e47 && data.toString('latin1', 12, 16) === 'IHDR')
            return positive(data.readUInt32BE(16), data.readUInt32BE(20));
        const magic = data.toString('latin1', 0, 6);
        if (data.length >= 10 && (magic === 'GIF89a' || magic === 'GIF87a'))
            return positive(data.readUInt16LE(6), data.readUInt16LE(8));
        if (data.length >= 16 && magic.startsWith('RIFF') && data.toString('latin1', 8, 12) === 'WEBP')
            return webpSize(data);
        if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8)
            return jpegSize(data);
        return svgSize(data);
    }
    catch {
        return undefined;
    }
}
/** The raster format of an image's bytes, by their first bytes; undefined for anything else, SVG included. */
export function rasterType(data) {
    const at = (offset, text) => [...text].every((char, i) => data[offset + i] === char.charCodeAt(0));
    if (data.length >= 8 && data[0] === 0x89 && at(1, 'PNG'))
        return 'png';
    if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff)
        return 'jpeg';
    if (data.length >= 12 && at(0, 'RIFF') && at(8, 'WEBP'))
        return 'webp';
    if (data.length >= 6 && (at(0, 'GIF87a') || at(0, 'GIF89a')))
        return 'gif';
    return undefined;
}
