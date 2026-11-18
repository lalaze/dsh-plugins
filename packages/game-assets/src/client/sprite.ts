/**
 * Sprites through h3, which reads and draws opaque pictures only. Before: see-through pixels become a flat key colour
 * that no figure uses, and a long strip is cut into bands stacked into a near-square sheet. After: the bands go back
 * side by side, the key colour becomes see-through again, and the picture is brought back to the sprite's own size
 * and colours. Pure functions on RGBA pixels, so they run the same in the page and in tests.
 */
import { SHEET_BANDS_LIMIT, type SpriteSheet } from '../domain.js';

export interface Pixels { width: number; height: number; data: Uint8ClampedArray }
export type SpriteFit = 'pixel' | 'smooth' | 'none';

/** Pixels at least this opaque count as part of a figure. */
const SOLID = 128;
/** How far from a pixel's centre `pixel` fitting reads, in pixels: four points from 0.35 to 0.65. */
const PIXEL_SPREAD = 0.1;
/** The longest side of the sheet sent to h3; pixel art is enlarged to about this by whole steps, so edges stay sharp. */
export const REFERENCE_SIDE = 2048;
/** Wider than this (the widest shape h3's own sizes have), a strip is cut into bands. */
const WIDEST = 21 / 9;
/** Saturated colours a key may be; the one farthest from every colour of the sprite is used. */
const KEYS = [0xff00ff, 0x00ff00, 0x00ffff, 0x0000ff, 0xffff00, 0xff0000];
/** A GIF keeps one of its 256 entries for see-through pixels. */
export const GIF_COLOURS = 255;

export const hexOf = (colour: number) => `#${colour.toString(16).padStart(6, '0')}`;
const colourOf = (hex: string) => parseInt(hex.slice(1), 16);
const rgbAt = (data: Uint8ClampedArray, at: number) => (data[at] << 16) | (data[at + 1] << 8) | data[at + 2];
function distance2(a: number, b: number): number {
  const r = ((a >> 16) & 0xff) - ((b >> 16) & 0xff), g = ((a >> 8) & 0xff) - ((b >> 8) & 0xff), bl = (a & 0xff) - (b & 0xff);
  return r * r + g * g + bl * bl;
}
const blank = (width: number, height: number): Pixels => ({ width, height, data: new Uint8ClampedArray(width * height * 4) });

/** Whether any pixel is less than fully opaque. */
export function seeThrough(pixels: Pixels): boolean {
  for (let i = 3; i < pixels.data.length; i += 4) if (pixels.data[i] < 250) return true;
  return false;
}

/** The colours of a sprite's solid pixels, with how many pixels have each. */
export function coloursOf(pixels: Pixels): Map<number, number> {
  const counts = new Map<number, number>();
  for (let i = 0; i < pixels.data.length; i += 4) {
    if (pixels.data[i + 3] < SOLID) continue;
    const colour = rgbAt(pixels.data, i);
    counts.set(colour, (counts.get(colour) ?? 0) + 1);
  }
  return counts;
}

/** The key colour farthest from every colour in `colours`. */
export function pickKey(colours: Iterable<number>): number {
  const list = [...colours];
  let best = KEYS[0], bestDistance = -1;
  for (const key of KEYS) {
    let nearest = Infinity;
    for (const colour of list) nearest = Math.min(nearest, distance2(key, colour));
    if (nearest > bestDistance) { best = key; bestDistance = nearest; }
  }
  return best;
}

const gutterFor = (height: number) => Math.max(2, Math.round(height / 8));
function columnClear(pixels: Pixels, x: number): boolean {
  for (let y = 0; y < pixels.height; y++) if (pixels.data[(y * pixels.width + x) * 4 + 3] >= SOLID) return false;
  return true;
}

/**
 * How to send a sprite: its key colour, and for a strip wider than h3's widest shape the number of equal bands whose
 * cuts cross only empty columns and give the squarest sheet.
 */
export function planSheet(pixels: Pixels, colours = coloursOf(pixels)): SpriteSheet {
  const key = hexOf(pickKey(colours.keys()));
  if (pixels.width / pixels.height <= WIDEST) return { key, bands: 1, gutter: 0 };
  let bands = 1, score = Math.abs(Math.log(pixels.width / pixels.height));
  const gutter = gutterFor(pixels.height);
  for (let k = 2; k <= SHEET_BANDS_LIMIT; k++) {
    if (pixels.width % k) continue;
    const width = pixels.width / k, height = k * pixels.height + (k - 1) * gutter;
    let clear = true;
    for (let i = 1; i < k && clear; i++) clear = columnClear(pixels, i * width - 1) && columnClear(pixels, i * width);
    const shape = Math.abs(Math.log(width / height));
    if (clear && shape < score) { bands = k; score = shape; }
  }
  return { key, bands, gutter: bands > 1 ? gutter : 0 };
}

