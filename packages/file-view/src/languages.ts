import { StreamLanguage, type StreamParser } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { xml } from '@codemirror/lang-xml';
import { yaml } from '@codemirror/lang-yaml';
import { cpp, csharp, dart, java, kotlin, scala } from '@codemirror/legacy-modes/mode/clike';
import { go } from '@codemirror/legacy-modes/mode/go';
import { rust } from '@codemirror/legacy-modes/mode/rust';
import { standardSQL } from '@codemirror/legacy-modes/mode/sql';
import { diff } from '@codemirror/legacy-modes/mode/diff';
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile';
import { lua } from '@codemirror/legacy-modes/mode/lua';
import { perl } from '@codemirror/legacy-modes/mode/perl';
import { powerShell } from '@codemirror/legacy-modes/mode/powershell';
import { properties } from '@codemirror/legacy-modes/mode/properties';
import { r } from '@codemirror/legacy-modes/mode/r';
import { ruby } from '@codemirror/legacy-modes/mode/ruby';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { swift } from '@codemirror/legacy-modes/mode/swift';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { languageOf } from './kinds.js';

const stream = (parser: StreamParser<unknown>) => () => StreamLanguage.define(parser);
const LANGUAGES: Readonly<Record<string, () => Extension>> = {
  javascript: () => javascript(), jsx: () => javascript({ jsx: true }), typescript: () => javascript({ typescript: true }), tsx: () => javascript({ jsx: true, typescript: true }),
  python: () => python(), json: () => json(), markdown: () => markdown(), html: () => html(), css: () => css(), yaml: () => yaml(),
  xml: () => xml(),
  // Stream modes: these languages' full grammars would add about 280 KB to every client that bundles the editor.
  rust: stream(rust), go: stream(go), java: stream(java), cpp: stream(cpp), sql: stream(standardSQL),
  shell: stream(shell), toml: stream(toml), dockerfile: stream(dockerFile), ruby: stream(ruby), lua: stream(lua), swift: stream(swift),
  kotlin: stream(kotlin), scala: stream(scala), csharp: stream(csharp), dart: stream(dart), properties: stream(properties),
  powershell: stream(powerShell), perl: stream(perl), r: stream(r), diff: stream(diff),
};
/** Highlighting for a path, or none for plain text and unknown names. */
export function languageFor(path: string): Extension {
  return LANGUAGES[languageOf(path) ?? '']?.() ?? [];
}
