import type { OfferedWorkspace } from '../remote-workspaces.js';
import { api } from './api.js';

/** DSH's workspace controller, as far as adding shared workspaces needs it. */
export interface WorkspaceList {
  workspaces: {
    list: { getSnapshot(): { items: readonly { path: string }[] } | undefined; subscribe(listener: () => void): () => void };
    create(input: { path: string }): Promise<unknown>;
  };
}
const INTERVAL = 60_000;

/**
 * Remote workspaces added in other DSH instances connected to the same machines appear in this
 * sidebar once. One removed here is not added again. Remote workspaces added here are shared first,
 * including ones added before sharing existed.
 */
export function installWorkspaceImport(ctx: WorkspaceList): () => void {
  let stopped = false, running = false;
  const paths = () => (ctx.workspaces.list.getSnapshot()?.items ?? []).map(item => item.path);
  const run = async () => {
    if (running || stopped || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) return;
    running = true;
    try {
      await api('publishWorkspaces', { paths: paths().slice(0, 500) });
      const offered = await api<OfferedWorkspace[]>('sharedWorkspaces');
      const seen = new Map<string, string[]>();
      for (const workspace of offered) {
        if (stopped) return;
        if (!paths().includes(workspace.path)) {
          // A failed addition is offered again on a later round.
          try { await ctx.workspaces.create({ path: workspace.path }); } catch { continue; }
        }
        seen.set(workspace.hostId, [...seen.get(workspace.hostId) ?? [], workspace.remotePath]);
      }
      for (const [hostId, remotePaths] of seen) await api('seeWorkspaces', { hostId, paths: remotePaths });
    } catch { /* Hosts may be offline; the next round retries. */ }
    finally { running = false; }
  };
  const timer = setInterval(() => void run(), INTERVAL);
  const first = setTimeout(() => void run(), 2000);
  const changed = () => void run();
  if (typeof window !== 'undefined') { window.addEventListener('remote-agents-updated', changed); window.addEventListener('focus', changed); }
  return () => {
    stopped = true; clearInterval(timer); clearTimeout(first);
    if (typeof window !== 'undefined') { window.removeEventListener('remote-agents-updated', changed); window.removeEventListener('focus', changed); }
  };
}