/** The sheet's size in the sprite's own pixels. */
export function sheetSize(width: number, height: number, sheet: SpriteSheet) {
  return { width: width / sheet.bands, height: sheet.bands * height + (sheet.bands - 1) * sheet.gutter };
}

/** The opaque sheet h3 is given: bands stacked on the key colour, enlarged by whole steps towards REFERENCE_SIDE. */
export function referenceOf(pixels: Pixels, sheet: SpriteSheet): Pixels {
  const size = sheetSize(pixels.width, pixels.height, sheet), step = Math.max(1, Math.floor(REFERENCE_SIDE / Math.max(size.width, size.height)));
  const out = blank(size.width * step, size.height * step), key = colourOf(sheet.key);
  for (let y = 0; y < out.height; y++) {
    const sy = Math.floor(y / step), band = Math.floor(sy / (pixels.height + sheet.gutter)), row = sy - band * (pixels.height + sheet.gutter);
    for (let x = 0; x < out.width; x++) {
      const to = (y * out.width + x) * 4;
      let colour = key;
      if (row < pixels.height) {
        const from = (row * pixels.width + band * size.width + Math.floor(x / step)) * 4;
        if (pixels.data[from + 3] >= SOLID) colour = rgbAt(pixels.data, from);
      }
      out.data[to] = colour >> 16; out.data[to + 1] = (colour >> 8) & 0xff; out.data[to + 2] = colour & 0xff; out.data[to + 3] = 255;
    }
  }
  return out;
}

/** Up to `limit` colours standing for `colours`: all of them when they fit, else by median cut, weighted by use. */
export function paletteOf(colours: Map<number, number>, limit = GIF_COLOURS): number[] {
  if (colours.size <= limit) return [...colours.entries()].sort((a, b) => b[1] - a[1]).map(([colour]) => colour);
  type Box = Array<[number, number]>;
  const channel = (colour: number, c: number) => (colour >> (16 - 8 * c)) & 0xff;
  const boxes: Box[] = [[...colours.entries()]];
  while (boxes.length < limit) {
    let pick = -1, widest = 0, along = 0;
    boxes.forEach((box, index) => {
      if (box.length < 2) return;
      for (let c = 0; c < 3; c++) {
        let low = 255, high = 0;
        for (const [colour] of box) { const v = channel(colour, c); if (v < low) low = v; if (v > high) high = v; }
        if (high - low > widest) { widest = high - low; pick = index; along = c; }
      }
    });
    if (pick < 0) break;
    const box = boxes[pick].sort((a, b) => channel(a[0], along) - channel(b[0], along));
    const total = box.reduce((sum, [, count]) => sum + count, 0);
    let split = 1;
    for (let seen = 0; split < box.length - 1; split++) { seen += box[split - 1][1]; if (seen * 2 >= total) break; }
    boxes.splice(pick, 1, box.slice(0, split), box.slice(split));
  }
  return boxes.map(box => {
    let r = 0, g = 0, b = 0, n = 0;
    for (const [colour, count] of box) { r += ((colour >> 16) & 0xff) * count; g += ((colour >> 8) & 0xff) * count; b += (colour & 0xff) * count; n += count; }
    return (Math.round(r / n) << 16) | (Math.round(g / n) << 8) | Math.round(b / n);
  });
}

/** The index of the palette colour nearest a colour, remembered per 15-bit colour. */
export function nearestIn(palette: readonly number[]): (colour: number) => number {
  const cache = new Int16Array(1 << 15).fill(-1);
  return colour => {
    const slot = ((colour >> 9) & 0x7c00) | ((colour >> 6) & 0x3e0) | ((colour >> 3) & 0x1f);
    if (cache[slot] >= 0) return cache[slot];
    let best = 0, bestDistance = Infinity;
    for (let i = 0; i < palette.length; i++) {
      const d = distance2(colour, palette[i]);
      if (d < bestDistance) { best = i; bestDistance = d; }
    }
    cache[slot] = best;
    return best;
  };
}

