/**
 * Whether the GUI is being viewed on the machine that hosts the project.
 *
 * Opening a previewed file in the OS default application only makes sense when
 * the file is on the reader's own disk. The one fact the client can check is
 * the page it was served from: a loopback host means the DSH server and the
 * browser are on the same machine, so the browse root's paths are the reader's
 * paths too.
 *
 * The check is deliberately conservative — an SSH-forwarded remote instance
 * also looks like loopback, so a failed open is surfaced to the user rather
 * than assumed impossible.
 */

/** Loopback spellings a browser can report as `location.hostname`. */
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase()
  // IPv6 literals come in brackets when read from `location.host`.
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  if (bare === 'localhost' || bare === '::1') return true
  // The whole 127.0.0.0/8 block is loopback.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare)
}

/**
 * Whether the panel may offer "open in the system browser" for a local file.
 *
 * @param hostname `location.hostname` of the running GUI.
 * @param supported Whether the host reported an OS opener (absent = unknown).
 */
export function canOpenLocally(hostname: string, supported = true): boolean {
  return supported && isLoopbackHostname(hostname)
}
