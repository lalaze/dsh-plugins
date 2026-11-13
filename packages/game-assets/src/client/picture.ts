/** Fitting a generated picture to the image it stands in for, in the browser, before it is saved. */
import { extensionOf, type Aspect } from '../domain.js';

/** `smooth` and `pixel` scale to the original's pixel size, with or without blending; `none` keeps the API's size. */
export type FitMode = 'smooth' | 'pixel' | 'none';
export const MIME_OF: Record<string, string> = { png: 'image/png', webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg' };
export const mimeOfPath = (path: string): string | undefined => MIME_OF[extensionOf(path)];

/** The API shape nearest an image's own. */
export function aspectOf(width?: number, height?: number): Aspect {
  if (!width || !height) return 'square';
  return width / height > 1.2 ? 'wide' : height / width > 1.2 ? 'tall' : 'square';
}
/** Small images are usually pixel art, whose edges blending would blur. */
export const defaultFit = (width?: number, height?: number): FitMode => !width || !height ? 'none' : Math.max(width, height) <= 128 ? 'pixel' : 'smooth';

/**
 * Where a picture of `width` × `height` lies, centred in a box of `boxWidth` × `boxHeight`: whole inside it, or with
 * `cover`, filling it with the overflow cut off.
 */
export function placeRect(width: number, height: number, boxWidth: number, boxHeight: number, cover = false) {
  const scale = (cover ? Math.max : Math.min)(boxWidth / width, boxHeight / height);
  const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
  return { x: Math.floor((boxWidth - w) / 2), y: Math.floor((boxHeight - h) / 2), width: w, height: h };
}

/**
 * Whether the picture at `url` has see-through pixels, read from a small copy of it; undefined when the browser cannot
 * tell. Redrawing a background on a transparent one would waste the generation.
 */
export async function hasTransparency(url: string): Promise<boolean | undefined> {
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const scale = Math.min(1, 128 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return undefined;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 3; i < pixels.length; i += 4) if (pixels[i] < 250) return true;
    return false;
  } catch { return undefined; }
}

/** The bytes of a base64 string as a typed blob. */
export function blobOf(base64: string, type: string): Blob {
  const text = atob(base64), bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return new Blob([bytes], { type });
}
export async function base64Of(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

/**
 * The picture as it will be saved: drawn at `size` (or its own size) and encoded as `type`. A picture that needs
 * neither is passed on as the API made it. A sprite is fitted whole, on transparency; an opaque picture, such as a
 * background, is cropped to fill the size with `cover`. JPEG has no transparency, so a JPEG is drawn on white.
 */
export async function renderPicture(picture: Blob, type: string, fit: FitMode, size?: { width: number; height: number }, cover = false): Promise<Blob> {
  if ((fit === 'none' || !size) && picture.type === type) return picture;
  const bitmap = await createImageBitmap(picture);
  try {
    const width = fit !== 'none' && size ? size.width : bitmap.width, height = fit !== 'none' && size ? size.height : bitmap.height;
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('This browser cannot resize pictures');
    context.imageSmoothingEnabled = fit !== 'pixel';
    context.imageSmoothingQuality = 'high';
    if (type === 'image/jpeg') { context.fillStyle = '#fff'; context.fillRect(0, 0, width, height); }
    const rect = placeRect(bitmap.width, bitmap.height, width, height, cover);
    context.drawImage(bitmap, rect.x, rect.y, rect.width, rect.height);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, type, 0.92));
    // A browser that cannot write the format falls back to PNG, which the file name would then misstate.
    if (!blob || blob.type !== type) throw new Error(type === 'image/webp' ? 'This browser cannot save WebP pictures; save it as .png' : 'The picture could not be encoded');
    return blob;
  } finally { bitmap.close(); }
}
