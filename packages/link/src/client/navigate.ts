import { mountPrefix, rawStorage, selectSession } from '../rewrite.js';
import { keepPages, ownShell, parentShell } from './shell.js';
import { onScreen, SELF } from './store.js';

/**
 * Show a machine's page, optionally on one Session. With pages kept, the window's shell shows it in place (a page in
 * one of its frames always goes through it); otherwise the window loads that machine's page, which restores the
 * Session at boot.
 */
export function openMachine(machine: string, sessionId?: string): void {
  const shell = parentShell() ?? (keepPages() ? ownShell() : undefined);
  if (shell) { shell.show(machine, sessionId); return; }
  if (sessionId) {
    try { selectSession(rawStorage(), machine === SELF ? '' : machine, sessionId); } catch { /* storage refused: open it where it was */ }
  }
  if (machine === onScreen()) { if (sessionId) location.reload(); return; }
  location.assign(machine === SELF ? '/' : `${mountPrefix(machine)}/`);
}
