import React from 'react';
import type { LocaleContext } from '@dsh-plugins/i18n';
import { claims, fileAddress } from './address.js';
import { FileTab } from './file-tab.js';
import { installLocale, ui } from './i18n.js';

interface Client extends LocaleContext {
  effect(factory: () => () => void): void;
  inject?(services: string[], factory: (scoped: Client) => void): unknown;
  slots: { inject(name: string, factory: () => unknown): unknown; register(spec: Record<string, unknown>, component: React.FC<any>): unknown };
}
type TabProps = { sessionId: string; useTabInfo(): { tab: { navigation: { address: string } } } };
type Sessions = { list: { getSnapshot(): { byId?: Record<string, { cwd?: string }> } | undefined } };

/** The right sidebar's file viewer kind this plugin adds. */
export const KIND = 'file-editor/file';
const Tab: React.FC<TabProps> = ({ sessionId, useTabInfo }) => {
  const address = useTabInfo().tab.navigation.address, parsed = fileAddress(address);
  return parsed ? <FileTab key={address} sessionId={parsed.sessionId || sessionId} path={parsed.path} line={parsed.line} /> : null;
};

export const name = 'dsh-file-editor-client';
// The desktop language bridge initializes asynchronously; wait for it before registering UI.
export const inject = ['slots', 'locale'];
/**
 * Uses DSH's right-sidebar file contract: text and code files of local conversations open here instead of DSH's
 * read-only preview. Other files, and every file of a remote workspace, keep their own viewers.
 */
export function apply(ctx: Client): void {
  ctx.effect(() => installLocale(ctx));
  ctx.inject?.(['sidebarRightTabs', 'sessions'], scoped => {
    const get = (scoped as { get?(name: string): unknown }).get;
    const tabs = get?.('sidebarRightTabs') as { register(spec: Record<string, unknown>): () => void } | undefined;
    const sessions = get?.('sessions') as Sessions | undefined;
    if (!tabs || typeof tabs.register !== 'function' || !sessions?.list) return;
    const cwdOf = (id: string) => sessions.list.getSnapshot()?.byId?.[id]?.cwd;
    scoped.effect(() => tabs.register({ id: KIND, kind: KIND, patterns: ['dsh-resource://file/**'],
      canOpen: (address: string) => claims(address, cwdOf),
      title: (address: string) => fileAddress(address)?.path.split('/').pop() || ui('File contents') }));
    scoped.slots.inject('sidebar.right.pane.tab', () => scoped.slots.register({ name: 'sidebar.right.pane.tab', key: KIND }, Tab));
  });
}
