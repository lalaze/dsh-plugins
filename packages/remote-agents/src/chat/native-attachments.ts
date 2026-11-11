import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { RemoteError } from '@dsh-plugins/remote-core/domain.js';
import { fileRefs, isNativeImage, nativeAttachmentLimit, ATTACHMENTS_LIMIT, type NativeFile } from './native-protocol.js';

/** Only public AttachmentStore and the audited local provider publication API.
 * No path supplied by a peer becomes a filesystem destination. */
export async function exportNativeAttachments(store: any, events: unknown): Promise<NativeFile[]> {
  const files: NativeFile[] = []; let total = 0;
  for (const ref of fileRefs(events)) {
    const limit = nativeAttachmentLimit(ref);
    if (ref.bytes > limit || (total += ref.bytes) > ATTACHMENTS_LIMIT) throw new RemoteError('Native attachments exceed transfer limits', 413);
    let data: Buffer;
    if (isNativeImage(ref)) {
      if (!store?.readImage) throw new RemoteError('Image AttachmentStore is unavailable', 501);
      data = Buffer.from((await store.readImage(ref)).data);
    } else {
      if (!store?.readFileStream) throw new RemoteError('File AttachmentStore is unavailable', 501);
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const part of store.readFileStream(ref)) {
        if ((bytes += part.length) > limit) throw new RemoteError('Native attachment exceeds transfer limit', 413);
        chunks.push(Buffer.from(part));
      }
      data = Buffer.concat(chunks);
    }
    if (data.length !== ref.bytes || `sha256:${createHash('sha256').update(data).digest('hex')}` !== ref.attachmentId) throw new RemoteError('AttachmentStore integrity mismatch', 409);
    files.push({ ref, data: data.toString('base64') });
  }
  return files;
}

export async function importNativeAttachments(store: any, files: readonly NativeFile[], load: (name: string) => Promise<any>): Promise<void> {
  let local: any;
  for (const file of files) {
    const data = Buffer.from(file.data, 'base64'), ref = file.ref;
    if (data.toString('base64') !== file.data || data.length !== ref.bytes || data.length > nativeAttachmentLimit(ref)
      || `sha256:${createHash('sha256').update(data).digest('hex')}` !== ref.attachmentId) throw new RemoteError('Attachment integrity mismatch', 409);
    if (!isNativeImage(ref)) {
      const saved = await store.saveFile({ data, name: ref.name });
      if (saved.attachmentId !== ref.attachmentId || saved.bytes !== ref.bytes || saved.name !== ref.name) throw new RemoteError('AttachmentStore changed a file reference', 409);
      continue;
    }
    local ??= await load('@deepseek-ai/dsh-attachment-local');
    if (!(store instanceof local.LocalAttachmentStore) || typeof local.commitPreparedImageFile !== 'function' || !isAbsolute(store.root)) {
      throw new RemoteError('Lossless image import requires the audited local AttachmentStore publication adapter', 501);
    }
    // Admission decodes the raster, applies receiver resource limits, and proves
    // it is usable. Publishing the ALREADY normalized source object must not
    // run saveImage again: receiver normalization can change bytes and IDs.
    await store.validateImage({ data, mediaType: ref.mediaType, name: ref.name });
    await local.commitPreparedImageFile(store.root, { data, ref });
    const verified = await store.readImage(ref);
    if (!data.equals(Buffer.from(verified.data))) throw new RemoteError('Imported image differs from its source object', 409);
  }
}
