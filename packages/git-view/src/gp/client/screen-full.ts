/**
 * Full-screen request failure classification: the browser-fullscreen toggle
 * must always leave a visible reason instead of a dead control, so every way
 * a request can fail maps to the notice key that names it.
 */
import type { GitKey } from './locales.js'

/**
 * How long an unanswered `requestFullscreen()` is tolerated before it is
 * reported. The promise resolves once the fullscreen element is set (before
 * the visual transition finishes), and a granted request also flips
 * `fullscreenElement`, so a host that neither settles the promise nor enters
 * full screen is stuck, not slow.
 */
export const SCREEN_TIMEOUT_MS = 1200

/**
 * Map a `requestFullscreen()` rejection to the notice key stating its reason.
 * Chrome reports a Permissions-Policy / missing-iframe-permission lockout as
 * a `TypeError`; every other rejection (a denied user gesture surfaces as
 * `NotAllowedError`, hosts vary further) falls back to the generic refusal.
 */
export function screenFailKeyOf(error: unknown): GitKey {
  if (error instanceof TypeError) return 'files.screenFullBlocked'
  return 'files.screenFullRefused'
}
