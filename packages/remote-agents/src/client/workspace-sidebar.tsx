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
/** Uses the native right-sidebar extension contract; local sessions keep their original viewers. */
export function installWorkspaceSidebar(ctx: Client): void {
  ctx.inject?.(['sidebarRightTabs', 'sessions'], scoped => {
    const get = scoped.get as ((name: string) => unknown) | undefined;
    const tabs = get?.('sidebarRightTabs') as { register(spec: Record<string, unknown>): () => void } | undefined;
    const sessions = get?.('sessions') as { list: { getSnapshot(): { byId?: Record<string, { cwd?: string; retainedBy?: Record<string, number> }> }; subscribe(listener: () => void): () => void } } | undefined;
    if (!tabs || typeof tabs.register !== 'function' || !sessions?.list) return;
    scoped.effect(() => {
      const cache = new Map<string, { cwd: string; target?: WorkspaceTarget }>(), controllers = new Set<AbortController>();
      let disposed = false;
      const warm = () => {
        const byId = sessions.list.getSnapshot()?.byId ?? {};
        for (const [id, entry] of cache) if (byId[id]?.cwd !== entry.cwd) cache.delete(id);
        for (const [id, session] of Object.entries(byId)) {
          if (!session.cwd || cache.has(id) || !(session.retainedBy?.mainView) || !/(?:^|[/\\])remote-workspaces[/\\]/.test(session.cwd)) continue;
          const entry = { cwd: session.cwd, target: undefined as WorkspaceTarget | undefined }, c = new AbortController(); cache.set(id, entry); controllers.add(c);
          void api<WorkspaceTarget>('workspaceTarget', { sessionId: id }, c.signal).then(target => {
            if (!disposed && cache.get(id) === entry) entry.target = target;
          }).catch(() => {}).finally(() => controllers.delete(c));
        }
      };
      const changed = () => { cache.clear(); warm(); };
      const off = sessions.list.subscribe(warm); warm(); window.addEventListener('remote-agents-updated', changed);
      const explorer = 'remote-agents/workspace', file = 'remote-agents/file';
      const disposers: (() => void)[] = [];
      try {
        disposers.push(tabs.register({ id: explorer, kind: explorer, title: () => ui('Remote workspace'), guide: [{ order: 55, title: () => ui('Remote workspace') }] }));
        disposers.push(tabs.register({ id: file, kind: file, patterns: ['dsh-resource://file/**'],
          canOpen: (address: string) => { const parsed = workspaceFileAddress(address); return !!parsed && !!cache.get(parsed.sessionId)?.target; },
          title: (address: string) => workspaceFileAddress(address)?.path.split('/').pop() || ui('Remote file'),
        }));
        scoped.slots.inject('sidebar.right.pane.tab', () => {
          type Props = { sessionId: string; useTabInfo(): { tab: { navigation: { address: string } } } };
          const useCwd = (id: string) => React.useSyncExternalStore(listener => sessions.list.subscribe(listener), () => sessions.list.getSnapshot()?.byId?.[id]?.cwd);
          const Explorer: React.FC<Props> = ({ sessionId }) => { const cwd = useCwd(sessionId); return <><style>{styles}</style><WorkspacePanel key={JSON.stringify([sessionId, cwd])} sessionId={sessionId} /></>; };
          const File: React.FC<Props> = props => {
            const parsed = workspaceFileAddress(props.useTabInfo().tab.navigation.address);
            const id = parsed?.sessionId ?? props.sessionId, cwd = useCwd(id);
            return <><style>{styles}</style><WorkspacePanel key={JSON.stringify([parsed, cwd])} sessionId={id} initialPath={parsed?.path} /></>;
          };
          const offExplorer = scoped.slots.register({ name: 'sidebar.right.pane.tab', key: explorer }, Explorer);
          const offFile = scoped.slots.register({ name: 'sidebar.right.pane.tab', key: file }, File);
          return () => { if (typeof offExplorer === 'function') offExplorer(); if (typeof offFile === 'function') offFile(); };
        });
      } catch (error) { for (const dispose of disposers.splice(0)) dispose(); console.warn('Remote workspace sidebar unavailable', error); }
      return () => { disposed = true; off(); for (const c of controllers) c.abort(); window.removeEventListener('remote-agents-updated', changed); for (const dispose of disposers) dispose(); };
    });
  });
}
