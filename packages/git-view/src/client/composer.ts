/** DSH's composer actions, which the branch button's dock slot receives for its conversation. */
export interface InputActions { captureInsertion?(): unknown; insertText?(text: string, span: unknown): boolean; setDraft(text: string): void }
interface Composer { actions: InputActions; draft(): string }
const composers = new Map<string, Composer>();
/** Registered while a conversation's composer is mounted. */
export function registerComposer(sessionId: string, composer: Composer): () => void {
  composers.set(sessionId, composer);
  return () => { if (composers.get(sessionId) === composer) composers.delete(sessionId); };
}

/**
 * Adds text to a conversation's draft, after what is already there, as one undoable step that keeps reference chips.
 * Hosts without the composer actions get the text typed into the visible editor instead.
 */
export function sendToComposer(sessionId: string | undefined, text: string): boolean {
  const composer = sessionId ? composers.get(sessionId) : undefined;
  if (composer) {
    const draft = composer.draft(), next = draft.trim() ? `\n\n${text}` : text, { actions } = composer;
    if (actions.captureInsertion && actions.insertText && actions.insertText(next, actions.captureInsertion())) return true;
    actions.setDraft(draft.trim() ? `${draft}${next}` : text);
    return true;
  }
  return typeIntoEditor(text);
}
function typeIntoEditor(text: string): boolean {
  const editors = [...document.querySelectorAll<HTMLElement>('[data-lexical-editor="true"], [contenteditable="true"], textarea')].filter(e => e.getClientRects().length > 0);
  const editor = editors.find(e => e.closest('form, [data-composer], [class*="composer" i], [class*="input" i]')) ?? editors[0];
  if (!editor) return false;
  editor.focus();
  if (editor instanceof HTMLTextAreaElement) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    const next = editor.value.trim() ? `${editor.value}\n\n${text}` : text;
    if (setter) setter.call(editor, next); else editor.value = next;
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }
  const selection = window.getSelection(), range = document.createRange();
  range.selectNodeContents(editor); range.collapse(false);
  selection?.removeAllRanges(); selection?.addRange(range);
  const insert = (editor.textContent?.trim() ? '\n\n' : '') + text;
  if (!document.execCommand?.('insertText', false, insert)) editor.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: insert }));
  return true;
}
