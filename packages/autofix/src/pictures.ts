/** Pictures a person adds on a page: what the bytes really are, and how many and how large they may be. */
import type { ItemImage } from './domain.js';

export const MAX_PICTURES = 8;
export const MAX_PICTURE_BYTES = 10 * 1024 * 1024;
export const EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
/** What the bytes are, whatever the page said they were. */
export function sniff(data: Uint8Array): string | undefined {
  const head = Buffer.from(data.subarray(0, 12)), text = head.toString('latin1');
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (text.startsWith('RIFF') && text.slice(8, 12) === 'WEBP') return 'image/webp';
  if (text.startsWith('GIF8')) return 'image/gif';
  return undefined;
}
/** Pictures as a page sends them, `{ name, data: base64 }`, checked. Throws what to tell the person. */
export function decodePictures(raw: unknown): ItemImage[] {
  const list = Array.isArray(raw) ? raw : [];
  if (list.length > MAX_PICTURES) throw new Error(`Add at most ${MAX_PICTURES} pictures`);
  return list.map((entry, index) => {
    const input = (entry ?? {}) as { data?: unknown; name?: unknown }, data = Buffer.from(typeof input.data === 'string' ? input.data : '', 'base64'), mediaType = sniff(data);
    if (!mediaType) throw new Error(`Picture ${index + 1} is not a PNG, JPEG, WebP or GIF`);
    if (data.length > MAX_PICTURE_BYTES) throw new Error(`Picture ${index + 1} is larger than 10 MB`);
    const name = typeof input.name === 'string' ? input.name.replace(/[\\/\0]/gu, '').slice(0, 100) : '';
    return { data, mediaType, ...(name ? { name } : {}) };
  });
}
