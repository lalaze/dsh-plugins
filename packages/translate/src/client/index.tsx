import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { LocaleContext } from '@dsh-plugins/i18n';
import { MAX_SOURCE_LENGTH } from '../rpc.js';
import { loadSettings, translate } from './api.js';
import { composerText, installTranslationDom, readComposer, replaceComposer } from './dom.js';
import { installLocale, localizeError, ui, useLocale } from './i18n.js';
import { TranslationSettingsSection } from './settings.js';

interface Client extends LocaleContext {
  effect(factory: () => () => void): void;
  slots: { inject(name: string, factory: () => void): unknown; register(spec: Record<string, unknown>, component: React.FC<any>): unknown };
}
/** What DSH hands every session-scoped composer slot: the draft setter and a selector over the composer state. */
interface ComposerSlotProps {
  inputActions?: { setDraft(text: string): void };
  useInput?: <T>(select: (state: { draft: string }) => T) => T;
}
type DraftState = { phase: 'idle' } | { phase: 'busy' } | { phase: 'undo'; original: string; translated: string } | { phase: 'error'; error: string };

export const name = 'dsh-translate-client';
export const inject = ['slots'];

// Alt/Option+T goes to the composer that holds focus, or the only one when a single composer is mounted.
const shortcutTargets = new Set<{ scope: () => Element | null; run: () => void }>();
function onShortcut(event: KeyboardEvent) {
  if (!event.altKey || event.code !== 'KeyT' && event.key.toLowerCase() !== 't') return;
  const targets = [...shortcutTargets];
  const target = targets.length === 1 ? targets[0] : targets.find(entry => entry.scope()?.contains(document.activeElement));
  if (!target) return;
  event.preventDefault();
  target.run();
}

function ComposerTranslateButton({ inputActions, useInput }: ComposerSlotProps) {
  useLocale();
  const hostDraft = useInput?.(state => state.draft);
  const [state, setState] = useState<DraftState>({ phase: 'idle' });
  const button = useRef<HTMLButtonElement>(null);
  // Older hosts do not pass the composer API; read and write the editor element directly there.
  const read = useCallback(() => hostDraft ?? (readComposer() ? composerText(readComposer()!) : ''), [hostDraft]);
  const write = useCallback((text: string) => {
    if (inputActions) inputActions.setDraft(text);
    else { const editor = readComposer(); if (editor) replaceComposer(editor, text); }
  }, [inputActions]);
  const latest = useRef({ read, write, state });
  latest.current = { read, write, state };

  const run = useCallback(async () => {
    const { read, write, state } = latest.current;
    if (state.phase === 'busy') return;
    if (state.phase === 'undo') { write(state.original); setState({ phase: 'idle' }); return; }
    const original = read().trim();
    if (!original || original.length > MAX_SOURCE_LENGTH) return;
    setState({ phase: 'busy' });
    try {
      const result = await translate(original, 'auto', loadSettings());
      // A draft edited while the request ran belongs to the person, not to the translation.
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
  // Typing over a translated draft makes Undo meaningless.
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
  const title = state.phase === 'error' ? localizeError(state.error) : ui('Translate draft (Alt/Option+T)');
  return <button ref={button} type="button" data-dsh-translate-draft data-state={state.phase} className="dsh-translate-composer-button" title={title} aria-busy={state.phase === 'busy'}
    disabled={state.phase === 'busy' || (hostDraft !== undefined && state.phase !== 'undo' && !hostDraft.trim())} onClick={() => void run()}>{label}</button>;
}
export function apply(ctx: Client): void {
  ctx.effect(() => installLocale(ctx));
  ctx.effect(() => installTranslationDom());
  ctx.slots.inject('settings.section', () => { ctx.slots.register({ name: 'settings.section', id: 'translate', order: 72, label: () => ui('Translation') }, TranslationSettingsSection); });
  ctx.slots.inject('conversation.input.left', () => { ctx.slots.register({ name: 'conversation.input.left', id: 'translate', order: 60 }, (props: ComposerSlotProps) => <ComposerTranslateButton inputActions={props.inputActions} useInput={props.useInput} />); });
}
