import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isSpriteSheet, sheetHint } from '../src/domain.js';
import { encodeGif, gifFrames } from '../src/client/gif.js';
import { GIF_COLOURS, REFERENCE_SIDE, coloursOf, indexPixels, paletteOf, pickKey, planSheet, referenceOf, restoreSprite, seeThrough, sheetSize, type Pixels } from '../src/client/sprite.js';
import { decodeGif } from './gif-decode.js';

/** A sprite drawn from rows of characters: `.` is see-through, other letters are colours from `colours`. */
function sprite(rows: string[], colours: Record<string, number>): Pixels {
  const width = rows[0].length, height = rows.length, data = new Uint8ClampedArray(width * height * 4);
  rows.forEach((row, y) => [...row].forEach((char, x) => {
    if (char === '.') return;
    const colour = colours[char], at = (y * width + x) * 4;
    data[at] = colour >> 16; data[at + 1] = (colour >> 8) & 0xff; data[at + 2] = colour & 0xff; data[at + 3] = 255;
  }));
  return { width, height, data };
}
const rgba = (pixels: Pixels, x: number, y: number) => [...pixels.data.subarray((y * pixels.width + x) * 4, (y * pixels.width + x) * 4 + 4)];
/** What h3 hands back in the best case: the reference at another, non-whole scale, read by nearest neighbour. */
function resized(pixels: Pixels, width: number, height: number): Pixels {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const from = (Math.floor(((y + 0.5) * pixels.height) / height) * pixels.width + Math.floor(((x + 0.5) * pixels.width) / width)) * 4;
    data.set(pixels.data.subarray(from, from + 4), (y * width + x) * 4);
  }
  return { width, height, data };
}
const COLOURS = { r: 0xc0392b, b: 0x5a3a29, s: 0xf2c49b, k: 0x1b1b1b };

test('the key is the saturated colour farthest from the sprite: magenta unless the sprite uses it', () => {
  assert.equal(pickKey([0xc0392b, 0x5a3a29]), 0x00ffff);
  assert.equal(pickKey([0xff10f0, 0xf000f0]), 0x00ff00, 'a pink sprite gets a green key');
  assert.equal(pickKey([]), 0xff00ff);
  assert.equal(seeThrough(sprite(['rr', 'rr'], COLOURS)), false);
  assert.equal(seeThrough(sprite(['r.', 'rr'], COLOURS)), true);
  assert.deepEqual([...coloursOf(sprite(['rr', 'b.'], COLOURS))], [[0xc0392b, 2], [0x5a3a29, 1]]);
});

test('a long strip is cut into the squarest set of bands whose cuts cross only empty columns; others stay whole', () => {
  // Twelve 4-pixel frames, each with an empty column on both sides.
  const strip = sprite(['.rr.'.repeat(12), '.bb.'.repeat(12), '.ss.'.repeat(12)], COLOURS);
  const plan = planSheet(strip);
  assert.ok(isSpriteSheet(plan));
  assert.equal(plan.gutter, 2);
  // 48 × 3 is 16:1; four bands of 12 give 12 × 18, three give 16 × 13, two 24 × 8.
  assert.equal(plan.bands, 3);
  assert.deepEqual(sheetSize(48, 3, plan), { width: 16, height: 13 });
  // A figure across every possible cut keeps the strip whole.
  assert.equal(planSheet(sprite(['r'.repeat(48), 'b'.repeat(48)], COLOURS)).bands, 1);
  // Shapes up to 21:9 are sent as they are.
  assert.deepEqual(planSheet(sprite(['.r.r.r.r.r.r..', '.b.b.b.b.b.b..', '.r.r.r.r.r.r..', '.b.b.b.b.b.b..', '.r.r.r.r.r.r..', '.b.b.b.b.b.b..'], COLOURS)), { key: '#00ffff', bands: 1, gutter: 0 });
});

test('the reference stacks the bands on the key colour, enlarged by whole steps, fully opaque', () => {
  const strip = sprite(['r..s' + 'b..k' + 'k..r', 'r..s' + 'b..k' + 'k..r'], COLOURS);
  const sheet = { key: '#00ff00', bands: 3, gutter: 2 };
  const reference = referenceOf(strip, sheet);
  const own = sheetSize(12, 2, sheet), step = Math.floor(REFERENCE_SIDE / Math.max(own.width, own.height));
  assert.deepEqual([reference.width, reference.height], [own.width * step, own.height * step]);
  const at = (x: number, y: number) => rgba(reference, x * step + 1, y * step + 1);
  assert.deepEqual(at(0, 0), [0xc0, 0x39, 0x2b, 255], 'band 1 starts at the top left');
  assert.deepEqual(at(1, 0), [0, 255, 0, 255], 'see-through became the key');
  assert.deepEqual(at(0, 2), [0, 255, 0, 255], 'the gutter is key');
  assert.deepEqual(at(0, 4), [0x5a, 0x3a, 0x29, 255], 'band 2 starts below the gutter');
  assert.deepEqual(at(3, 8), [0xc0, 0x39, 0x2b, 255], 'band 3 ends at the bottom right');
  for (let i = 3; i < reference.data.length; i += 4) assert.equal(reference.data[i], 255);
});

