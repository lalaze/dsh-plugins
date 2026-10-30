import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { installFakeMonaco, type FakeEditor, type FakeMonaco } from './fake-monaco.js';

let root: Root | undefined, container: HTMLElement, fake: FakeMonaco;
const globals = ['window', 'document', 'navigator', 'MutationObserver', 'getComputedStyle', 'Node', 'Element', 'HTMLElement', 'Event'] as const;
beforeEach(() => {
  const { window } = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/', pretendToBeVisual: true });
  for (const name of globals) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === 'window' ? window : (window as unknown as Record<string, unknown>)[name] });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.append(container);
  fake = installFakeMonaco();
});
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined;
  for (const name of globals) delete (globalThis as Record<string, unknown>)[name];
});

const settle = () => act(async () => { for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve)); });
async function mount(element: React.ReactElement) {
  const { createRoot } = await import('react-dom/client');
  root = createRoot(container);
  await act(async () => root!.render(element)); await settle();
  const { editorOf } = await import('../src/editor.js');
  return () => editorOf(container.querySelector('.fv-code')!) as unknown as FakeEditor;
}
const props = { onChange: () => {}, label: 'Contents', src: '/api/test/editor.js' };

test('edits report the new text, while a value from outside replaces the document without echoing back', async () => {
  const { CodeEditor } = await import('../src/editor.js');
  const changes: string[] = [];
  const editor = await mount(<CodeEditor {...props} value={'const a = 1;\n'} onChange={value => changes.push(value)} path="a.ts" />);
  const model = editor().getModel();
  assert.equal(model.getValue(), 'const a = 1;\n');
  assert.equal(editor().getRawOptions().ariaLabel, 'Contents');
  assert.equal(model.getLanguageId(), 'typescript');
  await act(async () => model.setValue('// x\nconst a = 1;\n'));
  assert.deepEqual(changes, ['// x\nconst a = 1;\n']);
  await act(async () => root!.render(<CodeEditor {...props} value="reloaded" onChange={value => changes.push(value)} path="a.ts" />));
  assert.equal(model.getValue(), 'reloaded');
  assert.equal(changes.length, 1, 'the parent is not told about its own value');
});

test('CRLF files stay CRLF, and mixed or LF files are edited as LF, including after a reload brings other line endings', async () => {
  const { CodeEditor } = await import('../src/editor.js');
  let latest = '';
  const editor = await mount(<CodeEditor {...props} value={'a\r\nb\r\n'} onChange={value => { latest = value; }} path="a.txt" />);
  const model = editor().getModel();
  await act(async () => model.setValue('a\nb\nc'));
  assert.equal(latest, 'a\r\nb\r\nc');
  await act(async () => root!.render(<CodeEditor {...props} value={'x\ny\r\nz\r\n'} onChange={value => { latest = value; }} path="a.txt" />));
  assert.equal(model.getValue(), 'x\ny\nz\n');
  assert.equal(latest, 'a\r\nb\r\nc', 'a reload is not reported as an edit');
  assert.equal(container.querySelector('.fv-status')!.textContent!.includes('LF'), true);
});

test('Mod-S saves, also read-only, and the status bar shows the cursor, indentation, line ending and language', async () => {
  const { CodeEditor } = await import('../src/editor.js');
  let saves = 0;
  const editor = await mount(<CodeEditor {...props} value="text" onSave={() => saves++} path="notes.md" readOnly />);
  const save = editor().actions.get('dsh.save')!;
  assert.deepEqual(save.keybindings, [2048 | 49], '⌘/Ctrl+S');
  await act(async () => editor().trigger('keyboard', 'dsh.save'));
  assert.equal(saves, 1);
  assert.equal(editor().getRawOptions().readOnly, true);
  await act(async () => root!.render(<CodeEditor {...props} value="text" onSave={() => saves++} path="notes.md" />));
  assert.equal(editor().getRawOptions().readOnly, false);
  assert.equal([...container.querySelectorAll('.fv-status > *')].map(item => item.textContent).join(' | '), 'Ln 1, Col 1 | Spaces: 4 | UTF-8 | LF | Markdown');
  await act(async () => editor().trigger('keyboard', 'dsh.toggleWordWrap'));
  assert.equal(editor().getRawOptions().wordWrap, 'on');
});

test('a line from a link gets the cursor and is shown', async () => {
  const { CodeEditor } = await import('../src/editor.js');
  const editor = await mount(<CodeEditor {...props} value={'one\ntwo\nthree\n'} path="a.txt" line={3} />);
  assert.equal(editor().getPosition().lineNumber, 3);
  assert.equal(editor().revealed, 3);
  assert.match(container.querySelector('.fv-status')!.textContent!, /Ln 3, Col 1/);
});

