import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { symbols } from '@deepseek-ai/cordis';
import type { LocaleContext } from '@dsh-plugins/i18n';
import { MAX_SOURCE_LENGTH } from '../rpc.js';
import { locksDraftsToEnglish } from '../settings.js';
import { loadSettings, subscribeSettings, translate } from './api.js';
import { composerText, installTranslationDom, readComposer, replaceComposer } from './dom.js';
import { installLocale, localizeError, ui, useLocale } from './i18n.js';
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
/** DSH supplies the session's draft setter and a selector over its composer state. */
interface ComposerSlotProps {
  sessionId?: string;
  inputActions?: { setDraft(text: string): void };
  useInput?: <T>(select: (state: { draft: string }) => T) => T;
}
type DraftState = { phase: 'idle' } | { phase: 'busy' } | { phase: 'undo'; original: string; translated: string } | { phase: 'error'; error: string };

// The picker directory knows the session's selected model, including its unsent default.
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

// Alt/Option+T targets the focused composer, or the sole mounted composer.
const shortcutTargets = new Set<{ scope: () => Element | null; run: () => void }>();
function onShortcut(event: KeyboardEvent) {
  if (!event.altKey || event.code !== 'KeyT' && event.key.toLowerCase() !== 't') return;
  const targets = [...shortcutTargets];
  const target = targets.length === 1 ? targets[0] : targets.find(entry => entry.scope()?.contains(document.activeElement));
  if (!target) return;
  event.preventDefault();
  target.run();
}
function TranslateIcon() {
  return <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.1} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M1.5 3.5h7M5 2v1.5M3 3.5c.6 2.4 2.1 4.2 4.4 5.4M7 3.5C6.4 6.1 4.7 8.3 2 9.5M8.5 14l3-7 3 7M9.6 11.6h3.8" />
  </svg>;
}
function ComposerTranslateButton({ sessionId, inputActions, useInput }: ComposerSlotProps) {
  useLocale();
  const model = useCurrentModel(sessionId);
  const englishLockModels = useSyncExternalStore(subscribeSettings, () => loadSettings().englishLockModels);
  const english = locksDraftsToEnglish(englishLockModels, model);
  const hostDraft = useInput?.(state => state.draft);
  const [state, setState] = useState<DraftState>({ phase: 'idle' });
  const button = useRef<HTMLButtonElement>(null);
  // Older hosts without the composer API keep the editor-element fallback.
  const read = useCallback(() => hostDraft ?? (readComposer() ? composerText(readComposer()!) : ''), [hostDraft]);
  const write = useCallback((text: string) => {
    if (inputActions) inputActions.setDraft(text);
    else { const editor = readComposer(); if (editor) replaceComposer(editor, text); }
  }, [inputActions]);
  const latest = useRef({ read, write, state, english });
  latest.current = { read, write, state, english };

  const run = useCallback(async () => {
    const { read, write, state, english } = latest.current;
    if (state.phase === 'busy') return;
    if (state.phase === 'undo') { write(state.original); setState({ phase: 'idle' }); return; }
    const original = read().trim();
    if (!original || original.length > MAX_SOURCE_LENGTH) return;
    setState({ phase: 'busy' });
    try {
      const result = await translate(original, english ? 'en' : 'auto', loadSettings());
      // Never overwrite a draft edited while translation was in flight.
      if (latest.current.read().trim() !== original) { setState({ phase: 'idle' }); return; }
      latest.current.write(result.translation);
      setState({ phase: 'undo', original, translated: result.translation });
    } catch (error) {
      setState({ phase: 'error', error: error instanceof Error ? error.message : String(error) });
    }
  }, []);

  useEffect(() => {
    if (state.phase !== 'error') return;
    const timer = setTimeout(() => setState({ phase: 'idle' }), 4000);
    return () => clearTimeout(timer);
  }, [state]);
  useEffect(() => {
    if (state.phase === 'undo' && hostDraft !== undefined && hostDraft.trim() !== state.translated.trim()) setState({ phase: 'idle' });
  }, [hostDraft, state]);
  useEffect(() => {
    const entry = { scope: () => button.current?.closest('form') ?? button.current?.parentElement?.parentElement ?? null, run: () => void run() };
    if (shortcutTargets.size === 0) document.addEventListener('keydown', onShortcut);
    shortcutTargets.add(entry);
    return () => { shortcutTargets.delete(entry); if (shortcutTargets.size === 0) document.removeEventListener('keydown', onShortcut); };
  }, [run]);

  const label = state.phase === 'busy' ? ui('Translating…') : state.phase === 'undo' ? ui('Undo') : state.phase === 'error' ? localizeError(state.error) : ui('Translate');
  const title = state.phase === 'error' ? localizeError(state.error) : ui(english ? 'Translate draft to English (Alt/Option+T)' : 'Translate draft (Alt/Option+T)');
  return <button ref={button} type="button" data-dsh-translate-draft data-state={state.phase}
    data-dsh-translate-target={english ? 'en' : 'auto'} data-dsh-translate-busy={state.phase === 'busy' ? '' : undefined}
    data-dsh-translate-undo={state.phase === 'undo' ? state.original : undefined} data-dsh-translate-error={state.phase === 'error' ? state.error : undefined}
    className="dsh-translate-composer-button" title={title} aria-busy={state.phase === 'busy'}
    disabled={state.phase === 'busy' || (hostDraft !== undefined && state.phase !== 'undo' && !hostDraft.trim())} onClick={() => void run()}>
    <TranslateIcon /><span data-dsh-translate-label>{label}</span>{english && <span data-dsh-translate-lock aria-hidden="true">EN</span>}
  </button>;
}
export function apply(ctx: Client): void {
  ctx.effect(() => installLocale(ctx));
  ctx.effect(() => installStyles());
  ctx.effect(() => installTranslationDom());
  ctx.inject?.(['modelDirectories'], scoped => scoped.effect(() => {
    const service = scoped.modelDirectories;
    // Cordis may proxy service methods; model-directory stores retain their original receiver.
    setDirectories((service as unknown as Record<symbol, ModelDirectories | undefined>)[symbols.original] ?? service);
    return () => setDirectories(undefined);
  }));
  ctx.slots.inject('settings.section', () => { ctx.slots.register({ name: 'settings.section', id: 'translate', order: 72, label: () => ui('Translation') }, TranslationSettingsSection); });
  ctx.slots.inject('conversation.input.left', () => { ctx.slots.register({ name: 'conversation.input.left', id: 'translate', order: 60 }, (props: ComposerSlotProps) => <ComposerTranslateButton {...props} />); });
}
