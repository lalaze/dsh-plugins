import React, { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { symbols } from '@deepseek-ai/cordis';
import type { LocaleContext } from '@dsh-plugins/i18n';
import { locksDraftsToEnglish } from '../settings.js';
import { loadSettings, subscribeSettings } from './api.js';
import { installTranslationDom, refreshDraftButton, replaceComposer, setDraftLabel, translateDraft } from './dom.js';
import { installLocale, ui, useLocale } from './i18n.js';
import { TranslationSettingsSection } from './settings.js';
import { installStyles } from './styles.js';

interface Selection { provider: string; model: string }
interface ModelStore { getSnapshot(): { current: Selection | null } | undefined; subscribe(listener: () => void): () => void }
interface ModelDirectories { directoryFor(sessionId: string): { store: ModelStore } }
interface Client extends LocaleContext {
  effect(factory: () => () => void): void;
  inject?(services: string[], factory: (scoped: Client & { modelDirectories: ModelDirectories }) => void): unknown;
  slots: { inject(name: string, factory: () => void): unknown; register(spec: Record<string, unknown>, component: React.FC<any>): unknown };
}

// The picker's directory knows the model a session will use, including a new session's default before it sends.
let directories: ModelDirectories | undefined;
const directoryListeners = new Set<() => void>();
const setDirectories = (value: ModelDirectories | undefined) => { directories = value; for (const listener of directoryListeners) listener(); };
const subscribeDirectories = (listener: () => void) => { directoryListeners.add(listener); return () => { directoryListeners.delete(listener); }; };
function useCurrentModel(sessionId: string | undefined): Selection | null {
  const resolver = useSyncExternalStore(subscribeDirectories, () => directories);
  const store = useMemo(() => {
    if (!resolver || !sessionId) return undefined;
    try { return resolver.directoryFor(sessionId).store; } catch { return undefined; }
  }, [resolver, sessionId]);
  const subscribe = useCallback((listener: () => void) => store?.subscribe(listener) ?? (() => {}), [store]);
  return useSyncExternalStore(subscribe, () => store?.getSnapshot()?.current ?? null);
}
export const name = 'dsh-translate-client';
export const inject = ['slots'];
// A translation mark in the host icon grid (16px box, 1px stroke).
function TranslateIcon() {
  return <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.1} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M1.5 3.5h7M5 2v1.5M3 3.5c.6 2.4 2.1 4.2 4.4 5.4M7 3.5C6.4 6.1 4.7 8.3 2 9.5M8.5 14l3-7 3 7M9.6 11.6h3.8" />
  </svg>;
}
function ComposerTranslateButton({ sessionId }: { sessionId?: string }) {
  const locale = useLocale();
  const keywords = useSyncExternalStore(subscribeSettings, () => loadSettings().englishLockModels);
  const english = locksDraftsToEnglish(keywords, useCurrentModel(sessionId));
  useEffect(refreshDraftButton, [locale, english]);
  return <button type="button" data-dsh-translate-draft data-dsh-translate-target={english ? 'en' : 'auto'} className="dsh-translate-composer-button" title={english ? ui('Translate draft to English (Alt/Option+T)') : ui('Translate draft (Alt/Option+T)')} onClick={() => {
    const editor = document.querySelector<HTMLElement>('[data-composer-input], textarea[aria-label*="message" i], textarea[placeholder*="message" i], textarea[placeholder*="消息" i], [contenteditable="true"]');
    const button = document.querySelector<HTMLButtonElement>('[data-dsh-translate-draft]');
    if (button?.dataset.dshTranslateUndo && editor) { replaceComposer(editor, button.dataset.dshTranslateUndo); delete button.dataset.dshTranslateUndo; setDraftLabel(button, ui('Translate')); }
    else if (editor) void translateDraft(editor);
  }}><TranslateIcon /><span data-dsh-translate-label>{ui('Translate')}</span>{english && <span data-dsh-translate-lock aria-hidden="true">EN</span>}</button>;
}
export function apply(ctx: Client): void {
  ctx.effect(() => installLocale(ctx));
  ctx.effect(() => installStyles());
  ctx.effect(() => installTranslationDom());
  ctx.inject?.(['modelDirectories'], scoped => scoped.effect(() => {
    // Call the service itself: through this plugin's proxy it would resolve its own dependencies from our context.
    const service = scoped.modelDirectories;
    setDirectories((service as unknown as Record<symbol, ModelDirectories | undefined>)[symbols.original] ?? service);
    return () => setDirectories(undefined);
  }));
  ctx.slots.inject('settings.section', () => { ctx.slots.register({ name: 'settings.section', id: 'translate', order: 72, label: () => ui('Translation') }, TranslationSettingsSection); });
  ctx.slots.inject('conversation.input.left', () => { ctx.slots.register({ name: 'conversation.input.left', id: 'translate', order: 60 }, ({ sessionId }: { sessionId?: string }) => <ComposerTranslateButton sessionId={sessionId} />); });
}
