// A stand-in for the editor bundle in jsdom tests: as much of Monaco's API as `CodeEditor` uses, over a plain string.
// `installFakeMonaco()` makes `loadMonaco` resolve to it. Tests edit through the model, as typing would:
// `editorOf(element)!.getModel()!.setValue(text)`.
import type { Monaco } from '../src/editor.js';

type Listener = () => void;
const event = () => {
  const listeners = new Set<Listener>();
  return { fire: () => { for (const listener of [...listeners]) listener(); }, on: (listener: Listener) => { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; } };
};
const LANGUAGES = [
  { id: 'plaintext', extensions: ['.txt'], aliases: ['Plain Text'] }, { id: 'typescript', extensions: ['.ts', '.tsx'], aliases: ['TypeScript'] },
  { id: 'javascript', extensions: ['.js', '.jsx'], aliases: ['JavaScript'] }, { id: 'markdown', extensions: ['.md'], aliases: ['Markdown'] },
  { id: 'json', extensions: ['.json'], aliases: ['JSON'] }, { id: 'ini', extensions: ['.ini'], aliases: ['Ini'] },
  { id: 'dockerfile', extensions: ['.dockerfile'], filenames: ['Dockerfile'], aliases: ['Dockerfile'] },
];

class FakeModel {
  private text: string;
  eol: '\n' | '\r\n';
  disposed = false;
  readonly content = event(); readonly options = event(); readonly language = event();
  constructor(value: string, public languageId: string) {
    this.text = value.replace(/\r\n?/g, '\n');
    // Like Monaco: the most common line ending.
    const crlf = value.match(/\r\n/g)?.length ?? 0;
    this.eol = crlf > (value.match(/\n/g)?.length ?? 0) / 2 ? '\r\n' : '\n';
  }
  getValue() { return this.text.split('\n').join(this.eol); }
  setValue(value: string) { this.text = value.replace(/\r\n?/g, '\n'); this.content.fire(); }
  /** Replaces the whole text: the only range `CodeEditor` edits. */
  pushEditOperations(_selections: unknown, edits: { text: string }[]) { this.setValue(edits[0].text); return null; }
  pushStackElement() {}
  getFullModelRange() { const lines = this.text.split('\n'); return { startLineNumber: 1, startColumn: 1, endLineNumber: lines.length, endColumn: lines.at(-1)!.length + 1 }; }
  getEOL() { return this.eol; }
  setEOL(sequence: number) { this.eol = sequence === 1 ? '\r\n' : '\n'; this.content.fire(); }
  getLineCount() { return this.text.split('\n').length; }
  getOptions() { return { tabSize: 4, insertSpaces: true }; }
  getLanguageId() { return this.languageId; }
  getValueLengthInRange() { return 0; }
  onDidChangeContent(listener: Listener) { return this.content.on(listener); }
  onDidChangeOptions(listener: Listener) { return this.options.on(listener); }
  onDidChangeLanguage(listener: Listener) { return this.language.on(listener); }
  dispose() { this.disposed = true; }
}

class FakeEditor {
  position = { lineNumber: 1, column: 1 };
  revealed?: number;
  disposed = false;
  readonly actions = new Map<string, { label: string; keybindings?: number[]; run(editor: FakeEditor): void }>();
  private readonly selection = event();
  constructor(private options: Record<string, unknown> & { model: FakeModel }) {}
  getModel() { return this.options.model; }
  getRawOptions() { return this.options; }
  updateOptions(options: Record<string, unknown>) { Object.assign(this.options, options); }
  addAction(action: { id: string; label: string; keybindings?: number[]; run(editor: FakeEditor): void }) { this.actions.set(action.id, action); return { dispose: () => this.actions.delete(action.id) }; }
  trigger(_source: string, id: string) { this.actions.get(id)?.run(this); }
  getPosition() { return this.position; }
  setPosition(position: { lineNumber: number; column: number }) { this.position = position; this.selection.fire(); }
  getSelections() { return [{ startLineNumber: this.position.lineNumber, startColumn: this.position.column, endLineNumber: this.position.lineNumber, endColumn: this.position.column }]; }
  revealLineInCenter(line: number) { this.revealed = line; }
  onDidChangeCursorSelection(listener: Listener) { return this.selection.on(listener); }
  focus() {}
  dispose() { this.disposed = true; }
}

/** A diff editor over two fake models; its line changes are the span between their common first and last lines. */
class FakeDiffEditor {
  disposed = false;
  models?: { original: FakeModel; modified: FakeModel };
  modifiedEditor?: FakeEditor;
  private readonly updated = event();
  constructor(private options: Record<string, unknown>) {}
  setModel(models: { original: FakeModel; modified: FakeModel }) {
    this.models = models;
    this.modifiedEditor = new FakeEditor({ ...this.options, model: models.modified });
    models.original.onDidChangeContent(() => this.updated.fire()); models.modified.onDidChangeContent(() => this.updated.fire());
    queueMicrotask(() => this.updated.fire());
  }
  getModel() { return this.models ?? null; }
  getModifiedEditor() { return this.modifiedEditor!; }
  getRawOptions() { return this.options; }
  updateOptions(options: Record<string, unknown>) { Object.assign(this.options, options); }
  getLineChanges() {
    const a = this.models!.original.getValue().split(/\r?\n/), b = this.models!.modified.getValue().split(/\r?\n/);
    let start = 0, endA = a.length, endB = b.length;
    while (start < endA && start < endB && a[start] === b[start]) start++;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
    if (start === endA && start === endB) return [];
    return [{ originalStartLineNumber: start + 1, originalEndLineNumber: endA > start ? endA : 0, modifiedStartLineNumber: start + 1, modifiedEndLineNumber: endB > start ? endB : 0 }];
  }
  onDidUpdateDiff(listener: Listener) { return this.updated.on(listener); }
  dispose() { this.disposed = true; }
}

export type { FakeDiffEditor, FakeEditor, FakeModel };
export interface FakeMonaco { theme?: string; editors: FakeEditor[]; diffs: FakeDiffEditor[]; models: FakeModel[] }
/** Makes every `CodeEditor` on the page use a fresh fake, and returns it. */
export function installFakeMonaco(): FakeMonaco {
  const state: FakeMonaco = { editors: [], diffs: [], models: [] };
  const monaco = {
    KeyMod: { CtrlCmd: 2048, Shift: 1024, Alt: 512 }, KeyCode: { KeyS: 49, KeyZ: 56 },
    languages: { getLanguages: () => LANGUAGES },
    editor: {
      EndOfLineSequence: { LF: 0, CRLF: 1 },
      createModel: (value: string, language: string) => { const model = new FakeModel(value, language); state.models.push(model); return model; },
      create: (_host: HTMLElement, options: Record<string, unknown> & { model: FakeModel }) => { const editor = new FakeEditor(options); state.editors.push(editor); return editor; },
      createDiffEditor: (_host: HTMLElement, options: Record<string, unknown>) => { const editor = new FakeDiffEditor(options); state.diffs.push(editor); return editor; },
      setTheme: (theme: string) => { state.theme = theme; },
      setModelLanguage: (model: FakeModel, language: string) => { if (model.languageId !== language) { model.languageId = language; model.language.fire(); } },
    },
  } as unknown as Monaco;
  (globalThis as { [key: symbol]: unknown })[Symbol.for('dsh-plugins.editor')] = { loading: Promise.resolve(monaco), monaco };
  return state;
}
