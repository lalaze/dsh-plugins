/** A plain GIF reader for tests, written from the GIF89a specification apart from the encoder it checks. */
export interface DecodedGif { width: number; height: number; palette: number[]; indices: Uint8Array; transparent?: number }

export function decodeGif(bytes: Uint8Array): DecodedGif {
  const signature = String.fromCharCode(...bytes.subarray(0, 6));
  if (signature !== 'GIF89a' && signature !== 'GIF87a') throw new Error(`not a GIF: ${signature}`);
  const word = (at: number) => bytes[at] | (bytes[at + 1] << 8);
  const width = word(6), height = word(8), flags = bytes[10];
  const palette: number[] = [];
  let at = 13;
  if (flags & 0x80) {
    for (let i = 0; i < 1 << ((flags & 7) + 1); i++, at += 3) palette.push((bytes[at] << 16) | (bytes[at + 1] << 8) | bytes[at + 2]);
  }
  let transparent: number | undefined;
  const blocks = () => {
    const parts: number[] = [];
    for (let size = bytes[at++]; size; size = bytes[at++]) { parts.push(...bytes.subarray(at, at + size)); at += size; }
    return Uint8Array.from(parts);
  };
  for (;;) {
    const kind = bytes[at++];
    if (kind === 0x21) {
      const label = bytes[at++];
      const body = blocks();
      if (label === 0xf9 && body[0] & 1) transparent = body[3];
      continue;
    }
    if (kind !== 0x2c) throw new Error(`no image block (0x${kind?.toString(16)})`);
    const imageFlags = bytes[at + 8];
    if (imageFlags & 0x80) throw new Error('local colour tables are not expected');
    at += 9;
    const minCodeSize = bytes[at++];
    const indices = lzwDecode(blocks(), minCodeSize, width * height);
    return { width, height, palette, indices, ...(transparent !== undefined ? { transparent } : {}) };
  }
}

function lzwDecode(data: Uint8Array, minCodeSize: number, count: number): Uint8Array {
  const clear = 1 << minCodeSize, end = clear + 1, out = new Uint8Array(count);
  let table: number[][] = [], codeSize = 0, next = 0, previous: number[] | undefined, written = 0;
  const reset = () => {
    table = Array.from({ length: clear }, (_, i) => [i]);
    table[clear] = []; table[end] = [];
    codeSize = minCodeSize + 1; next = end + 1; previous = undefined;
  };
  reset();
  let bit = 0;
  const read = () => {
    let code = 0;
    for (let i = 0; i < codeSize; i++, bit++) code |= ((data[bit >> 3] >> (bit & 7)) & 1) << i;
    return code;
  };
  while (bit + codeSize <= data.length * 8) {
    const code = read();
    if (code === clear) { reset(); continue; }
    if (code === end) break;
    let entry: number[];
    if (code < next && table[code]) entry = table[code];
    else if (code === next && previous) entry = [...previous, previous[0]];
    else throw new Error(`bad code ${code} (next ${next})`);
    for (const index of entry) out[written++] = index;
    if (previous && next < 4096) {
      table[next++] = [...previous, entry[0]];
      if (next === 1 << codeSize && codeSize < 12) codeSize++;
    }
    previous = entry;
  }
  if (written !== count) throw new Error(`decoded ${written} of ${count} pixels`);
  return out;
}
