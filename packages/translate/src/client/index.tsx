import React, { useEffect } from 'react';
import type { LocaleContext } from '@dsh-plugins/i18n';
import { installTranslationDom, refreshDraftButton, replaceComposer, setDraftLabel, translateDraft } from './dom.js';
import { installLocale, ui, useLocale } from './i18n.js';
import { TranslationSettingsSection } from './settings.js';
import { installStyles } from './styles.js';

interface Client extends LocaleContext {
  effect(factory: () => () => void): void;
  slots: { inject(name: string, factory: () => void): unknown; register(spec: Record<string, unknown>, component: React.FC<any>): unknown };
}
export const name = 'dsh-translate-client';
export const inject = ['slots'];
// A translation mark in the host icon grid (16px box, 1px stroke).
function TranslateIcon() {
  return <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.1} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M1.5 3.5h7M5 2v1.5M3 3.5c.6 2.4 2.1 4.2 4.4 5.4M7 3.5C6.4 6.1 4.7 8.3 2 9.5M8.5 14l3-7 3 7M9.6 11.6h3.8" />
  </svg>;
}
function ComposerTranslateButton() {
  const locale = useLocale();
  useEffect(refreshDraftButton, [locale]);
  return <button type="button" data-dsh-translate-draft className="dsh-translate-composer-button" title={ui('Translate draft (Alt/Option+T)')} onClick={() => {
    const editor = document.querySelector<HTMLElement>('[data-composer-input], textarea[aria-label*="message" i], textarea[placeholder*="message" i], textarea[placeholder*="消息" i], [contenteditable="true"]');
    const button = document.querySelector<HTMLButtonElement>('[data-dsh-translate-draft]');
    if (button?.dataset.dshTranslateUndo && editor) { replaceComposer(editor, button.dataset.dshTranslateUndo); delete button.dataset.dshTranslateUndo; setDraftLabel(button, ui('Translate')); }
    else if (editor) void translateDraft(editor);
  }}><TranslateIcon /><span data-dsh-translate-label>{ui('Translate')}</span></button>;
}
export function apply(ctx: Client): void {
  ctx.effect(() => installLocale(ctx));
  ctx.effect(() => installStyles());
  ctx.effect(() => installTranslationDom());
  ctx.slots.inject('settings.section', () => { ctx.slots.register({ name: 'settings.section', id: 'translate', order: 72, label: () => ui('Translation') }, TranslationSettingsSection); });
  ctx.slots.inject('conversation.input.left', () => { ctx.slots.register({ name: 'conversation.input.left', id: 'translate', order: 60 }, () => <ComposerTranslateButton />); });
}
