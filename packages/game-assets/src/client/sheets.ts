/**
 * The page's side of sending sprites through h3 (see sprite.ts): reading a GIF or see-through image of the workspace,
 * making the opaque sheet h3 is given, and turning what h3 drew back into a file of the sprite's own type.
 */
import { extensionOf, type SpriteSheet } from '../domain.js';
import { imageBytes } from './api.js';
import { encodeGif, gifFrames } from './gif.js';
import { base64Of, canEditPixels, encodePixels, mimeOfPath, pixelsOf } from './picture.js';
import { GIF_COLOURS, coloursOf, indexPixels, paletteOf, planSheet, referenceOf, restoreSprite, seeThrough, type Pixels, type SpriteFit } from './sprite.js';

export interface Original {
  pixels: Pixels;
  /** The colours a redraw is brought back to; `exact` when they are all of the sprite's colours. */
  palette: number[];
  exact: boolean;
}
export interface Prepared { data: string; sheet: SpriteSheet }

const GIF = 'image/gif';
/** The file type a sprite is saved as, from its path. */
export const spriteType = (path: string): string | undefined => extensionOf(path) === 'gif' ? GIF : mimeOfPath(path);

/** Originals read during this page's life, by session and path, so a preview and a save read each once. */
const originals = new Map<string, Promise<Original>>();
export function resetSheets(): void {
  originals.clear();
}

function read(sessionId: string, path: string, bytes?: Uint8Array<ArrayBuffer>): Promise<Original> {
  const key = `${sessionId}\n${path}`;
  let known = originals.get(key);
  if (!known) {
    known = (async () => {
      const data = bytes ?? new Uint8Array(await imageBytes(sessionId, path));
      const pixels = await pixelsOf(new Blob([data], { type: spriteType(path) ?? 'application/octet-stream' }));
      const colours = coloursOf(pixels);
      return { pixels, palette: paletteOf(colours), exact: colours.size <= GIF_COLOURS };
    })();
    known.catch(() => originals.delete(key));
    originals.set(key, known);
  }
  return known;
}
export const readOriginal = (sessionId: string, path: string) => read(sessionId, path);

/**
 * The sheets to send for `paths`: every GIF, and PNG or WebP images with see-through pixels; other images go as they
 * are. Animated GIFs are listed in `animated` and get no sheet. Without pixel access in this browser, a GIF cannot go.
 */
export async function prepareSheets(sessionId: string, paths: readonly string[]): Promise<{ prepared: Record<string, Prepared>; animated: string[] }> {
  const prepared: Record<string, Prepared> = {}, animated: string[] = [];
  const editable = canEditPixels();
  for (const path of paths) {
    const extension = extensionOf(path), gif = extension === 'gif';
    if (!gif && (!editable || extension === 'jpg' || extension === 'jpeg')) continue;
    if (gif && !editable) throw new Error('This browser cannot prepare GIF images for h3');
    const bytes = new Uint8Array(await imageBytes(sessionId, path));
    if (gif && gifFrames(bytes) > 1) { animated.push(path); continue; }
    const original = await read(sessionId, path, bytes);
    if (!gif && !seeThrough(original.pixels)) continue;
    const sheet = planSheet(original.pixels);
    prepared[path] = { data: await base64Of(await encodePixels(referenceOf(original.pixels, sheet))), sheet };
  }
  return { prepared, animated };
}

/** `auto` for a sprite: sharp pixels when the sprite has few enough colours for a GIF, smooth otherwise. */
export const spriteFit = (choice: 'auto' | SpriteFit, original: Original, path: string): SpriteFit =>
  choice !== 'auto' ? choice : extensionOf(path) === 'gif' || original.exact ? 'pixel' : 'smooth';

/**
 * What h3 drew for a sprite, back as a `type` file: see-through background, own size as `fit` says, and with
 * `keepColours` the original's colours (always for sharp pixels and GIF); without, a GIF gets a palette of the new picture.
 */
export async function restoredPicture(drawn: Blob, sheet: SpriteSheet, original: Original, fit: SpriteFit, type: string, keepColours = true): Promise<Blob> {
  const gif = type === GIF, size = { width: original.pixels.width, height: original.pixels.height };
  const restored = restoreSprite(await pixelsOf(drawn), sheet, size, fit, keepColours && (gif || fit === 'pixel') ? original.palette : undefined);
  if (!gif) return encodePixels(restored, type);
  const colours = keepColours ? original.palette : paletteOf(coloursOf(restored));
  const { indices, transparent } = indexPixels(restored, colours);
  return new Blob([encodeGif(restored.width, restored.height, indices, [...colours, parseInt(sheet.key.slice(1), 16)], transparent)], { type: GIF });
}
