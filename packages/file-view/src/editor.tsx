import React, { useEffect, useRef, useState } from 'react';
import type * as MonacoApi from 'monaco-editor';
import { languageOf, lineSeparatorOf } from './kinds.js';
import { fileViewStyles } from './styles.js';

export type Monaco = typeof MonacoApi;
export type EditorLocale = 'en' | 'zh';
export interface CodeEditorProps {
  /** The text shown; a different value from outside (a reload or discarded edits) replaces the document. */
  value: string;
  onChange(value: string): void;
  /** Picks the language. Give the component a new `key` for another file, so its undo history starts afresh. */
  path: string;
  /** The editable area's accessible name. */
  label: string;
  /** The editor bundle's URL, served by the plugin; see `loadMonaco`. */
  src: string;
  /** The language of the editor's own menus and widgets, which the first editor loaded on a page decides. */
  locale?: EditorLocale;
  /** Still selectable, searchable and copyable, but not editable. */
  readOnly?: boolean;
  /** ⌘/Ctrl+S, which the editor keeps from the browser. */
  onSave?(): void;
  /** A 1-based line to show and put the cursor on, as from a `#L42` link. */
  line?: number;
  className?: string;
}

const SLOT: unique symbol = Symbol.for('dsh-plugins.editor') as never, LOCALE: unique symbol = Symbol.for('dsh-plugins.editor.locale') as never;
type Scope = { [SLOT]?: { loading: Promise<Monaco>; monaco?: Monaco }; [LOCALE]?: EditorLocale };
/**
 * Loads the editor bundle `src` serves, once per page: Monaco keeps page-wide state, so the editors of every plugin
 * share the first bundle that loads. A host that serves `/api` only to `fetch` still gets it, through a blob URL.
 */
export function loadMonaco(src: string, locale: EditorLocale = 'en'): Promise<Monaco> {
  const scope = globalThis as Scope;
  if (scope[SLOT]) return scope[SLOT].loading;
  scope[LOCALE] = locale;
  const url = new URL(src, document.baseURI).href;
  const slot: NonNullable<Scope[typeof SLOT]> = { loading: (async () => {
    try { return await import(/* @vite-ignore */ url) as Monaco; }
    catch (error) {
      const response = await fetch(url, { credentials: 'same-origin' }).catch(() => undefined);
      if (!response?.ok) throw error;
      const blob = URL.createObjectURL(new Blob([await response.text()], { type: 'text/javascript' }));
      try { return await import(/* @vite-ignore */ blob) as Monaco; } finally { URL.revokeObjectURL(blob); }
    }
  })().then(monaco => { slot.monaco = monaco; return monaco; }, error => { if (scope[SLOT] === slot) delete scope[SLOT]; throw error; }) };
  scope[SLOT] = slot;
  return slot.loading;
}

const TEXT: Record<EditorLocale, Record<string, string>> = {
  en: {
    loading: 'Loading editor…', failed: 'The editor could not be loaded.', retry: 'Retry', position: 'Ln {line}, Col {column}', selected: '({count} selected)',
    spaces: 'Spaces: {size}', tabs: 'Tab Size: {size}', goTo: 'Go to Line/Column', save: 'File: Save', wrap: 'View: Toggle Word Wrap',
  },
  zh: {
    loading: '正在加载编辑器…', failed: '编辑器加载失败。', retry: '重试', position: '行 {line}，列 {column}', selected: '(已选择 {count})',
    spaces: '空格: {size}', tabs: '制表符长度: {size}', goTo: '转到行/列', save: '文件: 保存', wrap: '查看: 切换自动换行',
  },
};
const say = (locale: EditorLocale, key: string, params: Record<string, string | number> = {}) => TEXT[locale][key].replace(/\{(\w+)\}/g, (_, name: string) => String(params[name]));

