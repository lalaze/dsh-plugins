/**
 * Visible text for a path line that elides from the left (a `direction:rtl`
 * span with `text-overflow:ellipsis`).
 *
 * A leading '/' is a neutral character: alone at the start of an rtl run it
 * reorders to the end. An invisible LRM (U+200E) anchors it in place — the
 * slash itself then sits inside the elided head, so the ellipsis eats it too
 * and no `/…` prefix is left behind. Paths without a leading '/' pass through
 * unchanged.
 */
export function rtlPathText(path: string): string {
  return path.startsWith('/') ? '\u200e' + path : path
}
