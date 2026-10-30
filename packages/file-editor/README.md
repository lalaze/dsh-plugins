# DSH File Editor

**English** | [简体中文](README.zh-CN.md)

`dsh-file-editor` lets you edit code and text files of local workspaces in DeepSeek Harness's right sidebar. Open a file from **Workspace files**, ⌘P or a file link in the conversation; instead of DSH's read-only preview, it opens in VS Code's editor, [Monaco](https://github.com/microsoft/monaco-editor): syntax highlighting, a minimap, find and replace, multiple cursors, folding, word-based suggestions, the command palette (F1) and a status bar with the cursor position, indentation, line endings and language. Supports English and Simplified Chinese, following DSH's language setting, including the editor's own menus.

- **Saving:** **Save** or ⌘/Ctrl+S writes the file; **Revert** discards your edits. A save checks that the file is still the version you opened: if it changed on disk, for example because an agent edited it, the save is refused rather than overwriting that change.
- **Changes made elsewhere:** an open file without unsaved edits reloads by itself within about two seconds of changing on disk. With unsaved edits, the editor keeps them and says the file changed; **Reload** then shows the new version.
- **Previews:** Markdown and SVG files have an **Edit / Preview** switch. Markdown renders GitHub tables and task lists; raw HTML in it is shown as text. Images, PDFs, spreadsheets and other documents keep DSH's own preview.
- **Line endings and encoding:** files using CRLF stay CRLF, and a UTF-8 byte-order mark is kept. Files that are not UTF-8 text, or are larger than 4 MB, are not opened for editing.
- **Shortcuts:** as in VS Code. ⌘/Ctrl+S saves, F1 opens the command palette, ⌘/Ctrl+F finds, ⌥/Alt+Z toggles word wrap, and Ctrl+G, or clicking the cursor position in the status bar, goes to a line.
- **Languages:** Monaco's highlighting, among others for JavaScript, TypeScript and JSX, Python, JSON, Markdown, HTML, CSS, SCSS and Less, YAML, XML, Rust, Go, Java, C/C++, C#, SQL, shell, Dockerfile, Ruby, PHP, Swift, Kotlin, Lua, R, PowerShell and INI; TOML files use INI highlighting. JSON is also checked for errors, with comments allowed. Other text files, such as `.txt`, `Makefile` or `.gitignore`, open without highlighting. Type checking and completions from language servers are not included: the editor sees one file, not the project.
- **Loading:** the editor, about 1.5 MB compressed, is served by the plugin and loads the first time a file opens; later files open at once. If it cannot load, the tab says so and offers **Retry**.
- **Remote workspaces:** files of a `dsh-remote-agents` remote workspace open in its own remote editor, which uses the same editor.

The editor follows DSH's light and dark themes and its code font settings.

## Security

The editor validates paths and resolved symbolic links against the current conversation's workspace folder. This is intended for trusted local workspaces, not as a sandbox against processes that replace files or directories during an operation. Saves replace the file atomically and keep its permissions. The plugin's route answers only requests from its own client, and serves raw file bytes as a download that never renders in the page, so a workspace SVG cannot run script in DSH.

Revision checks reject disk changes already present at the check, but are not an atomic transaction with writes by other processes. A write between the check and replacement can still be overwritten; avoid saving the same file simultaneously in other programs.

## Install

```sh
pnpm --filter dsh-file-editor check
pnpm --filter dsh-file-editor pack:plugin
dsh plugin --profile web add "$PWD/dist/dsh-file-editor-0.2.0.tgz"
```

Requires Node.js ≥22.15.0 and DSH ≥0.2.1-rc.2, <0.3.0. Restart the profile and refresh the browser.

## Development

`pnpm --filter dsh-file-editor test` covers workspace containment, symbolic links, atomic and concurrent saves, the route's request checks, the editor bundle's route, and the editor tab with a simulated route and a stand-in for Monaco: loading, saving, refused stale saves, reloading after outside changes and Markdown previews. The editor itself lives in the private `packages/file-view` package, shared with `dsh-remote-agents`; the build writes its Monaco bundle to `lib/editor.js` with `scripts/build-editor.mjs`, and the plugin serves it at `/api/file-editor/editor.js`. Third-party licenses are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
