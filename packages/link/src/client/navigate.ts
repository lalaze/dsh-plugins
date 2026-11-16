import { mountPrefix, rawStorage, selectSession } from '../rewrite.js';
import { onScreen, SELF } from './store.js';

/** Show a machine's page, optionally on one Session (its page restores it at boot). */
export function openMachine(machine: string, sessionId?: string): void {
  if (sessionId) {
    try { selectSession(rawStorage(), machine === SELF ? '' : machine, sessionId); } catch { /* storage refused: open it where it was */ }
  }
  if (machine === onScreen()) { if (sessionId) location.reload(); return; }
  location.assign(machine === SELF ? '/' : `${mountPrefix(machine)}/`);
}
