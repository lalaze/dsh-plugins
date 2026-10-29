import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ContentBlock, FileBlock, ImageBlock } from '@deepseek-ai/dsh-llm';
import { attachmentInput, identifier, RemoteError, type Attachment, type NativeAttachment } from '../core/domain.js';
import type { SshTransport } from '../core/ssh.js';

export interface AttachmentAccess {
  image(ref: ImageBlock['attachment'], signal?: AbortSignal): Promise<{ data: Uint8Array; mediaType: string }>;
  file(ref: FileBlock['attachment'], signal?: AbortSignal): AsyncIterable<Uint8Array>;
}
export const attachmentDirectory = (directory: string, taskId: string, messageId: string) => join(directory, 'attachments', identifier(taskId), identifier(messageId));

/** The LLM runtime projects files to text; recover only the session's authorized file blocks. */
export function restoreFiles(content: readonly ContentBlock[], original?: readonly ContentBlock[]): readonly ContentBlock[] {
  if (!original?.some(b => b.type === 'file')) return content;
  if (original.length !== content.length) throw new RemoteError('Cannot recover this message’s file attachments. Attach the files again.');
  return content.map((block, index) => original[index].type === 'file' ? original[index] : block);
}

/** Stream files to private local staging; only bounded request-image versions are buffered. */
export async function stageAttachments(directory: string, taskId: string, messageId: string, blocks: readonly ContentBlock[], access?: AttachmentAccess, signal?: AbortSignal): Promise<Attachment[]> {
  const parts = blocks.filter(b => b.type === 'file' || b.type === 'image');
  if (!parts.length) return [];
  if (!access) throw new RemoteError('The DSH attachment service is unavailable');
  if (parts.length > 100) throw new RemoteError('Up to 100 attachments can be sent at once');
  const dir = attachmentDirectory(directory, taskId, messageId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const staged: Attachment[] = [];
  for (const block of parts) {
    signal?.throwIfAborted();
    const temp = join(dir, `${randomUUID()}.tmp`), hash = createHash('sha256'); let bytes = 0;
    try {
      const image = block.type === 'image' ? await access.image(block.attachment, signal) : undefined;
      const source = image ? [image.data] : access.file(block.attachment as FileBlock['attachment'], signal);
      await pipeline(Readable.from(source), new Transform({ transform(chunk: Buffer, _encoding, callback) { bytes += chunk.length; hash.update(chunk); callback(null, chunk); } }), createWriteStream(temp, { flags: 'wx', mode: 0o600 }), { signal });
      if (block.type === 'file' && bytes !== block.attachment.bytes) throw new RemoteError('Attachment byte count mismatch');
      const sha256 = hash.digest('hex');
      const descriptor = attachmentInput([{ sha256, bytes, name: block.attachment.name || `image.${image?.mediaType.split('/')[1] ?? 'png'}`, kind: block.type === 'image' && !block.offloaded ? 'image' : 'file', mediaType: image?.mediaType }])[0];
      await rename(temp, join(dir, sha256)); staged.push(descriptor);
    } finally { await rm(temp, { force: true }); }
  }
  const images = staged.filter(a => a.kind === 'image');
  if (images.length > 20 || images.reduce((n, a) => n + a.bytes, 0) > 32 * 1024 * 1024) throw new RemoteError('Send at most 20 images and 32 MB of image data at once');
  return staged;
}

/** Scope remote copies to one task/message; display names never select directories. */
export function attachmentRelativePath(taskId: string, messageId: string, attachment: Attachment): string {
  attachmentInput([attachment]);
  const cleaned = attachment.name.replace(/[\\/\x00-\x1f\x7f]/g, '_').replace(/^\.+/, '_');
  let name = '';
  for (const char of cleaned) { if (Buffer.byteLength(name + char) > 160) break; name += char; }
  const extension = attachment.mediaType?.split('/')[1] ?? 'png';
  if (attachment.kind === 'image' && !name.toLowerCase().endsWith(`.${extension}`)) name += `.${extension}`;
  return `.dsh-remote-agents/attachments/${identifier(taskId)}/${identifier(messageId)}/${attachment.sha256}-${name}`;
}
export async function transferAttachments(transport: SshTransport, directory: string, taskId: string, messageId: string, cwd: string, attachments: readonly Attachment[], signal?: AbortSignal): Promise<NativeAttachment[]> {
  if (!attachments.length) return [];
  if (!transport.upload) throw new RemoteError('This SSH transport cannot transfer attachments');
  const result: NativeAttachment[] = [];
  for (const attachment of attachmentInput(attachments)) {
    signal?.throwIfAborted();
    const local = join(attachmentDirectory(directory, taskId, messageId), attachment.sha256);
    const path = await transport.upload(cwd, attachmentRelativePath(taskId, messageId, attachment), createReadStream(local), attachment.bytes, attachment.sha256, signal);
    result.push({ ...attachment, path, ...(attachment.kind === 'image' ? { data: (await readFile(local)).toString('base64') } : {}) });
  }
  return result;
}
export function attachmentPrompt(text: string, attachments: readonly NativeAttachment[]): string {
  return attachments.length ? `${text}\n\nAttachments uploaded to this remote workspace (read the saved files when needed):\n${attachments.map(a => `- ${JSON.stringify(a.name)} (${a.bytes} bytes): ${JSON.stringify(a.path)}`).join('\n')}` : text;
}
