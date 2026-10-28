import { XIcon } from '@phosphor-icons/react/dist/csr/X';
import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import type { LocaleContext } from '@dsh-plugins/i18n';
import type { Dashboard } from '../domain.js';
import { api } from './api.js';
import { installLocale, localizeError, ui, useLocale } from './i18n.js';
import { HostManager } from './hosts.js';
import { SharingSettings } from './sharing.js';
import { styles } from './styles.js';
import { Sessions } from './sessions.js';
import { installModelGroups } from './model-groups.js';
import { ModelLabel } from './model-label.js';
import { installCustomModelLabels } from './custom-model-label.js';
import { installWorkspaceModels, type WorkspaceClient } from './workspace-models.js';
import { installUsageStyles, setModelDirectories, UsageRing, type ModelDirectories } from './usage.js';
import { FastToggle } from './fast.js';
import { DIRECTORY_FLOW_PRIORITY, DIRECTORY_FLOWS, workspaceFlow, type LocalDirectories } from './workspace-flow.js';
import { symbols } from '@deepseek-ai/cordis';
import { WorkspacePanel } from './workspace.js';
import { installWorkspaceSidebar } from './workspace-sidebar.js';
import { installShellMenu } from './shell-menu.js';

export interface Client extends LocaleContext {
  effect(factory: () => () => void): void;
  inject?(services: string[], factory: (scoped: Client) => void): unknown;
  slots: { inject(name: string, factory: () => void): unknown; register(spec: Record<string, unknown>, component: React.FC<any>): unknown };
}
function Settings({ openSessions, openWorkspace }: { openSessions: () => void; openWorkspace: () => void }) {
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
    <div className="ra-settings-heading"><h2>{ui('Remote agents')}</h2><button data-open-sessions onClick={openSessions}>{ui('Open sessions')}</button><button data-open-workspace onClick={openWorkspace}>{ui('Remote workspace')}</button></div>
    <p className="ra-muted ra-intro">{ui('Select remote CLIs in the DSH model picker and chat in the main conversation.')}</p>
    <p className="ra-muted ra-intro">{ui('Remote models are only available in workspaces belonging to the same machine.')}</p>
    {dashboard ? <><HostManager dashboard={dashboard} update={setDashboard} /><SharingSettings dashboard={dashboard} /></>
      : error ? <div className="ra-banner" data-tone="error" role="alert">{localizeError(error)}<button type="button" onClick={() => setRevision(value => value + 1)}>{ui('Retry')}</button></div>
      : <div className="ra-empty" role="status">{ui('Loading settings…')}</div>}
  </section>;
}
function SessionDialog({ close, openChat, sessionId, cwd, workspace }: { close: () => void; openChat: (id: string) => void; sessionId?: string; cwd?: string; workspace?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const focused = document.activeElement, element = dialog.current;
    const overflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
    element?.showModal();
    return () => { element?.close(); document.body.style.overflow = overflow; if (focused instanceof HTMLElement) focused.focus(); };
  }, []);
  return createPortal(<dialog className="dsh-ra ra-dialog" ref={dialog} aria-label={ui(workspace ? 'Remote workspace' : 'Remote sessions')} onCancel={close} onClose={close}>
    <style>{styles}</style><div className="ra-dialog-bar"><span>{ui(workspace ? 'Remote workspace' : 'Remote sessions')}</span><button aria-label={ui('Close remote sessions')} onClick={close}><XIcon size={19} /></button></div>
    {workspace ? <WorkspacePanel key={JSON.stringify([sessionId, cwd])} sessionId={sessionId} /> : <Sessions openChat={openChat} sessionId={sessionId} cwd={cwd} />}
  </dialog>, document.body);
}
export const name = 'dsh-remote-agents-client';
// The desktop language bridge initializes asynchronously. Wait for it before registering UI.
export const inject = ['slots', 'locale'];
export function apply(ctx: Client): void {
  ctx.effect(() => installLocale(ctx));
  const Surface = () => {
    useLocale(); const [visible, setVisible] = useState(false), [workspace, setWorkspace] = useState(false);
    const openChat = (id: string) => {
      const navigation = (ctx.get as ((name: string) => unknown) | undefined)?.('uiWorkspace') as { openSession?: (id: string) => void } | undefined;
      if (!navigation?.openSession) throw new Error('Open this conversation from the DSH sidebar.');
      navigation.openSession(id); setVisible(false);
    };
    const sessions = (ctx.get as ((name: string) => unknown) | undefined)?.('sessions') as { list?: { getSnapshot(): { byId?: Record<string, { cwd?: string; retainedBy?: Record<string, number> }> }; subscribe(listener: () => void): () => void } } | undefined;
    const active = useSyncExternalStore(useCallback(listener => sessions?.list?.subscribe(listener) ?? (() => {}), [sessions]), () => {
      const entry = Object.entries(sessions?.list?.getSnapshot()?.byId ?? {}).find(([, s]) => (s.retainedBy?.mainView ?? 0) > 0);
      return JSON.stringify(entry ? [entry[0], entry[1].cwd] : []);
    });
    const [sessionId, cwd] = JSON.parse(active) as [string?, string?];
    return <><Settings openSessions={() => { setWorkspace(false); setVisible(true); }} openWorkspace={() => { setWorkspace(true); setVisible(true); }} />{visible && <SessionDialog close={() => setVisible(false)} openChat={openChat} sessionId={sessionId} cwd={cwd} workspace={workspace} />}</>;
  };
  ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'remote-agents', order: 74, label: () => ui('Remote agents') }, Surface));
  ctx.effect(installModelGroups);
  // A native label contribution is a fallback; another plugin may already own priority 0.
  ctx.slots.inject('conversation.input.model.label', () => ctx.slots.register({ name: 'conversation.input.model.label', id: 'remote-agents-model-label', priority: 50 }, ModelLabel));
  ctx.effect(installCustomModelLabels);
  ctx.effect(installUsageStyles);
  installWorkspaceSidebar(ctx);
  ctx.effect(installShellMenu);
  ctx.inject?.(['modelDirectories'], scoped => scoped.effect(() => {
    // Read through the service itself: this plugin's proxy would resolve dependencies from our context.
    const service = (scoped as unknown as { modelDirectories: ModelDirectories }).modelDirectories;
    setModelDirectories((service as unknown as Record<symbol, ModelDirectories | undefined>)[symbols.original] ?? service);
    return () => setModelDirectories(undefined);
  }));
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({ name: 'conversation.input.right', id: 'remote-agents-usage', order: 50 }, UsageRing));
  // Codex's Fast switch sits after the permission control, before the translate button (order 60).
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({ name: 'conversation.input.left', id: 'remote-agents-fast', order: 10 }, FastToggle));
  ctx.inject?.(['modelDirectories', 'sessions', 'workspaces'], scoped => installWorkspaceModels(scoped as unknown as WorkspaceClient));
  // Add workspace gains a Remote machine tab. Ahead of DSH's own picker (0), behind dsh-remote's (-100) when both are installed.
  const Flow = workspaceFlow(() => (ctx.get as ((name: string) => unknown) | undefined)?.('uiWorkspace') as LocalDirectories | undefined);
  ctx.slots.inject(DIRECTORY_FLOWS[0], () => ctx.slots.inject(DIRECTORY_FLOWS[1], () => {
    const disposers = DIRECTORY_FLOWS.map(name => ctx.slots.register({ name, id: 'remote-agents-workspace-flow', priority: DIRECTORY_FLOW_PRIORITY }, Flow));
    return () => { for (const dispose of disposers) if (typeof dispose === 'function') dispose(); };
  }));
}
