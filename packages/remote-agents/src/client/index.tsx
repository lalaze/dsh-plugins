import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { LocaleContext } from '@dsh-plugins/i18n';
import { apply as installClaude, type ClientCtx as ClaudeClient } from 'dsh-claude-ssh/embedded-client';
import { RemoteAgentsHub, registerClaudeSettings } from './hub.js';
import { installLocale, ui, useLocale } from './i18n.js';

export interface Client extends LocaleContext {
  effect(factory: () => () => void): void;
  slots: { inject(name: string, factory: () => void): unknown; register(spec: Record<string, unknown>, component: React.FC): unknown };
}
function TaskDialog({ close }: { close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const focused = document.activeElement; dialog.current?.showModal(); return () => { dialog.current?.close(); if (focused instanceof HTMLElement) focused.focus(); }; }, []);
  return createPortal(<dialog className="ra-dialog" aria-label={ui('Remote agents')} ref={dialog} onClose={close} onCancel={event => { event.stopPropagation(); close(); }} onKeyDown={event => event.stopPropagation()}><button className="ra-dialog-close" aria-label={ui('Close remote agents')} onClick={close}>×</button><RemoteAgentsHub close={close} /></dialog>, document.body);
}
function Launcher() {
  useLocale(); const [open, setOpen] = useState(false);
  return <><button className="ra-launch" style={{ border: 0, background: 'none', color: 'inherit', cursor: 'pointer', padding: '4px 8px', font: 'inherit' }} title={ui('Open remote agents')} aria-label={ui('Open remote agents')} onClick={() => setOpen(true)}>⌘ {ui('Remote agents')}</button>{open && <TaskDialog close={() => setOpen(false)} />}</>;
}
export const name = 'dsh-remote-agents-client';
export const inject = ['slots', 'sessions', 'workspaces', 'modelDirectories'];
export function apply(ctx: Client): void {
  ctx.effect(() => installLocale(ctx));
  installClaude(ctx as unknown as ClaudeClient, { registerSettings: registerClaudeSettings, settingsLabel: 'Claude SSH' });
  ctx.slots.inject('settings.section', () => { ctx.slots.register({ name: 'settings.section', id: 'remote-agents', order: 74, label: () => ui('Remote agents') }, RemoteAgentsHub); });
  ctx.slots.inject('conversation.input.left', () => { ctx.slots.register({ name: 'conversation.input.left', id: 'remote-agents', order: 62 }, Launcher); });
}
