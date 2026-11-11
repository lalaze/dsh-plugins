import type { Client } from './index.js';

const ROUTE = '/api/remote-terminals/tui-activity', POLL_MS = 2000;

/** The part of DSH's `uiSession` service that adds to a session's pending interaction. */
interface UiSession { registerPendingInteraction(precedence: () => number): (interaction: { key: string; kind: string; sessionId: string }, delegate: () => void) => () => void }
interface SessionList { getSnapshot(): { byId?: Record<string, { running?: boolean }> } | undefined; subscribe(listener: () => void): () => void }

/**
 * Shows a TUI conversation waiting on the user in its CLI like one waiting on an approval in DSH. The server has no event of
 * its own to reach this page with, so this asks; a waiting CLI always counts as running, so it only asks while something runs.
 */
export function installTuiActivity(ctx: Client): void {
  ctx.inject?.(['uiSession', 'sessions'], (scoped) => {
    const get = scoped.get as unknown as (name: string) => unknown;
    const publish = (get('uiSession') as UiSession).registerPendingInteraction(() => 0);
    const list = (get('sessions') as { list?: SessionList }).list;
    if (!list) return;
    scoped.effect(() => {
      const shown = new Map<string, { kind: string; remove(): void }>();
      let timer: ReturnType<typeof setTimeout> | undefined, closed = false;
      const show = (waiting: Record<string, string>) => {
        for (const [sessionId, { kind, remove }] of shown) if (waiting[sessionId] !== kind) { remove(); shown.delete(sessionId); }
        for (const [sessionId, kind] of Object.entries(waiting)) {
          if (!shown.has(sessionId)) shown.set(sessionId, { kind, remove: publish({ key: `remote-agents-tui:${sessionId}`, kind, sessionId }, () => {}) });
        }
      };
      const anyRunning = () => Object.values(list.getSnapshot()?.byId ?? {}).some(session => session.running);
      const poll = async () => {
        timer = undefined;
        try {
          const response = await fetch(ROUTE, { credentials: 'same-origin', cache: 'no-store' });
          if (!closed && response.ok) show((await response.json() as { waiting: Record<string, string> }).waiting);
        } catch { /* it asks again */ }
        wake();
      };
      const wake = () => {
        if (closed || timer) return;
        if (anyRunning()) timer = setTimeout(() => void poll(), POLL_MS);
        else show({});
      };
      const off = list.subscribe(wake);
      wake();
      return () => { closed = true; off(); clearTimeout(timer); show({}); };
    });
  });
}
