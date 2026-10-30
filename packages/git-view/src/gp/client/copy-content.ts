/**
 * Eligibility of the file browser's "copy file content" button. The copy
 * applies to a loaded text preview — documents and code, including an SVG the
 * host served as source because it passed the image cap — and to a smaller SVG,
 * whose markup the host returns beside the picture. Binary, content-less
 * images, over-cap, and error states carry no copyable body, and the file must
 * stay strictly under the shared copy envelope, so oversized or non-text files
 * never reach the clipboard.
 */
import { FILE_COPY_MAX_BYTES } from './types.js'

/** Structural face of the Files-tab file state this guard reads. */
export interface CopyableFile {
  readonly kind: string
  readonly size?: number | undefined
  readonly content?: string | undefined
}

export function canCopyContent(file: CopyableFile): boolean {
  // An SVG is an image whose source text came along with the picture; past the
  // image cap it arrives as a text preview instead, which this branch covers.
  const copyable = file.kind === 'text' || (file.kind === 'image' && file.content !== undefined)
  if (!copyable) return false
  // The host stat size is authoritative; without it (older payload) fall
  // back to the loaded body's UTF-8 length so the envelope still holds.
  if (file.size !== undefined) return file.size < FILE_COPY_MAX_BYTES
  return new TextEncoder().encode(file.content ?? '').length < FILE_COPY_MAX_BYTES
}