/** Our kinds Monaco names differently or recognizes by none of its extensions. */
const KINDS: Readonly<Record<string, string>> = { jsx: 'javascript', tsx: 'typescript', properties: 'ini', toml: 'ini', text: 'plaintext' };
/** Monaco's language for a path: by its file names and extensions, then by ours. */
export function languageFor(monaco: Monaco, path: string): string {
  const name = path.split(/[\\/]/).pop()!.toLowerCase(), languages = monaco.languages.getLanguages();
  let best = '', length = 0;
  for (const language of languages) {
    if (language.filenames?.some(filename => filename.toLowerCase() === name)) return language.id;
    for (const extension of language.extensions ?? []) {
      if (extension.length > length && name.endsWith(extension.toLowerCase())) { best = language.id; length = extension.length; }
    }
  }
  if (best) return best;
  const kind = languageOf(path), id = kind && (KINDS[kind] ?? kind);
  return id && languages.some(language => language.id === id) ? id : 'plaintext';
}
/** DSH marks the body in dark mode; hosts without its theme marker follow the system. */
const dark = () => document.body.hasAttribute('data-ds-dark-theme')
  || (!document.body.hasAttribute('data-ds-theme-source') && !!globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches);
const themeOf = () => dark() ? 'vs-dark' : 'vs';
/** Monaco's theme is page-wide; while editors are open it follows DSH's. */
function followTheme(monaco: Monaco): () => void {
  const apply = () => monaco.editor.setTheme(themeOf());
  const observer = new MutationObserver(apply), media = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
  observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'data-ds-theme-source'] });
  media?.addEventListener?.('change', apply);
  return () => { observer.disconnect(); media?.removeEventListener?.('change', apply); };
}

interface Status { line: number; column: number; selected: number; tabSize: number; spaces: boolean; eol: string; language: string }
const editors = new WeakMap<Element, MonacoApi.editor.IStandaloneCodeEditor>();
/** The editor showing in an element rendered by `CodeEditor`, for tests and integrations. */
export const editorOf = (element: Element): MonacoApi.editor.IStandaloneCodeEditor | undefined => editors.get(element);

