/**
 * Local-image resolution for rendered Markdown — the client half of the
 * official contract: `MarkdownText`'s `pathImages.resolve` maps an authored
 * image destination onto the platform's authenticated file route
 * (`api/file?path=…`, cookie-authenticated by the connection service), so a
 * README's relative figures load instead of falling back to alt text.
 *
 * The parsing mirrors the official document preview's `markdownImageUrl`
 * one-for-one (decode once, reject schemes, join beside the document,
 * absolute-only on the wire): diverging here would resolve a path the host
 * route then refuses, or silently point at the wrong file.
 */

/** Resolver handed to `MarkdownText`; see {@link markdownImageUrl}. */
export interface PathImages {
  readonly resolve: (destination: string) => string | undefined
}

/** A path is absolute in either spelling the host accepts: POSIX `/a/b` or Windows drive / UNC. */
function isAbsoluteWorkspacePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[/\\]/.test(path) || path.startsWith('\\\\')
}

/**
 * Directory prefix including its trailing separator; both `/` and `\`
 * separate, so a Windows path splits where its own segments end.
 */
function pathDirectoryOf(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, '')
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1
  return trimmed.slice(0, cut)
}

/**
 * Address a decoded absolute file path through the authenticated file route.
 * @param base Page base URL (`http(s)://…` or the desktop `dsh-app://app/`).
 * @param path Native absolute file path; URL escapes must already be decoded.
 * @returns The route URL, or undefined for unsupported transports and non-absolute paths.
 */
function fileMediaUrl(base: string, path: string): string | undefined {
  if (!/^https?:/.test(base) && !base.startsWith('dsh-app://app/')) return undefined
  if (!isAbsoluteWorkspacePath(path)) return undefined
  if (/^[/\\]{2}/.test(path)) return undefined
  if (/[\x00-\x1f\x7f]/.test(path)) return undefined
  return new URL(`api/file?path=${encodeURIComponent(path)}`, base).href
}

/**
 * Build a file URL for one authored Markdown image destination, resolving
 * relative destinations beside the previewed document.
 * @param base Document base URI (the page's, including any deployment prefix).
 * @param documentPath Absolute path of the previewed file, when the host reported it.
 * @param destination Authored destination; query and fragment are not filename components.
 * @returns The file-route URL, or undefined for schemes, malformed input, or no document path.
 */
export function markdownImageUrl(base: string, documentPath: string | undefined, destination: string): string | undefined {
  const suffix = destination.search(/[?#]/)
  let path: string
  try {
    path = decodeURIComponent(suffix === -1 ? destination : destination.slice(0, suffix))
  } catch {
    return undefined
  }
  if (path.length === 0) return undefined
  // Scheme-qualified (http, data, mailto, ...) is never a local file — the
  // renderer passes external destinations through on its own.
  if (!/^[a-z]:[/\\]/i.test(path) && /^[a-z][a-z\d+.-]*:/i.test(path)) return undefined
  if (!isAbsoluteWorkspacePath(path)) {
    if (documentPath === undefined) return undefined
    path = pathDirectoryOf(documentPath) + path
  }
  return fileMediaUrl(base, path)
}

/** The memo-stable resolver object for one previewed document. */
export function createPathImages(base: string, documentPath: string): PathImages {
  return { resolve: (destination) => markdownImageUrl(base, documentPath, destination) }
}
