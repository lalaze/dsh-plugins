# File view

Private build-time React components shared by `dsh-file-editor` and `dsh-remote-agents`: VS Code's editor, Monaco, styled after DSH (`CodeEditor`), image and Markdown previews (`ImagePreview`, `MarkdownPreview`), and file-kind helpers (`languageOf`, `imageType`, `lineSeparatorOf`; also importable without the editor from `@dsh-plugins/file-view/kinds`). Client bundles include this code, so installed plugins do not depend on a published package.

Monaco is not in the client bundles. `scripts/build-editor.mjs` builds it, with its editor and JSON workers, its CSS and its Chinese messages, into one ES module that each plugin writes to `lib/editor.js` and serves from its own route; `CodeEditor` loads it from the URL in its `src` prop the first time an editor opens. Monaco keeps page-wide state, so the editors of both plugins share the first bundle loaded on a page, and that first load also fixes the language of Monaco's own menus (`locale`). CSS, HTML and TypeScript are highlighted but have no language services: their workers would add several megabytes and could not see the workspace's dependencies.

`CodeEditor` is controlled by `value`: user edits call `onChange`, and a different `value` from outside, such as a reload, replaces the text as one undoable step without calling it back. Give it a new `key` for another file so its undo history starts afresh. Documents whose line breaks are all CRLF are edited and returned with CRLF. The theme follows DSH's `data-ds-dark-theme` body attribute and the font its code font variables.

Tests run in jsdom against `@dsh-plugins/file-view/testing`, a stand-in for the parts of Monaco's API that `CodeEditor` uses.
