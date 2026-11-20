import React from 'react';
import type { LocaleContext } from '@dsh-plugins/i18n';
import { tuiPrompt } from '@dsh-plugins/remote-core/client/tui-prompt.js';
import { NAMESPACE, installLocale, ui } from './i18n.js';
import { ComposerBridge, offer, type ComposerProps } from './outbox.js';
import { StatusPanel, TabMark } from './panel.js';

interface Client extends LocaleContext {
  effect(factory: () => () => void): void;
  inject?(services: string[], factory: (scoped: Client) => void): unknown;
  slots: { inject(name: string, factory: () => unknown): unknown; register(spec: Record<string, unknown>, component: React.FC<any>): unknown };
}

/** The conversation view this plugin adds beside Chat. */
export const VIEW_ID = 'project-status';

export const name = 'dsh-project-status-client';
// The desktop language bridge initializes asynchronously; wait for it before registering UI.
export const inject = ['slots', 'locale'];
/**
 * Adds a Status tab beside Chat: the status of the project the conversation works in, the same one from every worktree
 * and branch of its repository. Every conversation has a project, so the tab is always there.
 */
export function apply(ctx: Client): void {
  ctx.effect(() => installLocale(ctx));
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
  const sendToChat = async (sessionId: string, text: string, showChat: () => void) => {
    const tui = tuiPrompt();
    if (tui?.has(sessionId)) {
      // The terminal opens with the Chat view, and the text waits for it only a while.
      showChat();
      return tui.paste(sessionId, text);
    }
    const offered = offer(sessionId, text);
    activate?.(sessionId);
    const taken = await offered;
    // The request is for the agent: the next thing to do is to read it over and send it.
    if (taken) showChat();
    return taken;
  };
  /** `openView` is DSH's way for a view to select another one; its second argument names what to focus there. */
  const View: React.FC<{ sessionId?: string; openView?(view: string, focus: string): void }> = ({ sessionId, openView }) =>
    <StatusPanel sessionId={sessionId} sendToChat={(id, text) => sendToChat(id, text, () => { try { openView?.('chat', VIEW_ID); } catch { /* this host names Chat differently */ } })} />;
  // Invisible, and mounted whichever view is showing: it takes text for the composer, and marks the tab.
  const Beside: React.FC<ComposerProps> = props => <><ComposerBridge {...props} /><TabMark sessionId={props.sessionId} /></>;
  ctx.effect(() => {
    const handles = [
      // Between Git (30) and Stats (40).
      ctx.slots.inject('conversation.view', () => ctx.slots.register({ name: 'conversation.view', id: VIEW_ID, order: 35, locale: NAMESPACE, label: () => ui('Status') }, View)),
      ctx.slots.inject('conversation.input.left', () => ctx.slots.register({ name: 'conversation.input.left', id: VIEW_ID, order: 210 }, Beside)),
    ];
    return () => { for (const handle of handles) if (typeof handle === 'function') (handle as () => void)(); };
  });
}
