# DSH File Editor

**English** | [简体中文](README.zh-CN.md)

`dsh-file-editor` lets you edit code and text files of local workspaces in DeepSeek Harness's right sidebar. Open a file from **Workspace files**, ⌘P or a file link in the conversation; instead of DSH's read-only preview, it opens in a code editor with syntax highlighting, line numbers, search (⌘/Ctrl+F), bracket matching and folding. Supports English and Simplified Chinese, following DSH's language setting.

- **Saving:** **Save** or ⌘/Ctrl+S writes the file; **Revert** discards your edits. A save checks that the file is still the version you opened: if it changed on disk, for example because an agent edited it, the save is refused rather than overwriting that change.
- **Changes made elsewhere:** an open file without unsaved edits reloads by itself within about two seconds of changing on disk. With unsaved edits, the editor keeps them and says the file changed; **Reload** then shows the new version.
- **Previews:** Markdown and SVG files have an **Edit / Preview** switch. Markdown renders GitHub tables and task lists; raw HTML in it is shown as text. Images, PDFs, spreadsheets and other documents keep DSH's own preview.
- **Line endings and encoding:** files using CRLF stay CRLF, and a UTF-8 byte-order mark is kept. Files that are not UTF-8 text, or are larger than 4 MB, are not opened for editing.
- **Highlighting:** JavaScript, TypeScript and JSX, Python, JSON, Markdown, HTML, CSS, YAML and XML, plus Rust, Go, Java, C/C++, SQL, shell, TOML, Dockerfile, Ruby, Lua, Swift, Kotlin, Scala, C#, Dart, PowerShell, Perl, R, INI and diff. Other text files, such as `.txt`, `Makefile` or `.gitignore`, open without highlighting.
- **Remote workspaces:** files of a `dsh-remote-agents` remote workspace open in its own remote editor, which uses the same editor.

The editor follows DSH's light and dark themes and its code font settings.

## Security

The editor validates paths and resolved symbolic links against the current conversation's workspace folder. This is intended for trusted local workspaces, not as a sandbox against processes that replace files or directories during an operation. Saves replace the file atomically and keep its permissions. The plugin's route answers only requests from its own client, and serves raw file bytes as a download that never renders in the page, so a workspace SVG cannot run script in DSH.

Revision checks reject disk changes already present at the check, but are not an atomic transaction with writes by other processes. A write between the check and replacement can still be overwritten; avoid saving the same file simultaneously in other programs.

## Install

```sh
pnpm --filter dsh-file-editor check
pnpm --filter dsh-file-editor pack:plugin
dsh plugin --profile web add "$PWD/dist/dsh-file-editor-0.1.0.tgz"
```

Requires Node.js ≥22.15.0 and DSH ≥0.2.1-rc.2, <0.3.0. Restart the profile and refresh the browser.

## Development

`pnpm --filter dsh-file-editor test` covers workspace containment, symbolic links, atomic and concurrent saves, the route's request checks, and the editor tab with a simulated route: loading, saving, refused stale saves, reloading after outside changes and Markdown previews. The editor itself lives in the private `packages/file-view` package, shared with `dsh-remote-agents`. Third-party licenses are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
