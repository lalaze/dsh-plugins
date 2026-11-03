import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
/** Remote images larger than this stay as alt text: each one is copied over SSH while the reply streams. */
export const CHAT_IMAGE_LIMIT = 20 * 1024 * 1024;
const EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.avif']);
const IMAGE = /!\[([^\]\n]*)\]\(\s*(<[^>\n]*>|[^\s()<>]+)(\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g;
/** An unfinished image can be held back this long before it is shown as written. */
const HOLD_LIMIT = 2048;
/** A workspace path from a Markdown image destination, or undefined for URLs, anchors and non-image files. */
export function imagePathOf(destination) {
    let path = destination.startsWith('<') ? destination.slice(1, -1) : destination;
    if (!path || /^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith('//') || path.startsWith('#'))
        return;
    path = path.split(/[?#]/)[0];
    try {
        path = decodeURIComponent(path);
    }
    catch {
        return;
    }
    return EXTENSIONS.has(extname(path).toLowerCase()) ? path : undefined;
}
/** Where copies of remote images are kept, under the plugin's state directory. */
export const CHAT_IMAGES = 'chat-images';
/** A copy's file name: the hash of its bytes and the extension it is shown with. */
export const chatImageName = (data, extension) => `${createHash('sha256').update(data).digest('hex')}${extension}`;
/** Save a remote image under `directory` by content hash; the same bytes reuse one file. */
export async function saveChatImage(directory, path, data) {
    return writeChatImage(directory, chatImageName(data, extname(path).toLowerCase()), data);
}
/** Save `data` as `directory/name` unless that file exists already. */
export async function writeChatImage(directory, name, data) {
    const file = join(directory, name);
    if (await stat(file).then(s => s.isFile(), () => false))
        return file;
    await mkdir(directory, { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporary, data);
        await rename(temporary, file);
    }
    finally {
        await rm(temporary, { force: true });
    }
    return file;
}
const MEDIA_TYPES = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };
/** The extension an image tool result of this media type is saved with, or undefined when the chat cannot show it. */
export const viewedImageExtension = (mediaType) => typeof mediaType === 'string' ? MEDIA_TYPES[mediaType.toLowerCase()] : undefined;
/** The extension for an image's bytes, from their signature; undefined for anything else, which is never shown. */
export function imageExtensionOf(data) {
    const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength), ascii = (from, to) => bytes.subarray(from, to).toString('latin1');
    if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0x89504e47)
        return '.png';
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
        return '.jpg';
    if (ascii(0, 4) === 'GIF8')
        return '.gif';
    if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP')
        return '.webp';
}
/** Timeline items can come from another DSH: only content-hash names are trusted as file names. */
const VIEWED_FILE = /^[0-9a-f]{64}\.(?:png|jpg|gif|webp)$/;
/** An absolute remote path to an image file, the only kind of path fetched for a tool's image. */
export const viewedImagePath = (path) => typeof path === 'string' && path.length <= 4096 && /^\/[^\0\r\n]*\.(?:png|jpe?g|gif|webp)$/i.test(path);
/**
 * Markdown showing the images a tool call recorded, one per line, from the copies under `directory`. An image without a
 * copy here is fetched by its remote path with `fetch`, which returns the local copy it saved. Images already in
 * `shown`, a set of copy names, and images that cannot be found are left out; shown ones are added.
 */
export async function viewedImageMarkdown(directory, images, shown, fetch) {
    const lines = [];
    for (const image of Array.isArray(images) ? images : []) {
        const saved = typeof image?.file === 'string' && VIEWED_FILE.test(image.file) ? join(directory, image.file) : undefined;
        let file = saved && await stat(saved).then(s => s.isFile(), () => false) ? saved : undefined;
        if (!file && fetch && viewedImagePath(image?.path))
            file = await fetch(image.path).catch(() => undefined);
        const name = file && basename(file);
        if (!file || !name || shown.has(name) || /[<>\n]/.test(file))
            continue;
        shown.add(name);
        const alt = (typeof image.name === 'string' ? image.name : '').replace(/[[\]\\<>\r\n]/g, '').slice(0, 200) || 'Image';
        lines.push(`![${alt}](<${file.replace(/\\/g, '/')}>)`);
    }
    return lines.join('\n\n');
}
/**
 * Rewrites Markdown images that name remote workspace files so they point at local copies. The DSH chat
 * reads image paths on the DSH host, where a remote workspace's files do not exist. Text arrives in
 * deltas, so an image that is still incomplete is held back until it closes.
 */
export class ChatImageLinks {
    resolve;
    pending = '';
    resolved = new Map();
    /** `resolve` returns a local absolute path for a remote workspace path, or undefined to leave it as written. */
    constructor(resolve) {
        this.resolve = resolve;
    }
    /** Add streamed text; returns the text that is ready to show. */
    async push(text) {
        const buffer = this.pending + text;
        let output = '', last = 0;
        for (const match of buffer.matchAll(IMAGE)) {
            output += buffer.slice(last, match.index) + await this.rewrite(match);
            last = match.index + match[0].length;
        }
        const rest = buffer.slice(last), hold = this.holdFrom(rest);
        this.pending = rest.slice(hold);
        return output + rest.slice(0, hold);
    }
    /** Release held text as written, when the text block ends. */
    flush() {
        const text = this.pending;
        this.pending = '';
        return text;
    }
    /** Where an image that may still be completing begins in `text`. */
    holdFrom(text) {
        if (text.endsWith('!'))
            return text.length - 1;
        const start = text.lastIndexOf('![');
        return start >= 0 && !text.includes('\n', start) && text.length - start <= HOLD_LIMIT ? start : text.length;
    }
    async rewrite(match) {
        const path = imagePathOf(match[2]);
        if (path === undefined)
            return match[0];
        let local = this.resolved.get(path);
        if (!local) {
            local = this.resolve(path).catch(() => undefined);
            this.resolved.set(path, local);
        }
        const file = await local;
        return file && !/[<>\n]/.test(file) ? `![${match[1]}](<${file.replace(/\\/g, '/')}>${match[3] ?? ''})` : match[0];
    }
}
