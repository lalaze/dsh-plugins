import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { LocaleContext } from '@dsh-plugins/i18n';
import type { Dashboard } from '../domain.js';
import { api } from './api.js';
import { installLocale, localizeError, ui, useLocale } from './i18n.js';
import { HostManager } from './hosts.js';
import { styles } from './styles.js';
import { Sessions, useDashboard } from './sessions.js';
import { installModelGroups } from './model-groups.js';
import { installWorkspaceModels, type WorkspaceClient } from './workspace-models.js';

export interface Client extends LocaleContext {
  effect(factory: () => () => void): void;
  inject?(services: string[], factory: (scoped: Client) => void): unknown;
  slots: { inject(name: string, factory: () => void): unknown; register(spec: Record<string, unknown>, component: React.FC): unknown };
}
function Settings({ openSessions }: { openSessions: () => void }) {
  useLocale();
  const [dashboard, setDashboard] = useState<Dashboard | null>(null), [error, setError] = useState(''), [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setError('');
    void api<Dashboard>(undefined, {}, controller.signal)
      .then(value => { if (!controller.signal.aborted) setDashboard(value); })
      .catch(error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : String(error)); });
    return () => controller.abort();
  }, [revision]);
  return <section className="dsh-ra ra-settings" aria-label={ui('Remote agents')}><style>{styles}</style>
    <div className="ra-settings-heading"><h2>{ui('Remote agents')}</h2><button onClick={openSessions}>{ui('Open sessions')}</button></div>
    <p className="ra-muted ra-intro">{ui('Select remote CLIs in the DSH model picker and chat in the main conversation.')}</p>
    <p className="ra-muted ra-intro">{ui('Remote models are only available in workspaces belonging to the same machine.')}</p>
    {dashboard ? <HostManager dashboard={dashboard} update={setDashboard} />
      : error ? <div className="ra-banner" data-tone="error" role="alert">{localizeError(error)}<button type="button" onClick={() => setRevision(value => value + 1)}>{ui('Retry')}</button></div>
      : <div className="ra-empty" role="status">{ui('Loading settings…')}</div>}
  </section>;
}
function SessionDialog({ close, openChat, cwd }: { close: () => void; openChat: (id: string) => void; cwd?: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const focused = document.activeElement, element = dialog.current;
    const overflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
    element?.showModal();
    return () => { element?.close(); document.body.style.overflow = overflow; if (focused instanceof HTMLElement) focused.focus(); };
  }, []);
  return createPortal(<dialog className="dsh-ra ra-dialog" ref={dialog} aria-label={ui('Remote sessions')} onCancel={close} onClose={close}>
    <style>{styles}</style><div className="ra-dialog-bar"><span>{ui('Remote agents')}</span><button aria-label={ui('Close remote sessions')} onClick={close}>×</button></div>
    <Sessions openChat={openChat} cwd={cwd} />
  </dialog>, document.body);
}
function SessionLauncher({ open }: { open: () => void }) {
  useLocale(); const { dashboard } = useDashboard();
  const count = dashboard?.agents.filter(a => !a.archived && a.pendingPermissions > 0).length ?? 0;
  return <div className="dsh-ra"><style>{styles}</style><button className="ra-session-launch" onClick={open}><span aria-hidden="true">↗</span>{ui('Remote sessions')}{count > 0 && <span className="ra-attention-count" aria-label={ui('{count} sessions need attention', { count })}>{count}</span>}</button></div>;
}
export const name = 'dsh-remote-agents-client';
// The desktop language bridge initializes asynchronously. Wait for it before registering UI.
export const inject = ['slots', 'locale'];
export function apply(ctx: Client): void {
  ctx.effect(() => installLocale(ctx));
  // Shared event lets Settings open the same sidebar-owned dialog, with a fallback when the sidebar is absent.
  const listeners = new Set<() => void>();
  const open = () => { for (const listener of listeners) listener(); };
  const Surface = ({ settings }: { settings?: boolean }) => {
    useLocale(); const [visible, setVisible] = useState(false);
    useEffect(() => { const listener = () => setVisible(true); if (!settings) listeners.add(listener); return () => { listeners.delete(listener); }; }, [settings]);
    const show = () => { if (listeners.size) open(); else setVisible(true); };
    const openChat = (id: string) => {
      const navigation = (ctx.get as ((name: string) => unknown) | undefined)?.('uiWorkspace') as { openSession?: (id: string) => void } | undefined;
      if (!navigation?.openSession) throw new Error('Open this conversation from the DSH sidebar.');
      navigation.openSession(id); setVisible(false);
    };
    const sessions = (ctx.get as ((name: string) => unknown) | undefined)?.('sessions') as { list?: { getSnapshot(): { byId?: Record<string, { cwd?: string; retainedBy?: Record<string, number> }> } } } | undefined;
    const cwd = Object.values(sessions?.list?.getSnapshot()?.byId ?? {}).find(s => (s.retainedBy?.mainView ?? 0) > 0)?.cwd;
    return <>{settings ? <Settings openSessions={show} /> : <SessionLauncher open={show} />}{visible && <SessionDialog close={() => setVisible(false)} openChat={openChat} cwd={cwd} />}</>;
  };
  ctx.slots.inject('settings.section', () => { ctx.slots.register({ name: 'settings.section', id: 'remote-agents', order: 74, label: () => ui('Remote agents') }, () => <Surface settings />); });
  ctx.slots.inject('sidebar.footer.action', () => { ctx.slots.register({ name: 'sidebar.footer.action', id: 'remote-agents-sessions', order: 74 }, Surface); });
  ctx.effect(installModelGroups);
  ctx.inject?.(['modelDirectories', 'sessions', 'workspaces'], scoped => installWorkspaceModels(scoped as unknown as WorkspaceClient));
}
