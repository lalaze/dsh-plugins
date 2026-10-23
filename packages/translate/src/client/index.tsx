import React from 'react';
import { installTranslationDom, replaceComposer, translateDraft } from './dom.js';
import { ui } from './i18n.js';
import { TranslationSettingsSection } from './settings.js';

interface Client {
  effect(factory: () => () => void): void;
  slots: { inject(name: string, factory: () => void): unknown; register(spec: Record<string, unknown>, component: React.FC<any>): unknown };
}
export const name = 'dsh-translate-client';
export const inject = ['slots'];
function ComposerTranslateButton() {
  return <button type="button" data-dsh-translate-draft className="dsh-translate-composer-button" title={ui('Translate draft (Alt/Option+T)', '翻译草稿（Alt/Option+T）')} onClick={() => {
    const editor = document.querySelector<HTMLElement>('[data-composer-input], textarea[aria-label*="message" i], textarea[placeholder*="message" i], textarea[placeholder*="消息" i], [contenteditable="true"]');
    const button = document.querySelector<HTMLButtonElement>('[data-dsh-translate-draft]');
    if (button?.dataset.dshTranslateUndo && editor) { replaceComposer(editor, button.dataset.dshTranslateUndo); delete button.dataset.dshTranslateUndo; button.textContent = ui('Translate', '译'); }
    else if (editor) void translateDraft(editor);
  }}>{ui('Translate', '译')}</button>;
}
export function apply(ctx: Client): void {
  ctx.effect(() => installTranslationDom());
  ctx.slots.inject('settings.section', () => { ctx.slots.register({ name: 'settings.section', id: 'translate', order: 72, label: () => '翻译' }, TranslationSettingsSection); });
  ctx.slots.inject('conversation.input.left', () => { ctx.slots.register({ name: 'conversation.input.left', id: 'translate', order: 60 }, () => <ComposerTranslateButton />); });
}