test('the editor follows DSH’s theme and its own labels follow the locale', async () => {
  const { CodeEditor } = await import('../src/editor.js');
  document.body.setAttribute('data-ds-theme-source', 'user');
  const editor = await mount(<CodeEditor {...props} value="" path="a.txt" locale="zh" />);
  assert.equal(fake.theme, 'vs');
  await act(async () => { document.body.setAttribute('data-ds-dark-theme', ''); await Promise.resolve(); });
  assert.equal(fake.theme, 'vs-dark');
  assert.equal(editor().actions.get('dsh.save')!.label, '文件: 保存');
  assert.match(container.querySelector('.fv-status')!.textContent!, /行 1，列 1/);
});

test('unmounting disposes the editor and its model', async () => {
  const { CodeEditor } = await import('../src/editor.js');
  await mount(<React.StrictMode><CodeEditor {...props} value="x" path="a.txt" /></React.StrictMode>);
  await act(async () => root!.unmount()); root = undefined;
  assert.ok(fake.editors.length >= 1);
  assert.ok(fake.editors.every(editor => editor.disposed) && fake.models.every(model => model.disposed));
});

test('languages come from Monaco’s file names and extensions, then from this package’s kinds', async () => {
  const { languageFor, loadMonaco } = await import('../src/editor.js');
  const monaco = await loadMonaco('/api/test/editor.js');
  assert.equal(languageFor(monaco, 'src/App.TSX'), 'typescript');
  assert.equal(languageFor(monaco, 'docker/Dockerfile'), 'dockerfile');
  assert.equal(languageFor(monaco, 'docker/Dockerfile.dev'), 'dockerfile');
  assert.equal(languageFor(monaco, 'pyproject.toml'), 'ini');
  assert.equal(languageFor(monaco, 'settings.jsonc'), 'json');
  assert.equal(languageFor(monaco, 'Makefile'), 'plaintext');
});

test('a bundle that fails to load can be retried', async () => {
  const { CodeEditor } = await import('../src/editor.js');
  const slot = Symbol.for('dsh-plugins.editor'), scope = globalThis as { [key: symbol]: unknown };
  const working = scope[slot];
  scope[slot] = { loading: Promise.reject(new Error('offline')) };
  (scope[slot] as { loading: Promise<unknown> }).loading.catch(() => {});
  await mount(<CodeEditor {...props} value="x" path="a.txt" />);
  const alert = container.querySelector('[role=alert]')!;
  assert.match(alert.textContent!, /could not be loaded/);
  scope[slot] = working;
  await act(async () => alert.querySelector('button')!.click()); await settle();
  assert.equal(container.querySelector('[role=alert]'), null);
  assert.ok(container.querySelector('.fv-code[data-loaded]'));
});

test('the diff editor compares the original with editable text, counts changed lines and follows its options', async () => {
  const { DiffEditor, diffEditorOf } = await import('../src/editor.js');
  const changes: string[] = [], stats: { added: number; removed: number }[] = [];
  let saved = 0;
  const view = (modified: string, options: Partial<React.ComponentProps<typeof DiffEditor>> = {}) => <DiffEditor label="Working tree" src="/api/test/editor.js" path="a.ts"
    original={'a\nb\nc\n'} modified={modified} onChange={value => changes.push(value)} onStats={value => stats.push(value)} onSave={() => saved++} {...options} />;
  await mount(view('a\nB\nnew\nc\n'));
  const diff = diffEditorOf(container.querySelector('.fv-diff')!) as unknown as typeof fake.diffs[number];
  assert.equal(fake.diffs.length, 1);
  assert.deepEqual(diff.getRawOptions(), { ...diff.getRawOptions(), originalEditable: false, renderSideBySide: true, wordWrap: 'off', modifiedAriaLabel: 'Working tree' });
  assert.deepEqual(stats.at(-1), { added: 2, removed: 1 });
  const modified = diff.getModel()!.modified;
  assert.equal(modified.getLanguageId(), 'typescript');
  await act(async () => modified.setValue('a\nb\nc\n'));
  assert.deepEqual([changes, stats.at(-1)], [['a\nb\nc\n'], { added: 0, removed: 0 }]);
  diff.getModifiedEditor().trigger('keyboard', 'dsh.save');
  assert.equal(saved, 1);
  await act(async () => root!.render(view('reloaded\n', { sideBySide: false, wrap: true, collapseUnchanged: false, fontSize: 15 })));
  assert.equal(modified.getValue(), 'reloaded\n');
  assert.equal(changes.length, 1, 'a value from outside is not reported as an edit');
  assert.deepEqual([diff.getRawOptions().renderSideBySide, diff.getRawOptions().wordWrap, (diff.getRawOptions().hideUnchangedRegions as { enabled: boolean }).enabled, diff.getRawOptions().fontSize],
    [false, 'on', false, 15]);
});
