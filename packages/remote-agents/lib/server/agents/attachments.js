import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { attachmentInput, identifier, RemoteError } from '../core/domain.js';
export const attachmentDirectory = (directory, taskId, messageId) => join(directory, 'attachments', identifier(taskId), identifier(messageId));
/** The LLM runtime projects files to text; recover only the session's authorized file blocks. */
export function restoreFiles(content, original) {
    if (!original?.some(b => b.type === 'file'))
        return content;
    if (original.length !== content.length)
        throw new RemoteError('Cannot recover this message’s file attachments. Attach the files again.');
    return content.map((block, index) => original[index].type === 'file' ? original[index] : block);
}
/** Stream one source into private staging; `describe` may reject the bytes before they are published. */
async function stage(dir, source, describe, signal) {
    const temp = join(dir, `${randomUUID()}.tmp`), hash = createHash('sha256');
    let bytes = 0;
    try {
        await pipeline(Readable.from(source), new Transform({ transform(chunk, _encoding, callback) { bytes += chunk.length; hash.update(chunk); callback(null, chunk); } }), createWriteStream(temp, { flags: 'wx', mode: 0o600 }), { signal });
        const attachment = describe(hash.digest('hex'), bytes);
        await rename(temp, join(dir, attachment.sha256));
        return attachment;
    }
    finally {
        await rm(temp, { force: true });
    }
}
/** Stream files to private local staging; only bounded request-image versions are buffered. */
export async function stageAttachments(directory, taskId, messageId, blocks, access, signal) {
    const parts = blocks.filter(b => b.type === 'file' || b.type === 'image');
    if (!parts.length)
        return [];
    if (!access)
        throw new RemoteError('The DSH attachment service is unavailable');
    if (parts.length > 100)
        throw new RemoteError('Up to 100 attachments can be sent at once');
    const dir = attachmentDirectory(directory, taskId, messageId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const staged = [];
    for (const block of parts) {
        signal?.throwIfAborted();
        const image = block.type === 'image' ? await access.image(block.attachment, signal) : undefined;
        const source = image ? [image.data] : access.file(block.attachment, signal);
        staged.push(await stage(dir, source, (sha256, bytes) => {
            if (block.type === 'file' && bytes !== block.attachment.bytes)
                throw new RemoteError('Attachment byte count mismatch');
            return attachmentInput([{ sha256, bytes, name: block.attachment.name || `image.${image?.mediaType.split('/')[1] ?? 'png'}`, kind: block.type === 'image' && !block.offloaded ? 'image' : 'file', mediaType: image?.mediaType }])[0];
        }, signal));
    }
    const images = staged.filter(a => a.kind === 'image');
    if (images.length > 20 || images.reduce((n, a) => n + a.bytes, 0) > 32 * 1024 * 1024)
        throw new RemoteError('Send at most 20 images and 32 MB of image data at once');
    return staged;
}
/** DSH's `@path` grammar: a quoted path, or a bare one without trailing sentence punctuation. */
function mentions(text) {
    return [...text.matchAll(/(?<!\S)(@"[^"\n]+"|@[^\s]+)/gu)].flatMap(match => {
        const raw = match[0].startsWith('@"') ? match[0] : match[0].replace(/[.,;:!?，。；：！？]+$/u, '');
        return raw.length > 1 ? [{ start: match.index, end: match.index + raw.length, path: raw.slice(1).replace(/^"|"$/gu, '') }] : [];
    });
}
/**
 * DSH Desktop cites dropped or picked non-image files as absolute `@path` mentions instead of uploading them.
 * Those paths name the DSH machine; paths inside the remote workspace stay for the CLI to read itself.
 */
export function localFileMentions(text, remoteCwd) {
    const inside = (path) => path === remoteCwd || path.startsWith(`${remoteCwd.replace(/\/+$/, '')}/`);
    return [...new Set(mentions(text).map(m => m.path).filter(path => isAbsolute(path) && !/[\\/]$/.test(path) && !inside(path)))];
}
/** Stage the mentioned files that exist on this machine; anything else is left for the remote CLI. */
export async function stageLocalFiles(directory, taskId, messageId, paths, signal) {
    const dir = attachmentDirectory(directory, taskId, messageId), staged = [];
    for (const path of paths) {
        signal?.throwIfAborted();
        if (!(await stat(path).catch(() => undefined))?.isFile())
            continue;
        await mkdir(dir, { recursive: true, mode: 0o700 });
        const attachment = await stage(dir, createReadStream(path), (sha256, bytes) => attachmentInput([{ sha256, bytes, name: basename(path), kind: 'file' }])[0], signal)
            .catch(error => { throw signal?.aborted ? error : new RemoteError(`Cannot read ${path} to send it to the remote workspace: ${error instanceof Error ? error.message : String(error)}`); });
        staged.push({ path, attachment });
    }
    return staged;
}
/** Point each staged mention at its uploaded copy, relative to the remote CLI's working directory. */
export function localFilePrompt(text, taskId, messageId, files) {
    if (!files.length)
        return text;
    const copies = new Map(files.map(f => [f.path, attachmentRelativePath(taskId, messageId, f.attachment)]));
    let result = '', from = 0;
    for (const mention of mentions(text)) {
        const copy = copies.get(mention.path);
        // A name the grammar cannot quote keeps its original mention; the attachment list still names its copy.
        if (!copy || copy.includes('"'))
            continue;
        result += text.slice(from, mention.start) + (/\s/u.test(copy) ? `@"${copy}"` : `@${copy}`);
        from = mention.end;
    }
    return result + text.slice(from);
}
/** Scope remote copies to one task/message; display names never select directories. */
export function attachmentRelativePath(taskId, messageId, attachment) {
    attachmentInput([attachment]);
    const cleaned = attachment.name.replace(/[\\/\x00-\x1f\x7f]/g, '_').replace(/^\.+/, '_');
    let name = '';
    for (const char of cleaned) {
        if (Buffer.byteLength(name + char) > 160)
            break;
        name += char;
    }
    const extension = attachment.mediaType?.split('/')[1] ?? 'png';
    if (attachment.kind === 'image' && !name.toLowerCase().endsWith(`.${extension}`))
        name += `.${extension}`;
    return `.dsh-remote-agents/attachments/${identifier(taskId)}/${identifier(messageId)}/${attachment.sha256}-${name}`;
}
export async function transferAttachments(transport, directory, taskId, messageId, cwd, attachments, signal) {
    if (!attachments.length)
        return [];
    if (!transport.upload)
        throw new RemoteError('This SSH transport cannot transfer attachments');
    const result = [];
    for (const attachment of attachmentInput(attachments)) {
        signal?.throwIfAborted();
        const local = join(attachmentDirectory(directory, taskId, messageId), attachment.sha256);
        const path = await transport.upload(cwd, attachmentRelativePath(taskId, messageId, attachment), createReadStream(local), attachment.bytes, attachment.sha256, signal);
        result.push({ ...attachment, path, ...(attachment.kind === 'image' ? { data: (await readFile(local)).toString('base64') } : {}) });
    }
    return result;
}
export function attachmentPrompt(text, attachments) {
    return attachments.length ? `${text}\n\nAttachments uploaded to this remote workspace (read the saved files when needed):\n${attachments.map(a => `- ${JSON.stringify(a.name)} (${a.bytes} bytes): ${JSON.stringify(a.path)}`).join('\n')}` : text;
}
