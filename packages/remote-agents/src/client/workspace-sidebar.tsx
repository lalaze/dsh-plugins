import React from 'react';
import { api } from './api.js';
import { ui } from './i18n.js';
import { styles } from './styles.js';
import { WorkspacePanel } from './workspace.js';
import type { Client } from './index.js';
import type { WorkspaceTarget } from '../workspace-domain.js';

export function workspaceFileAddress(address: string): { sessionId: string; path: string } | undefined {
  try {
    const url = new URL(address), [scope, id, ...parts] = url.pathname.replace(/^\//, '').split('/');
    if (url.protocol !== 'dsh-resource:' || url.hostname !== 'file' || scope !== 'session' || !id || !parts.length) return;
    return { sessionId: decodeURIComponent(id), path: decodeURIComponent(parts.join('/')) };
  } catch { return; }
}
type TabDefinition = Record<string, unknown> & { id: string; kind: string; guide?: readonly Record<string, unknown>[] };
type Entry = { cwd: string; target?: WorkspaceTarget; check: number };
/** DSH's own Workspace files type: its kind, which ⌘P opens, and its guide entry's id. */
const FILES_KIND = 'files', FILES_GUIDE = 'workspace';
const REMOTE_ANCHOR = /(?:^|[/\\])remote-workspaces[/\\]/;
/**
 * Uses the native right-sidebar extension contract; local sessions keep their original viewers.
 * While the conversation in view is a verified remote workspace, this plugin takes over DSH's Workspace files
 * type (its guide entry and ⌘P open the remote files) and offers Remote workspace in the guide. Elsewhere it
 * unregisters both, and DSH's own Workspace files resumes.
 */
export function installWorkspaceSidebar(ctx: Client): void {
  ctx.inject?.(['sidebarRightTabs', 'sessions'], scoped => {
    const get = scoped.get as ((name: string) => unknown) | undefined;
    const tabs = get?.('sidebarRightTabs') as { register(spec: TabDefinition): () => void; get?(kind: string): TabDefinition | undefined } | undefined;
    const sessions = get?.('sessions') as { list: { getSnapshot(): { byId?: Record<string, { cwd?: string; retainedBy?: Record<string, number> }> }; subscribe(listener: () => void): () => void } } | undefined;
    if (!tabs || typeof tabs.register !== 'function' || !sessions?.list) return;
    scoped.effect(() => {
      const cache = new Map<string, Entry>(), controllers = new Set<AbortController>();
      const explorer = 'remote-agents/workspace', file = 'remote-agents/file', files = 'remote-agents/files';
      let disposed = false, scheduled = false, shown: boolean | undefined;
      const live: { explorer?: () => void; files?: () => void } = {};
      const verify = (id: string, entry: Entry) => {
        const c = new AbortController(), check = ++entry.check; controllers.add(c);
        const settle = (target?: WorkspaceTarget) => { if (!disposed && cache.get(id) === entry && entry.check === check) entry.target = target; };
        void api<WorkspaceTarget>('workspaceTarget', { sessionId: id }, c.signal).then(settle, () => settle())
          .finally(() => { controllers.delete(c); schedule(); });
      };
      const warm = () => {
        const byId = sessions.list.getSnapshot()?.byId ?? {};
        for (const [id, entry] of cache) if (byId[id]?.cwd !== entry.cwd) cache.delete(id);
        for (const [id, session] of Object.entries(byId)) {
          if (!session.cwd || cache.has(id) || !(session.retainedBy?.mainView) || !REMOTE_ANCHOR.test(session.cwd)) continue;
          const entry: Entry = { cwd: session.cwd, check: 0 }; cache.set(id, entry); verify(id, entry);
        }
        schedule();
      };
      // Re-verify in place, so an open Workspace files tab does not fall back to the local view meanwhile.
      const changed = () => { for (const [id, entry] of cache) verify(id, entry); };
      /** Every conversation in view is a verified remote workspace, so none of them gets the remote files by mistake. */
      const remoteInView = () => {
        const inView = Object.entries(sessions.list.getSnapshot()?.byId ?? {}).filter(([, session]) => (session.retainedBy?.mainView ?? 0) > 0);
        return inView.length > 0 && inView.every(([id]) => !!cache.get(id)?.target);
      };
      const explorerType = (guide: boolean): TabDefinition => ({
        id: explorer, kind: explorer, title: () => ui('Remote workspace'),
        ...guide ? { guide: [{ id: 'remote-workspace', order: 55, title: () => ui('Remote workspace'), description: () => ui('Commands, sync, tunnels and remote DSH') }] } : {},
      });
      // Keep the native entry's title, icon, position and shortcut, so Workspace files looks the same in a remote conversation.
      const filesType = (): TabDefinition => {
        const native = tabs.get?.(FILES_KIND), entry = native?.guide?.find(item => item.id === FILES_GUIDE);
        return {
          id: files, kind: FILES_KIND, priority: 'extension', title: native?.title ?? (() => ui('Workspace files')),
          guide: [{ ...entry ?? { id: FILES_GUIDE, order: 10, title: () => ui('Workspace files') }, description: () => ui('Browse files in the remote workspace') }],
        };
      };
      const update = () => {
        scheduled = false;
        if (disposed) return;
        const remote = remoteInView();
        if (remote === shown) return;
        shown = remote;
        live.files?.(); live.files = undefined;
        live.explorer?.(); live.explorer = tabs.register(explorerType(remote));
        if (remote) try { live.files = tabs.register(filesType()); } catch (error) { console.warn('Remote workspace files view unavailable', error); }
      };
      const schedule = () => { if (!scheduled && !disposed) { scheduled = true; queueMicrotask(update); } };
      const off = sessions.list.subscribe(warm); window.addEventListener('remote-agents-updated', changed);
      let offFile: (() => void) | undefined;
      try {
        update();
        offFile = tabs.register({ id: file, kind: file, patterns: ['dsh-resource://file/**'],
          canOpen: (address: string) => { const parsed = workspaceFileAddress(address); return !!parsed && !!cache.get(parsed.sessionId)?.target; },
          title: (address: string) => workspaceFileAddress(address)?.path.split('/').pop() || ui('Remote file'),
        });
        scoped.slots.inject('sidebar.right.pane.tab', () => {
          type Props = { sessionId: string; useTabInfo(): { tab: { navigation: { address: string } } } };
          const useCwd = (id: string) => React.useSyncExternalStore(listener => sessions.list.subscribe(listener), () => sessions.list.getSnapshot()?.byId?.[id]?.cwd);
          const Explorer: React.FC<Props> = ({ sessionId }) => { const cwd = useCwd(sessionId); return <><style>{styles}</style><WorkspacePanel key={JSON.stringify([sessionId, cwd])} sessionId={sessionId} /></>; };
          const Files: React.FC<Props> = ({ sessionId }) => { const cwd = useCwd(sessionId); return <><style>{styles}</style><WorkspacePanel key={JSON.stringify([sessionId, cwd])} sessionId={sessionId} tools={['files']} /></>; };
          const File: React.FC<Props> = props => {
            const parsed = workspaceFileAddress(props.useTabInfo().tab.navigation.address);
            const id = parsed?.sessionId ?? props.sessionId, cwd = useCwd(id);
            return <><style>{styles}</style><WorkspacePanel key={JSON.stringify([parsed, cwd])} sessionId={id} initialPath={parsed?.path} /></>;
          };
          const disposers = [[explorer, Explorer], [files, Files], [file, File]].map(([key, component]) =>
            scoped.slots.register({ name: 'sidebar.right.pane.tab', key: key as string }, component as React.FC<Props>));
          return () => { for (const dispose of disposers) if (typeof dispose === 'function') dispose(); };
        });
      } catch (error) { console.warn('Remote workspace sidebar unavailable', error); }
      warm();
      return () => {
        disposed = true; off(); for (const c of controllers) c.abort(); window.removeEventListener('remote-agents-updated', changed);
        live.files?.(); live.explorer?.(); offFile?.();
      };
    });
  });
}