test('restoring brings bands back side by side, the key back to see-through, at the sprite\'s size and colours', () => {
  const strip = sprite(['.rr..ss..bb..kk.', '.rb..sk..bs..kr.', '.ss..bb..kk..rr.'], COLOURS);
  const sheet = { key: '#ff00ff', bands: 2, gutter: 2 };
  const palette = paletteOf(coloursOf(strip));
  const reference = referenceOf(strip, sheet);
  // h3 answers at about 16 MP with the reference's shape, never a whole multiple.
  const drawn = resized(reference, Math.round(reference.width * 2.37), Math.round(reference.height * 2.37));
  const pixel = restoreSprite(drawn, sheet, { width: 16, height: 3 }, 'pixel', palette);
  assert.deepEqual([...pixel.data], [...strip.data], 'pixel fitting gives the sprite back exactly');
  const smooth = restoreSprite(drawn, sheet, { width: 16, height: 3 }, 'smooth');
  assert.deepEqual([smooth.width, smooth.height], [16, 3]);
  assert.deepEqual(rgba(smooth, 0, 0), [0, 0, 0, 0]);
  assert.deepEqual(rgba(smooth, 1, 0), [0xc0, 0x39, 0x2b, 255]);
  const none = restoreSprite(drawn, sheet, { width: 16, height: 3 }, 'none');
  assert.deepEqual([none.width, none.height], [Math.round(16 * drawn.width / 8), Math.round(3 * drawn.height / 8)]);
  assert.equal(rgba(none, 0, 0)[3], 0);

  // Background a little off the key, and colours a little off the palette, still come back clean.
  const noisy = { ...drawn, data: drawn.data.map((value, i) => i % 4 === 3 ? value : Math.max(0, Math.min(255, value + ((i * 7919) % 31) - 15))) };
  assert.deepEqual([...restoreSprite(noisy, sheet, { width: 16, height: 3 }, 'pixel', palette).data], [...strip.data]);
});

test('palettes keep every colour when they fit in a GIF and are cut down by median cut otherwise; GIF indices mark see-through', () => {
  const few = new Map([[0x112233, 5], [0x445566, 9]]);
  assert.deepEqual(paletteOf(few), [0x445566, 0x112233]);
  const many = new Map<number, number>();
  for (let i = 0; i < 1000; i++) many.set((i * 2654435761) & 0xffffff, 1 + (i % 7));
  const cut = paletteOf(many);
  assert.equal(cut.length, GIF_COLOURS);
  const { indices, transparent } = indexPixels(sprite(['r.', '.b'], COLOURS), [0x5a3a29, 0xc0392b]);
  assert.deepEqual([...indices], [1, 2, 2, 0]);
  assert.equal(transparent, 2);
});

test('GIFs the page writes decode back to the same pixels, also past a full code table, and count as one frame', () => {
  for (const [width, height, colours] of [[1, 1, 1], [7, 3, 2], [33, 17, 16], [200, 150, 256]] as const) {
    const palette = Array.from({ length: colours }, (_, i) => (i * 0x010305) & 0xffffff);
    const indices = Uint8Array.from({ length: width * height }, (_, i) => ((i * 2654435761) >>> 7) % colours);
    const bytes = encodeGif(width, height, indices, palette, colours > 2 ? colours - 1 : undefined);
    const decoded = decodeGif(bytes);
    assert.deepEqual([decoded.width, decoded.height, decoded.transparent], [width, height, colours > 2 ? colours - 1 : undefined]);
    assert.deepEqual([...decoded.indices], [...indices], `${width}×${height}, ${colours} colours`);
    assert.deepEqual(decoded.palette.slice(0, colours), palette);
    assert.equal(gifFrames(bytes), 1);
  }
  // Long runs of one colour grow codes fastest.
  const flat = new Uint8Array(512 * 512).fill(3);
  assert.deepEqual([...decodeGif(encodeGif(512, 512, flat, [0, 1, 2, 3])).indices.subarray(0, 4)], [3, 3, 3, 3]);

  const one = encodeGif(2, 2, Uint8Array.from([0, 1, 1, 0]), [0, 0xffffff]);
  const image = one.subarray(one.indexOf(0x2c), one.length - 1);
  assert.equal(gifFrames(Uint8Array.from([...one.subarray(0, one.length - 1), ...image, 0x3b])), 2, 'two image blocks are an animation');
  assert.equal(gifFrames(Uint8Array.from([0x89, 0x50, 0x4e, 0x47])), 0);
});

test('the sheet hint names the key colour and, for several bands, keeps them apart; sheets are checked before use', () => {
  assert.match(sheetHint({ key: '#00ff00', bands: 1, gutter: 0 }), /^<Picture 1> is game sprite art on a flat #00ff00 background\..*solid #00ff00/);
  assert.match(sheetHint({ key: '#00ff00', bands: 4, gutter: 3 }), /The 4 rows are separate strips/);
  for (const bad of [null, {}, { key: '#00FF00', bands: 1, gutter: 0 }, { key: '#00ff00', bands: 13, gutter: 0 }, { key: '#00ff00', bands: 1, gutter: -1 }]) assert.equal(isSpriteSheet(bad), false, JSON.stringify(bad));
});