/** VS Code's editor, loaded on demand, following DSH's theme and code font and controlled by `value`. */
export function CodeEditor({ value, onChange, path, label, src, locale = 'en', readOnly = false, onSave, line, className }: CodeEditorProps) {
  const root = useRef<HTMLDivElement>(null), host = useRef<HTMLDivElement>(null);
  const [editor, setEditor] = useState<MonacoApi.editor.IStandaloneCodeEditor>();
  const [failed, setFailed] = useState(false), [attempt, setAttempt] = useState(0), [status, setStatus] = useState<Status>();
  const latest = useRef({ value, onChange, onSave, path, label, readOnly, line, locale });
  latest.current = { value, onChange, onSave, path, label, readOnly, line, locale };
  /** The text the model last reported or was given, so the parent's echo of it changes nothing. */
  const known = useRef<string>(value), external = useRef(false), monacoRef = useRef<Monaco>();

  useEffect(() => {
    let disposed = false, cleanup = () => {};
    setFailed(false);
    loadMonaco(src, locale).then(monaco => {
      if (disposed) return;
      monacoRef.current = monaco;
      const props = latest.current, style = getComputedStyle(root.current!);
      const fontFamily = style.getPropertyValue('--dsh-font-family-code').trim(), fontSize = parseFloat(style.getPropertyValue('--dsh-code-font-size')) || 13;
      const model = monaco.editor.createModel(props.value, languageFor(monaco, props.path));
      // Monaco takes the most common line ending; CRLF files are those whose line breaks all are. Nothing is undone yet.
      model.setEOL(eolOf(monaco, props.value));
      known.current = props.value;
      monaco.editor.setTheme(themeOf());
      const created = monaco.editor.create(host.current!, {
        model, ariaLabel: props.label, readOnly: props.readOnly, automaticLayout: true, fixedOverflowWidgets: true,
        fontSize, ...fontFamily ? { fontFamily } : {}, minimap: { enabled: true }, stickyScroll: { enabled: true }, wordWrap: 'off',
      });
      let wrapped = false;
      created.addAction({ id: 'dsh.save', label: say(props.locale, 'save'), keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS], run: () => { latest.current.onSave?.(); } });
      created.addAction({ id: 'dsh.toggleWordWrap', label: say(props.locale, 'wrap'), keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.KeyZ],
        run: target => { wrapped = !wrapped; target.updateOptions({ wordWrap: wrapped ? 'on' : 'off' }); } });
      const report = () => {
        const position = created.getPosition(), options = model.getOptions();
        const selected = created.getSelections()?.reduce((sum, selection) => sum + model.getValueLengthInRange(selection), 0) ?? 0;
        const id = model.getLanguageId(), language = monaco.languages.getLanguages().find(l => l.id === id);
        setStatus({ line: position?.lineNumber ?? 1, column: position?.column ?? 1, selected, tabSize: options.tabSize, spaces: options.insertSpaces,
          eol: model.getEOL() === '\r\n' ? 'CRLF' : 'LF', language: language?.aliases?.[0] ?? id });
      };
      const subscriptions = [
        model.onDidChangeContent(() => {
          if (external.current) return;
          known.current = model.getValue();
          latest.current.onChange(known.current);
        }),
        created.onDidChangeCursorSelection(report), model.onDidChangeOptions(report), model.onDidChangeLanguage(report), model.onDidChangeContent(report),
      ];
      const theme = followTheme(monaco), element = root.current!;
      editors.set(element, created);
      if (props.line) reveal(created, props.line);
      report();
      setEditor(created);
      cleanup = () => {
        for (const subscription of subscriptions) subscription.dispose();
        theme(); editors.delete(element); created.dispose(); model.dispose();
      };
    }, () => { if (!disposed) setFailed(true); });
    return () => { disposed = true; cleanup(); setEditor(undefined); };
  }, [src, attempt]);
  useEffect(() => {
    const model = editor?.getModel(), monaco = monacoRef.current;
    if (!model || !monaco || value === known.current) return;
    known.current = value;
    external.current = true;
    try {
      // A reload may bring other line endings, which Monaco would convert to the model's.
      if (model.getEOL() !== (lineSeparatorOf(value) ?? '\n')) { model.setValue(value); model.setEOL(eolOf(monaco, value)); }
      // Otherwise the replacement is a step of its own to undo, as in VS Code.
      else {
        model.pushStackElement();
        model.pushEditOperations(editor!.getSelections(), [{ range: model.getFullModelRange(), text: value }], () => null);
        model.pushStackElement();
      }
    } finally { external.current = false; }
  }, [editor, value]);
  useEffect(() => { if (editor && line && line > 0) reveal(editor, line); }, [editor, line]);
  useEffect(() => {
    const model = editor?.getModel(), monaco = monacoRef.current;
    if (model && monaco) monaco.editor.setModelLanguage(model, languageFor(monaco, path));
  }, [editor, path]);
  useEffect(() => { editor?.updateOptions({ readOnly, ariaLabel: label }); }, [editor, readOnly, label]);

  const t = (key: string, params?: Record<string, string | number>) => say(locale, key, params);
  return <div className={['fv-code', className].filter(Boolean).join(' ')} ref={root} data-loaded={editor ? '' : undefined}><style>{fileViewStyles}</style>
    {/* Monaco's theme colors are variables on its components; its context menu, in a shadow root here, inherits them. */}
    <div className="fv-code-host monaco-component" ref={host} />
    {!editor && (failed
      ? <p className="fv-code-note" role="alert">{t('failed')} <button type="button" onClick={() => setAttempt(attempt + 1)}>{t('retry')}</button></p>
      : <p className="fv-code-note" role="status">{t('loading')}</p>)}
    {editor && status && <div className="fv-status">
      <button type="button" title={t('goTo')} onClick={() => { editor.focus(); editor.trigger('status', 'editor.action.gotoLine', null); }}>
        {t('position', { line: status.line, column: status.column })}{status.selected > 0 && ` ${t('selected', { count: status.selected })}`}
      </button>
      <span>{t(status.spaces ? 'spaces' : 'tabs', { size: status.tabSize })}</span><span>UTF-8</span><span>{status.eol}</span><span>{status.language}</span>
    </div>}
  </div>;
}

const eolOf = (monaco: Monaco, text: string) => lineSeparatorOf(text) ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF;
function reveal(editor: MonacoApi.editor.IStandaloneCodeEditor, line: number) {
  const target = Math.min(line, editor.getModel()?.getLineCount() ?? line);
  editor.setPosition({ lineNumber: target, column: 1 });
  editor.revealLineInCenter(target);
}
