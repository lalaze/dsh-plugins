/** Writing one-frame GIF files in the browser, and telling animated GIFs apart, with no library. */

/**
 * A one-frame GIF89a: `indices` holds one palette index per pixel, row by row; `palette` up to 256 colours as
 * 0xRRGGBB; `transparent` the index drawn see-through, if any.
 */
export function encodeGif(width: number, height: number, indices: Uint8Array, palette: readonly number[], transparent?: number): Uint8Array<ArrayBuffer> {
  if (width < 1 || height < 1 || width > 0xffff || height > 0xffff) throw new Error('A GIF is 1 to 65535 pixels a side');
  if (indices.length !== width * height) throw new Error('One palette index per pixel');
  if (!palette.length || palette.length > 256) throw new Error('A GIF palette has 1 to 256 colours');
  let bits = 1;
  while (1 << bits < palette.length) bits++;
  const out: number[] = [];
  const word = (value: number) => out.push(value & 0xff, (value >> 8) & 0xff);
  for (const char of 'GIF89a') out.push(char.charCodeAt(0));
  word(width); word(height);
  // Global colour table of 2^bits entries, 8 bits per primary.
  out.push(0x80 | 0x70 | (bits - 1), 0, 0);
  for (let i = 0; i < 1 << bits; i++) {
    const colour = palette[i] ?? 0;
    out.push((colour >> 16) & 0xff, (colour >> 8) & 0xff, colour & 0xff);
  }
  if (transparent !== undefined) out.push(0x21, 0xf9, 4, 0x01, 0, 0, transparent & 0xff, 0);
  out.push(0x2c); word(0); word(0); word(width); word(height); out.push(0);
  const minCodeSize = Math.max(2, bits);
  out.push(minCodeSize);
  const data = lzw(indices, minCodeSize);
  for (let i = 0; i < data.length; i += 255) {
    const block = data.subarray(i, i + 255);
    out.push(block.length, ...block);
  }
  out.push(0, 0x3b);
  return Uint8Array.from(out);
}

/** GIF's variable-length LZW, codes packed least significant bit first. */
function lzw(indices: Uint8Array, minCodeSize: number): Uint8Array {
  const clear = 1 << minCodeSize, end = clear + 1;
  const bytes: number[] = [];
  let buffer = 0, filled = 0, codeSize = minCodeSize + 1, next = end + 1;
  let table = new Map<number, number>();
  const emit = (code: number) => {
    buffer |= code << filled;
    filled += codeSize;
    while (filled >= 8) { bytes.push(buffer & 0xff); buffer >>>= 8; filled -= 8; }
  };
  emit(clear);
  let current = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i], key = (current << 8) | k, known = table.get(key);
    if (known !== undefined) { current = known; continue; }
    emit(current);
    if (next === 4096) {
      emit(clear);
      table = new Map();
      next = end + 1;
      codeSize = minCodeSize + 1;
    } else {
      // The decoder adds each entry one code later, so the width grows as the entry that would overflow it is made.
      if (next >= 1 << codeSize) codeSize++;
      table.set(key, next++);
    }
    current = k;
  }
  emit(current);
  emit(end);
  if (filled > 0) bytes.push(buffer & 0xff);
  return Uint8Array.from(bytes);
}

/** How many frames a GIF holds; 0 when the bytes are not a GIF or are cut short. */
export function gifFrames(bytes: Uint8Array): number {
  const text = String.fromCharCode(...bytes.subarray(0, 6));
  if (text !== 'GIF87a' && text !== 'GIF89a' || bytes.length < 13) return 0;
  let at = 13;
  if (bytes[10] & 0x80) at += 3 * (1 << ((bytes[10] & 7) + 1));
  const skipBlocks = () => {
    while (at < bytes.length) {
      const size = bytes[at++];
      if (!size) return true;
      at += size;
    }
    return false;
  };
  let frames = 0;
  while (at < bytes.length) {
    const kind = bytes[at++];
    if (kind === 0x3b) return frames;
    if (kind === 0x21) { at++; if (!skipBlocks()) return frames; continue; }
    if (kind !== 0x2c || at + 9 > bytes.length) return frames;
    const flags = bytes[at + 8];
    at += 9;
    if (flags & 0x80) at += 3 * (1 << ((flags & 7) + 1));
    at++; // LZW minimum code size
    if (!skipBlocks()) return frames + 1;
    frames++;
  }
  return frames;
}
