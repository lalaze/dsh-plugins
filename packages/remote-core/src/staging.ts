import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Attachment } from './domain.js';

/** Stream one source into private staging; `describe` may reject the bytes before they are published. */
export async function stage(dir: string, source: Iterable<Uint8Array> | AsyncIterable<Uint8Array>, describe: (sha256: string, bytes: number) => Attachment, signal?: AbortSignal): Promise<Attachment> {
  const temp = join(dir, `${randomUUID()}.tmp`), hash = createHash('sha256'); let bytes = 0;
  try {
    await pipeline(Readable.from(source), new Transform({ transform(chunk: Buffer, _encoding, callback) { bytes += chunk.length; hash.update(chunk); callback(null, chunk); } }), createWriteStream(temp, { flags: 'wx', mode: 0o600 }), { signal });
    const attachment = describe(hash.digest('hex'), bytes);
    await rename(temp, join(dir, attachment.sha256)); return attachment;
  } finally { await rm(temp, { force: true }); }
}
