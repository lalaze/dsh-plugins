# DSH Plugins

[English](README.md) | **简体中文**

用于开发多个 DeepSeek Harness 插件的 pnpm 大仓。每个插件独立维护包名、版本、清单、源码、测试、文档和安装包。

**其中 `dsh-claude-ssh` 是基于 [Oh My Claude](https://github.com/lcestou/dsh-oh-my-claude) 1.5.5 修改的版本。** 本插件沿用上游的 Claude Code 接入实现，在此基础上增加远程工作区验证与路由、按工作区显示模型，以及 DSH 兼容性修复。感谢 Oh My Claude 作者提供原始实现。具体上游提交、许可与署名见[来源说明](packages/claude-ssh/UPSTREAM.md)和[第三方声明](packages/claude-ssh/THIRD_PARTY_NOTICES.md)。

| 插件 | 目录 | 功能 |
| --- | --- | --- |
| `dsh-claude-ssh` | [packages/claude-ssh](packages/claude-ssh/README.zh-CN.md) | 在 DSH 中通过系统 OpenSSH 使用远端 Claude Code |
| `dsh-remote-agents` | [packages/remote-agents](packages/remote-agents/README.zh-CN.md) | 合并完整 Claude SSH 接入；DSH 直接通过 SSH 选择远程机器、CLI 和模型，管理任务、审批与恢复 |
| `dsh-usage-stats` | [packages/usage-stats](packages/usage-stats/README.zh-CN.md) | 统计 DSH 模型与 Claude SSH 远端调用的 Token 用量，支持筛选、分组和 CSV 导出 |
| `dsh-gallery` | [packages/gallery](packages/gallery/README.zh-CN.md) | 图库与 DSH 背景：Bing 每日壁纸、本地上传、固定壁纸、大图预览和背景效果调节 |
| `dsh-magpie-fast` | [packages/magpie-fast](packages/magpie-fast/README.zh-CN.md) | 仅 GPT 显示的闪电开关，沿用已有提供商为远端 Magpie 等请求开启 Fast |
| `dsh-magpie-quota` | [packages/magpie-quota](packages/magpie-quota/README.zh-CN.md) | 输入框旁的账号额度图标、窗口明细、重置时间和单账号刷新 |
| `dsh-browser-devtools` | [packages/browser-devtools](packages/browser-devtools/README.zh-CN.md) | Sidebar Browser 网页内的元素、Console 和网络调试浮窗 |
| `dsh-translate` | [packages/translate](packages/translate/README.zh-CN.md) | 在聊天选中文本或输入框草稿中调用 OpenAI 兼容接口进行翻译 |

## 语言

插件界面支持英语和简体中文，以英语作为源文案和回退语言。宿主提供 DSH locale 服务时，插件跟随「设置 → 通用 → 语言」即时切换，包括已打开的面板和插件自身的错误提示；未提供该服务的旧宿主使用英语。API 诊断和 CSV 列名使用英语，用户内容、模型 ID 和命令语法保持原文。

私有的 `packages/i18n` 工具在构建时打入各客户端，插件安装包仍可独立安装。

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
pnpm --filter dsh-claude-ssh check
pnpm --filter dsh-claude-ssh pack:plugin
```

Claude 的 check 包含模板回归与远程工作区兼容测试。离线测试和真实运行验收的区别见[插件文档](packages/claude-ssh/README.zh-CN.md#开发与验收)。

## 安装插件

远程任务合并插件可直接下载 [Remote Agents 0.4.1 安装包](https://github.com/lalaze/dsh-plugins/releases/download/remote-agents-v0.4.1/dsh-remote-agents-0.4.1.tgz)，无需构建。跨机器安装命令与原 Claude 插件迁移步骤见[安装说明](packages/remote-agents/README.zh-CN.md#安装与原-claude-插件迁移)。

构建后按插件安装到目标 DSH profile：

```sh
pnpm pack:plugins
dsh plugin --profile web add "$PWD/dist/dsh-claude-ssh-0.3.2.tgz"
```

桌面端请完全退出 DSH，使用桌面应用自带的 `dsh` 命令，将参数改为 `--profile desktop` 后安装并重新打开；npm 版 CLI 不能管理这个保留 profile。Web 端请重启更新的 profile 并刷新浏览器。插件目前未发布到 npm。仓库根目录是私有工作区，安装时应使用各插件的压缩包。

## 目录与新增插件

```text
packages/
  claude-ssh/           # dsh-claude-ssh 的源码、测试、清单和文档
  usage-stats/          # DSH 与 Claude SSH 使用量统计
  gallery/              # 本地图库、Bing 每日壁纸与 DSH 背景
  magpie-fast/          # 现有 GPT 模型的 Fast 闪电开关
  magpie-quota/         # Magpie 各账号额度图标与详情
  browser-devtools/     # Sidebar Browser 网页内调试浮窗
  translate/            # DSH 聊天选区与草稿翻译
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
