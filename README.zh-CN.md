# DSH Plugins

[English](README.md) | **简体中文**

用于开发多个 DeepSeek Harness 插件的 pnpm 大仓。每个插件独立维护包名、版本、清单、源码、测试、文档和安装包。

| 插件 | 目录 | 功能 |
| --- | --- | --- |
| `dsh-remote-agents` | [packages/remote-agents](packages/remote-agents/README.zh-CN.md) | DSH 原生对话与 SSH 远程任务分派：在远程机器上运行 Claude Code、Codex 等 CLI，随时干预，并让 DSH 直接分派任务 |
| `dsh-session-models` | [packages/session-models](packages/session-models/README.zh-CN.md) | 在侧栏会话前显示模型图标和状态徽标，悬停卡片显示具体模型 |
| `dsh-model-groups` | [packages/model-groups](packages/model-groups/README.zh-CN.md) | DSH 模型选择器中的提供方分组可折叠，并在各浏览器中记住选择 |
| `dsh-file-editor` | [packages/file-editor](packages/file-editor/README.zh-CN.md) | 以语法高亮编辑本地工作区的代码和文本文件，并预览 Markdown 与 SVG |
| `dsh-workspace-tags` | [packages/workspace-tags](packages/workspace-tags/README.zh-CN.md) | 为工作区添加彩色标签，侧栏可按标签或运行状态分组 |
| `dsh-usage-stats` | [packages/usage-stats](packages/usage-stats/README.zh-CN.md) | 统计 DSH 模型与 Claude SSH 远端调用的 Token 用量，支持筛选、分组和 CSV 导出 |
| `dsh-gallery` | [packages/gallery](packages/gallery/README.zh-CN.md) | 图库与 DSH 背景：Bing 每日壁纸、本地上传、固定壁纸、大图预览和背景效果调节 |
| `dsh-browser-devtools` | [packages/browser-devtools](packages/browser-devtools/README.zh-CN.md) | Chrome 风格元素、控制台和网络调试器，在 Chrome/Edge 独立窗口中打开 |
| `dsh-translate` | [packages/translate](packages/translate/README.zh-CN.md) | 在聊天选中文本或输入框草稿中调用 OpenAI 兼容接口进行翻译 |
| `dsh-auth-cookie-cleanup` | [packages/auth-cookie-cleanup](packages/auth-cookie-cleanup/README.zh-CN.md) | 临时修复 Desktop 启动约 70 次后无法打开：自动清理残留的按端口 `dsh-auth-*` cookie（deepseek-harness#10598） |

## 语言

插件界面支持英语和简体中文，以英语作为源文案和回退语言。宿主提供 DSH locale 服务时，插件跟随「设置 → 通用 → 语言」即时切换，包括已打开的面板和插件自身的错误提示；未提供该服务的旧宿主使用英语。API 诊断和 CSV 列名使用英语，用户内容、模型 ID 和命令语法保持原文。

私有的 `packages/i18n` 工具在构建时打入各客户端，插件安装包仍可独立安装。私有的 `packages/file-view`（代码编辑器与文件预览）以同样方式由 `dsh-file-editor` 和 `dsh-remote-agents` 共用。

## 初始化

需要 Node.js ≥ 22.15.0，pnpm **10.34.7**（已在 `package.json` 中锁定）。

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm check
corepack pnpm pack:plugins
```

如果已有对应版本的 pnpm，可直接使用 `pnpm`。依赖统一在仓库根目录安装，只维护根目录的 `pnpm-lock.yaml`。

## 开发命令

```sh
pnpm build          # 构建所有包
pnpm typecheck      # 检查所有包的类型
pnpm test           # 运行各包测试
pnpm check          # 类型检查、测试、构建
pnpm test:ui        # 运行已有的浏览器回归
pnpm pack:plugins   # 构建并打包，产物集中到 dist/
```

只操作某个插件：

```sh
pnpm --filter dsh-remote-agents check
pnpm --filter dsh-remote-agents pack:plugin
```

## 安装插件

运行 `pnpm --filter <包名> pack:plugin` 构建单个插件，或运行 `pnpm pack:plugins` 构建全部插件；安装包输出到 `dist/`，文件名为 `<包名>-<版本>.tgz`。各插件的 README 说明各自的要求，远程智能体每个版本的变化见其[更新日志](packages/remote-agents/CHANGELOG.zh-CN.md)。自 0.2.57 起，模型菜单提供方分组的折叠交给 `dsh-model-groups` 处理。

构建后按插件安装到目标 DSH profile：

```sh
pnpm pack:plugins
dsh plugin --profile web add "$PWD/dist/dsh-remote-agents-0.2.59.tgz"
```

桌面端请完全退出 DSH，使用桌面应用自带的 `dsh` 命令，将参数改为 `--profile desktop` 后安装并重新打开；npm 版 CLI 不能管理这个保留 profile。Web 端请重启更新的 profile 并刷新浏览器。插件目前未发布到 npm。仓库根目录是私有工作区，安装时应使用各插件的压缩包。

### 插件市场

`pnpm release:market` 构建全部插件，将可直接安装的包提交到 `market` 分支，并更新其中的 `index.json`：一份 DSH 插件市场索引，只列出每个插件的最新版本，并固定到对应提交。更早的版本不再列出，但仍可通过各自的提交安装。之后用 `git push origin market` 发布。发布要求工作区干净；索引中已有的版本会跳过，代码改动但未升级版本号的插件会给出提示。`--dry-run` 可预览。不要改写或强制推送 `market`，已安装版本依赖其中的提交。

在 DSH 中安装和更新：打开 **插件**，在实验插件中开启 **Custom plugin markets**，然后在 **Discover** 中添加索引地址：

```text
https://raw.githubusercontent.com/lalaze/dsh-plugins/market/index.json
```

有新版本时 Discover 会显示 **Update available**，点击后会打开已安装插件的详情页。当前 DSH 的第三方插件需先卸载旧版，再从市场或“添加插件”安装新版；已安装状态下不会提供安装按钮。DSH 只为官方插件提供一键更新。

## 目录与新增插件

```text
packages/
  remote-agents/        # dsh-remote-agents 的源码、测试、清单和文档
  session-models/       # 侧栏会话的模型图标与状态徽标
  model-groups/         # 模型选择器的提供方分组折叠
  file-editor/          # 本地工作区文件的代码编辑器
  file-view/            # 私有的共享代码编辑器与文件预览
  workspace-tags/       # 工作区标签，侧栏按标签或状态分组
  usage-stats/          # DSH 与 Claude SSH 使用量统计
  gallery/              # 本地图库、Bing 每日壁纸与 DSH 背景
  browser-devtools/     # 在独立窗口中打开的网页调试器
  translate/            # DSH 聊天选区与草稿翻译
  auth-cookie-cleanup/  # 残留 dsh-auth cookie 的临时修复
scripts/
  build-client.mjs      # 共用的 DSH Web 客户端打包脚本
tsconfig.base.json     # 共用 TypeScript 编译选项
pnpm-workspace.yaml    # 自动发现 packages/*
pnpm-lock.yaml         # 全仓依赖锁文件
dist/                  # 生成的安装包，不提交
```

后续插件放在 `packages/<插件目录>`，声明独立包名、版本及标准的 `build`、`typecheck`、`test` 命令，根目录命令会自动覆盖新包。公共工具放在根目录，插件专用依赖放在插件自己的清单中，各插件独立发布。

完整约定见[开发指南](docs/development.md)，包括插件清单、客户端构建、打包和共享代码处理。

MIT；第三方署名见对应插件文档。
