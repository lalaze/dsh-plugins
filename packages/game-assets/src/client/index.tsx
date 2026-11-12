import React from 'react';
import type { LocaleContext } from '@dsh-plugins/i18n';
import { tuiPrompt } from '@dsh-plugins/remote-core/client/tui-prompt.js';
import { NAMESPACE, installLocale, ui } from './i18n.js';
import { ComposerBridge, offer, type ComposerProps } from './outbox.js';
import { AssetsPanel } from './panel.js';
import { hasSessions, loadMode, setSessions, subscribe, tabWanted, type Sessions } from './projects.js';
import { TabSettings } from './settings.js';

interface Client extends LocaleContext {
  effect(factory: () => () => void): void;
  inject?(services: string[], factory: (scoped: Client) => void): unknown;
  slots: { inject(name: string, factory: () => unknown): unknown; register(spec: Record<string, unknown>, component: React.FC<any>): unknown };
}
type OpenResource = (address: string, options?: Record<string, unknown>) => void;

/** The conversation view this plugin adds beside Chat. */
export const VIEW_ID = 'game-assets';
/** The key of the plugin's settings section on its detail page: the bundle's install identity. */
export const BUNDLE_KEY = 'dsh-game-assets';
/** A host that never offers its session list cannot say which conversation is on screen; the tab then shows everywhere. */
const SESSIONS_GRACE_MS = 3000;
/** DSH's address of a workspace file, as its right sidebar opens it; `#L12` carries a line. */
export const fileAddress = (sessionId: string, path: string, line?: number) =>
  `dsh-resource://file/session/${encodeURIComponent(sessionId)}/${path.split('/').map(encodeURIComponent).join('/')}${line ? `#L${line}` : ''}`;

export const name = 'dsh-game-assets-client';
// The desktop language bridge initializes asynchronously; wait for it before registering UI.
export const inject = ['slots', 'locale'];
/**
 * Adds an Assets tab beside Chat: the images of the conversation's workspace, and which of them the code still uses.
 * The tab is there only while a conversation on screen belongs to a game project (see projects.ts); the plugin's detail
 * page has the settings. Files open in DSH's right sidebar where the host has one.
 */
export function apply(ctx: Client): void {
  ctx.effect(() => installLocale(ctx));
  let openResource: OpenResource | undefined;
  // The right sidebar is optional; without it references are listed but do not open.
  ctx.inject?.(['sidebarRight'], scoped => {
    const sidebar = (scoped as { get?(name: string): unknown }).get?.('sidebarRight') as { openResource?: OpenResource } | undefined;
    if (typeof sidebar?.openResource !== 'function') return;
    scoped.effect(() => {
      openResource = (address, options) => sidebar.openResource!(address, options);
      return () => { openResource = undefined; };
    });
  });
  // Chat is where the composer is; DSH's conversation service switches a conversation back to it.
  let activate: ((sessionId: string) => void) | undefined;
  ctx.inject?.(['uiConversation'], scoped => {
    const conversations = (scoped as { get?(name: string): unknown }).get?.('uiConversation') as { binding?(sessionId: string): { activate?(view: string): void } } | undefined;
    if (typeof conversations?.binding !== 'function') return;
    scoped.effect(() => {
      activate = sessionId => { try { conversations.binding!(sessionId).activate?.('chat'); } catch { /* the conversation is gone, or this host names Chat differently */ } };
      return () => { activate = undefined; };
    });
  });
  /**
   * Offers the text to the conversation's composer, which may only mount once Chat is showing. A TUI conversation has the
   * CLI's prompt in a terminal instead, and DSH keeps its composer hidden underneath, where a draft would never be seen.
   */
  const sendToChat = (sessionId: string, text: string) => {
    const tui = tuiPrompt();
    const taken = tui?.has(sessionId) ? tui.paste(sessionId, text) : offer(sessionId, text);
    activate?.(sessionId);
    return taken;
  };
  const View: React.FC<{ sessionId?: string }> = ({ sessionId }) =>
    <AssetsPanel sessionId={sessionId} sendToChat={sendToChat} openFile={(session, path, line) => openResource?.(fileAddress(session, path, line), line ? { params: { line } } : undefined)} />;
  let release: (() => void) | undefined, waited = false;
  const releases = (...handles: unknown[]) => () => { for (const handle of handles) if (typeof handle === 'function') (handle as () => void)(); };
  const reconcile = () => {
    // Undefined keeps the tab as it is while an answer is on its way.
    const wanted = hasSessions() ? tabWanted() : waited ? true : undefined;
    if (wanted && !release) {
      // Beside Chat (0), Trajectory (10) and Git (30).
      release = releases(
        ctx.slots.inject('conversation.view', () => ctx.slots.register({ name: 'conversation.view', id: VIEW_ID, order: 40, locale: NAMESPACE, label: () => ui('Assets') }, View)),
        // Invisible; receives the composer's draft setter for "Ask the agent".
        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({ name: 'conversation.input.left', id: VIEW_ID, order: 200 }, (props: ComposerProps) => <ComposerBridge {...props} />)));
    } else if (wanted === false && release) {
      const done = release;
      release = undefined;
      done();
    }
  };
  ctx.effect(() => {
    const off = subscribe(reconcile), timer = setTimeout(() => { waited = true; reconcile(); }, SESSIONS_GRACE_MS);
    void loadMode();
    return () => { off(); clearTimeout(timer); const done = release; release = undefined; done?.(); };
  });
  ctx.inject?.(['sessions'], scoped => {
    const sessions = (scoped as { get?(name: string): unknown }).get?.('sessions') as Sessions | undefined;
    if (!sessions?.list || typeof sessions.list.subscribe !== 'function') return;
    scoped.effect(() => {
      setSessions(sessions);
      const off = sessions.list.subscribe(reconcile);
      return () => { off(); setSessions(undefined); };
    });
  });
  // Only an explicit entry keyed by the bundle identity gives the plugin's detail page a settings section.
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({ name: 'plugins.bundle.config', key: BUNDLE_KEY, locale: NAMESPACE },
    (props: { view?: string }) => props.view === 'summary' ? <>{ui('Where the Assets tab appears')}</> : <TabSettings />));
}
