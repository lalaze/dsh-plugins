# File view

Private build-time React components shared by `dsh-file-editor` and `dsh-remote-agents`: a CodeMirror editor styled after DSH (`CodeEditor`), image and Markdown previews (`ImagePreview`, `MarkdownPreview`), and file-kind helpers (`languageOf`, `imageType`, `lineSeparatorOf`; also importable without the editor from `@dsh-plugins/file-view/kinds`). Client bundles include this code, so installed plugins do not depend on a published package.

`CodeEditor` is controlled by `value`: user edits call `onChange`, and a different `value` from outside, such as a reload, replaces the document without calling it back. Give it a new `key` for another file so its undo history starts afresh. Documents whose line breaks are all CRLF are edited and returned with CRLF. Token colors follow DSH's `data-ds-dark-theme` body attribute.

Heavy grammars (Rust, Go, Java, C/C++, SQL) use CodeMirror's stream modes to keep each client bundle smaller.