/**
 * The sprite again from the sheet h3 drew: bands back side by side, the key colour see-through. `pixel` and `smooth`
 * bring it to the sprite's own size, `pixel` from points near each pixel's centre, `smooth` across it; `none` keeps
 * h3's scale. With a `palette` every solid pixel takes its nearest colour; with a palette or `pixel`, every pixel is
 * fully opaque or see-through, as a GIF and pixel art need.
 */
export function restoreSprite(drawn: Pixels, sheet: SpriteSheet, size: { width: number; height: number }, fit: SpriteFit, palette?: readonly number[]): Pixels {
  const bandWidth = size.width / sheet.bands, own = sheetSize(size.width, size.height, sheet);
  const fx = drawn.width / own.width, fy = drawn.height / own.height, key = colourOf(sheet.key);
  // Colours this close to the key are background; half the way to the sprite's nearest colour, within sensible bounds.
  let nearestToKey = 255 * 255 * 3;
  for (const colour of palette ?? []) nearestToKey = Math.min(nearestToKey, distance2(colour, key));
  const tolerance = Math.min(120, Math.max(40, Math.sqrt(nearestToKey) / 2)) ** 2;
  const nearest = palette && nearestIn(palette);
  /** The drawn colour at a point of the sprite in its own pixels, or -1 for background. */
  const sample = (ox: number, oy: number) => {
    const band = Math.min(sheet.bands - 1, Math.floor(ox / bandWidth));
    const sx = Math.min(drawn.width - 1, Math.max(0, Math.floor((ox - band * bandWidth) * fx)));
    const sy = Math.min(drawn.height - 1, Math.max(0, Math.floor((oy + band * (size.height + sheet.gutter)) * fy)));
    const colour = rgbAt(drawn.data, (sy * drawn.width + sx) * 4);
    return distance2(colour, key) < tolerance ? -1 : colour;
  };
  const width = fit === 'none' ? Math.max(1, Math.round(size.width * fx)) : size.width;
  const height = fit === 'none' ? Math.max(1, Math.round(size.height * fy)) : size.height;
  const out = blank(width, height);
  const put = (x: number, y: number, colour: number, alpha: number) => {
    const at = (y * width + x) * 4;
    out.data[at] = colour >> 16; out.data[at + 1] = (colour >> 8) & 0xff; out.data[at + 2] = colour & 0xff; out.data[at + 3] = alpha;
  };
  // Pixel art reads a few points near each pixel's centre, away from the edges where h3's picture blends into the
  // next pixel, and averages them against noise before taking the nearest palette colour; smoothing spreads evenly.
  const per = fit === 'pixel' ? 4 : fit === 'smooth' ? Math.min(6, Math.max(1, Math.round(Math.min(fx, fy)))) : 1;
  const spot = fit === 'pixel' ? (i: number) => 0.5 + (i - 1.5) * PIXEL_SPREAD : (i: number) => (i + 0.5) / per;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (fit === 'none') {
        const colour = sample((x + 0.5) / fx, (y + 0.5) / fy);
        if (colour >= 0) put(x, y, nearest ? palette![nearest(colour)] : colour, 255);
        continue;
      }
      let background = 0, r = 0, g = 0, b = 0;
      for (let j = 0; j < per; j++) {
        for (let i = 0; i < per; i++) {
          const colour = sample(x + spot(i), y + spot(j));
          if (colour < 0) { background++; continue; }
          r += (colour >> 16) & 0xff; g += (colour >> 8) & 0xff; b += colour & 0xff;
        }
      }
      const total = per * per, solid = total - background;
      if (!solid || ((palette || fit === 'pixel') && background * 2 > total)) continue;
      const mean = (Math.round(r / solid) << 16) | (Math.round(g / solid) << 8) | Math.round(b / solid);
      if (nearest) put(x, y, palette![nearest(mean)], 255);
      else put(x, y, mean, fit === 'pixel' ? 255 : Math.round((255 * solid) / total));
    }
  }
  return out;
}

/** Palette indices for a GIF: see-through pixels get the entry after the palette. */
export function indexPixels(pixels: Pixels, palette: readonly number[]): { indices: Uint8Array; transparent: number } {
  const nearest = nearestIn(palette), transparent = palette.length, indices = new Uint8Array(pixels.width * pixels.height);
  for (let i = 0; i < indices.length; i++) {
    indices[i] = pixels.data[i * 4 + 3] < SOLID ? transparent : nearest(rgbAt(pixels.data, i * 4));
  }
  return { indices, transparent };
}
