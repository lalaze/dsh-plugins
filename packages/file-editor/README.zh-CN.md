# DSH File Editor

[English](README.md) | **简体中文**

`dsh-file-editor` 让你在 DeepSeek Harness 右侧栏中编辑本地工作区的代码和文本文件。从「工作区文件」、⌘P 或对话中的文件链接打开文件时，不再显示 DSH 的只读预览，而是用 VS Code 的编辑器 [Monaco](https://github.com/microsoft/monaco-editor) 打开，铺满整个标签页，上方是显示路径和图标按钮的标题栏：语法高亮、缩略图、查找与替换、多光标、代码折叠、基于单词的补全、命令面板（F1），以及显示光标位置、缩进、换行符和语言的状态栏。支持英文和简体中文，跟随 DSH 的语言设置，编辑器自带的菜单也一样。

- **保存：**点击标题栏的「保存」按钮或按 ⌘/Ctrl+S 写入文件，「还原」放弃修改；路径后的圆点表示有未保存的修改。保存时会确认文件仍是打开时的版本：如果文件在磁盘上已被修改（例如被智能体编辑），保存会被拒绝，不会覆盖那次修改。
- **外部修改：**没有未保存修改时，文件在磁盘上变化后约两秒内自动重新加载。有未保存修改时，编辑器保留你的修改并提示文件已变化；点击「重新加载」查看新版本。
- **预览：**Markdown 和 SVG 文件的标题栏有「预览」按钮，可在源码和渲染效果之间切换。Markdown 支持 GitHub 表格和任务列表，其中的原始 HTML 按文本显示。图片、PDF、表格和其他文档仍由 DSH 自带的预览打开。
- **换行和编码：**CRLF 换行的文件保存后仍是 CRLF，UTF-8 BOM 会保留。非 UTF-8 文本或超过 4 MB 的文件不会以编辑方式打开。
- **快捷键：**与 VS Code 相同。⌘/Ctrl+S 保存，F1 打开命令面板，⌘/Ctrl+F 查找，⌥/Alt+Z 切换自动换行，Ctrl+G 或点击状态栏中的光标位置可转到指定行。
- **语言：**使用 Monaco 的语法高亮，包括 JavaScript、TypeScript 与 JSX、Python、JSON、Markdown、HTML、CSS、SCSS 与 Less、YAML、XML、Rust、Go、Java、C/C++、C#、SQL、Shell、Dockerfile、Ruby、PHP、Swift、Kotlin、Lua、R、PowerShell 和 INI 等；TOML 文件按 INI 高亮。JSON 还会检查错误，允许注释。`.txt`、`Makefile`、`.gitignore` 等其他文本文件不带高亮打开。不包含语言服务器提供的类型检查和补全：编辑器只看到单个文件，而不是整个项目。
- **加载：**编辑器约 1.5 MB（压缩后），由插件提供，在第一次打开文件时加载；之后打开文件不再等待。加载失败时标签页会提示，并提供「重试」。
- **远程工作区：**`dsh-remote-agents` 远程工作区的文件由它自己的远程编辑器打开，使用的是同一个编辑器。

编辑器跟随 DSH 的明暗主题和代码字体设置。

## 安全

编辑器会检查路径及解析后的符号链接是否位于当前对话的工作区文件夹内。这适用于可信本地工作区，不是防范其他进程在操作期间替换文件或目录的安全沙箱。保存以原子方式替换文件并保留其权限。插件的接口只响应来自它自己客户端的请求，原始文件内容以下载形式返回、不会在页面中渲染，因此工作区里的 SVG 无法在 DSH 中执行脚本。

版本校验会拒绝校验时已存在的磁盘修改，但无法与其他进程的写入形成原子事务；其他程序恰好在校验后、替换前写入时，仍可能发生覆盖。请避免同时保存同一文件。

## 0.2.2

同步构建 Git 视图所共用的编辑器集成。独立文件编辑器仍保持原有编辑和预览行为；Git 差异与冲突操作由独立的 `dsh-git-view` 插件提供。

## 安装

```sh
pnpm --filter dsh-file-editor check
pnpm --filter dsh-file-editor pack:plugin
dsh plugin --profile web add "$PWD/dist/dsh-file-editor-0.2.2.tgz"
```

需要 Node.js ≥22.15.0，DSH ≥0.2.1-rc.2 且 <0.3.0。重启该 profile 并刷新浏览器。

## 开发

`pnpm --filter dsh-file-editor test` 覆盖工作区边界、符号链接、原子写入与并发保存、接口的请求校验，编辑器包的接口，并用模拟接口和 Monaco 替身测试编辑器标签页：加载、保存、拒绝过期保存、外部修改后重新加载以及 Markdown 预览。编辑器本身位于私有的 `packages/file-view` 包，与 `dsh-remote-agents` 共用；构建时由 `scripts/build-editor.mjs` 把 Monaco 打包为 `lib/editor.js`，插件在 `/api/file-editor/editor.js` 提供它。第三方许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
