import React, { useEffect, useRef } from 'react';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { Annotation, Compartment, EditorState, Prec, type Extension } from '@codemirror/state';
import {
  crosshairCursor, drawSelection, dropCursor, EditorView, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars,
  keymap, lineNumbers, rectangularSelection,
} from '@codemirror/view';
import { classHighlighter } from '@lezer/highlight';
import { lineSeparatorOf } from './kinds.js';
import { languageFor } from './languages.js';
import { fileViewStyles } from './styles.js';

export interface CodeEditorProps {
  /** The text shown; a different value from outside (a reload or discarded edits) replaces the document. */
  value: string;
  onChange(value: string): void;
  /** Picks the highlighting. Give the component a new `key` for another file, so its undo history starts afresh. */
  path: string;
  /** The editable area's accessible name. */
  label: string;
  /** Still selectable, searchable and copyable, but not editable. */
  readOnly?: boolean;
  /** ⌘/Ctrl+S, which the editor keeps from the browser. */
  onSave?(): void;
  /** A 1-based line to show and put the cursor on, as from a `#L42` link. */
  line?: number;
  className?: string;
}

/** Changes the parent made, which it already knows about. */
const external = Annotation.define<boolean>();
const theme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'transparent', color: 'var(--dsw-alias-label-primary, inherit)', fontSize: 'var(--dsh-code-font-size, 13px)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--dsh-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)', lineHeight: '1.55' },
  '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--dsw-alias-label-tertiary, #8b8b8b)', border: 'none' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'color-mix(in srgb, currentColor 6%, transparent)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'currentColor' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--dsw-alias-state-business-primary, #3b82f6) 28%, transparent)',
  },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, #f5b400 35%, transparent)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'color-mix(in srgb, #f5b400 65%, transparent)' },
  '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, currentColor 10%, transparent)' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': { backgroundColor: 'color-mix(in srgb, currentColor 14%, transparent)', outline: 'none' },
  '.cm-foldPlaceholder': { backgroundColor: 'transparent', border: '1px solid color-mix(in srgb, currentColor 25%, transparent)', color: 'inherit' },
  '.cm-panels': { backgroundColor: 'var(--dsw-alias-bg-primary, Canvas)', color: 'inherit' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid color-mix(in srgb, currentColor 15%, transparent)' },
  '.cm-panel input, .cm-panel button': { font: 'inherit', color: 'inherit' },
  '.cm-textfield': { backgroundColor: 'transparent', border: '1px solid color-mix(in srgb, currentColor 25%, transparent)', borderRadius: '4px' },
  '.cm-button': { backgroundImage: 'none', backgroundColor: 'transparent', border: '1px solid color-mix(in srgb, currentColor 25%, transparent)', borderRadius: '4px' },
});
const base: Extension = [
  lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(), history(), foldGutter(), drawSelection(), dropCursor(),
  EditorState.allowMultipleSelections.of(true), indentOnInput(), syntaxHighlighting(classHighlighter), bracketMatching(), closeBrackets(),
  rectangularSelection(), crosshairCursor(), highlightActiveLine(), highlightSelectionMatches(),
  keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, indentWithTab]),
  theme,
];
/** CRLF files are split and saved on CRLF; everything else on LF, as the editor defaults to. */
const separatorFor = (text: string): Extension => { const separator = lineSeparatorOf(text); return separator ? EditorState.lineSeparator.of(separator) : []; };
const readOnlyFor = (readOnly: boolean): Extension => EditorState.readOnly.of(readOnly);

/** The editor showing in an element rendered by `CodeEditor`, for tests and integrations. */
export const editorOf = (element: Element): EditorView | null => EditorView.findFromDOM(element as HTMLElement);
/** A CodeMirror editor, styled after DSH and controlled by `value`. */
export function CodeEditor({ value, onChange, path, label, readOnly = false, onSave, line, className }: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null), view = useRef<EditorView>();
  const latest = useRef({ onChange, onSave });
  latest.current = { onChange, onSave };
  const parts = useRef({ language: new Compartment(), readOnly: new Compartment(), label: new Compartment() }).current;
  const stateFor = (text: string) => EditorState.create({ doc: text, extensions: [
    separatorFor(text), base, parts.language.of(languageFor(path)), parts.readOnly.of(readOnlyFor(readOnly)),
    parts.label.of(EditorView.contentAttributes.of({ 'aria-label': label })),
    Prec.highest(keymap.of([{ key: 'Mod-s', preventDefault: true, run: () => { latest.current.onSave?.(); return true; } }])),
    EditorView.updateListener.of(update => {
      if (update.docChanged && !update.transactions.some(tr => tr.annotation(external))) latest.current.onChange(update.state.sliceDoc());
    }),
  ] });
  useEffect(() => {
    const editor = new EditorView({ parent: host.current!, state: stateFor(value) });
    view.current = editor;
    return () => { editor.destroy(); view.current = undefined; };
  }, []);
  useEffect(() => {
    const editor = view.current;
    // `sliceDoc` joins lines with the document's own separator; `doc.toString()` always uses LF.
    const current = editor?.state.sliceDoc();
    if (!editor || current === value) return;
    // A reload may bring other line endings, which the document's separator is fixed to.
    if (lineSeparatorOf(value) !== lineSeparatorOf(current!)) editor.setState(stateFor(value));
    else editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value }, annotations: external.of(true) });
  }, [value]);
  useEffect(() => {
    const editor = view.current;
    if (!editor || !line || line < 1) return;
    const target = editor.state.doc.line(Math.min(line, editor.state.doc.lines));
    editor.dispatch({ selection: { anchor: target.from }, effects: EditorView.scrollIntoView(target.from, { y: 'center' }) });
  }, [line]);
  useEffect(() => { view.current?.dispatch({ effects: parts.language.reconfigure(languageFor(path)) }); }, [path]);
  useEffect(() => { view.current?.dispatch({ effects: parts.readOnly.reconfigure(readOnlyFor(readOnly)) }); }, [readOnly]);
  useEffect(() => { view.current?.dispatch({ effects: parts.label.reconfigure(EditorView.contentAttributes.of({ 'aria-label': label })) }); }, [label]);
  return <div className={['fv-code', className].filter(Boolean).join(' ')} ref={host}><style>{fileViewStyles}</style></div>;
}
