import type { LocaleContext } from '@dsh-plugins/i18n';
import { installLocale } from './i18n.js';
import React, { useSyncExternalStore } from 'react';
import { FastControl } from './control.js';
import type { Selection } from '../gpt.js';

interface DirectoryStore { subscribe(callback: () => void): () => void; getSnapshot(): { current: Selection | null } }
interface Client extends LocaleContext {
  effect(factory: () => () => void): void;
  slots: {
    inject(name: string, factory: () => void): unknown;
    register(spec: Record<string, unknown>, component: React.FC<{ sessionId?: string }>): unknown;
  };
  modelDirectories: { directoryFor(sessionId: string): { store: DirectoryStore } };
}
export const name = 'dsh-magpie-fast-client';
export const inject = ['slots', 'modelDirectories'];
function SessionControl({ ctx, sessionId }: { ctx: Client; sessionId: string }) {
  let store: DirectoryStore;
  try { store = ctx.modelDirectories.directoryFor(sessionId).store; } catch { return null; }
  return <DirectoryControl store={store} sessionId={sessionId} />;
}
function DirectoryControl({ store, sessionId }: { store: DirectoryStore; sessionId: string }) {
  const selected = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot).current;
  return <FastControl sessionId={sessionId} selection={selected} />;
}
export function apply(ctx: Client) {
  ctx.effect(() => installLocale(ctx));
  ctx.slots.inject('conversation.input.left', () => {
    ctx.slots.register({ name: 'conversation.input.left', id: 'gpt-fast', order: 10 }, props => props.sessionId ? <SessionControl ctx={ctx} sessionId={props.sessionId} /> : null);
  });
}
