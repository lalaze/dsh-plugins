import { api } from './api.js';
import type { Client } from './index.js';
import { preferTerminalShell } from './terminal-preference.js';

interface SessionList { getSnapshot(): { byId?: Record<string, { cwd?: string; retainedBy?: Record<string, number> }> } | undefined; subscribe(listener: () => void): () => void }
/** A remote workspace's folder on this computer, which only stands for the remote directory. */
const REMOTE_ANCHOR = /(?:^|[/\\])remote-workspaces[/\\]/;

/**
 * New terminal opens the Remote workspace launcher while every conversation in view is in a verified remote workspace,
 * and the user's own shell elsewhere. The server says which conversations are, and where the launcher is.
 */
export function installTerminalPreference(ctx: Client): void {
  ctx.inject?.(['sessions'], scoped => {
    const sessions = ((scoped.get as unknown as (name: string) => unknown)('sessions') as { list?: SessionList } | undefined)?.list;
    if (!sessions) return;
    scoped.effect(() => {
      const known = new Map<string, { cwd: string; shell?: string }>(), controllers = new Set<AbortController>();
      let disposed = false, applied: string | undefined | null = null;
      const inView = () => Object.entries(sessions.getSnapshot()?.byId ?? {}).filter(([, session]) => (session.retainedBy?.mainView ?? 0) > 0);
      const apply = () => {
        if (disposed) return;
        const view = inView(), shell = view.length > 0 && view.every(([id]) => known.get(id)?.shell) ? known.get(view[0][0])!.shell : undefined;
        if (shell === applied) return;
        applied = shell; preferTerminalShell(shell);
      };
      const ask = (id: string, entry: { cwd: string; shell?: string }) => {
        const controller = new AbortController(); controllers.add(controller);
        void api<{ shell?: string }>('terminalShell', { sessionId: id }, controller.signal)
          .then(answer => { if (known.get(id) === entry) entry.shell = answer.shell; }, () => { if (known.get(id) === entry) delete entry.shell; })
          .finally(() => { controllers.delete(controller); apply(); });
      };
      const warm = () => {
        const byId = sessions.getSnapshot()?.byId ?? {};
        for (const [id, entry] of known) if (byId[id]?.cwd !== entry.cwd) known.delete(id);
        for (const [id, session] of inView()) {
          if (!session.cwd || known.has(id) || !REMOTE_ANCHOR.test(session.cwd)) continue;
          const entry = { cwd: session.cwd }; known.set(id, entry); ask(id, entry);
        }
        apply();
      };
      // A machine added or removed in Remote Agents changes which workspaces are verified.
      const changed = () => { for (const [id, entry] of known) ask(id, entry); };
      const off = sessions.subscribe(warm); window.addEventListener('remote-agents-updated', changed);
      warm();
      return () => { disposed = true; off(); window.removeEventListener('remote-agents-updated', changed); for (const controller of controllers) controller.abort(); preferTerminalShell(undefined); };
    });
  });
}
