# DSH 使用量统计

[English](README.md) | **简体中文**

支持英语和简体中文，随 DSH 的语言设置即时切换；宿主未提供语言服务时回退到英语。

`dsh-usage-stats` 同时统计 DSH 模型调用和通过 `dsh-claude-ssh` 发起的远端 Claude Code 用量。在 DSH **设置 → 使用量统计** 中查看，按来源、日期、服务商、模型、会话筛选，按日期、来源、模型或会话分组，并导出当前筛选结果的 CSV。

界面包含总 Token、调用次数、缓存读取占比和调用完成率；用量趋势可切换 Token/调用次数，旁侧显示 DSH 与 Claude SSH 来源占比。支持今天、近 7 天、近 30 天和自定义日期；服务商、模型和会话筛选可展开。明细默认按模型展示，每页 10 组，适配浅色、深色和窄屏布局。趋势补齐无调用日期，超过 48 天时按等长时间段汇总，保持总量一致。

## 构建与安装

需要 Node.js ≥ 22.15.0，DSH `>=0.2.1-rc.2 <0.3.0`。

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm --filter dsh-usage-stats check
corepack pnpm --filter dsh-usage-stats pack:plugin
dsh plugin --profile web add "$PWD/dist/dsh-usage-stats-0.1.1.tgz"
```

以上命令在仓库根目录执行。桌面端改用 `--profile desktop`，安装前完全退出 DSH，安装后重新打开；Web 端重启对应 profile 并刷新页面。Claude SSH 来源需另行安装该插件，建议使用 `0.1.7` 或更新版本，以保留远端失败结果返回的用量。

## 统计口径

- 从启用插件后开始记录，不扫描历史会话，不访问云端账单或远端账户。
- 一次公开 `llm/stream` 调用记一次调用，包括会话、标题生成和上下文压缩；这不是底层 HTTP 请求/重试次数。
- Claude SSH 一轮可能在远端执行多次模型或工具调用，这里按远端最终 `result.usage` 的整轮合计记录一次。服务商为 `claude-ssh-<主机 ID>`，模型为选中的 `sonnet`/`opus`/`haiku` 别名，不声称解析成具体版本。独立在远端终端运行的 Claude Code 不经过 DSH，因此不在本插件范围内。
- 输入 Token 指**未缓存输入**；缓存读取、缓存写入独立列出。总 Token 优先采用适配器提供的 `totalTokens`，否则为输入 + 输出 + 缓存读取 + 缓存写入；推理 Token 已包含在输出中，不再相加。
- 同一调用多次返回 `usage` 时采用最后一个有效快照，不将累计值重复相加。
- 失败/取消调用仍保留已经返回的用量。未返回用量的调用仅计次数，页面明确显示“已返回用量”比例，不将未知用量当成已知零。SSH 断线或强行终止远端进程时可能拿不到最终用量。
- 日期筛选使用调用开始时间，按 **UTC** 划分，起止日期均包含。运行中的调用在流关闭后计入。页面每 5 秒刷新；快捷日期在自动或手动刷新时随 UTC 日期滚动，自定义日期保持固定。
- 首版统计 Token，不估算金额、订阅额度或余额。

## 本地数据

默认写入 `${DSH_HOME:-~/.dsh}/storages/dsh-usage-stats/usage.json`。插件配置 `stateDir` 可修改目录；不同进程/profile 应使用各自的目录，**不支持多个进程共同写入同一个文件**。每条记录只保存调用标识、时间、来源/模型、会话 ID、用途、状态、时长和用量，不保存提示词、回复、工具内容、凭据或 SSH 私钥。

写入串行执行，通过临时文件与 rename 替换快照，数据文件权限为 `0600`。磁盘错误会记录日志并在页面显示漏记数量，不中断模型流；损坏的旧文件会阻止插件启动，保留原文件供检查。同一进程内重载插件时，新旧实例共享存储，直到所有已开始的调用结束，避免旧调用覆盖新记录。写入失败计数在插件完全停用且所有已开始调用结束后重置。当前以 JSON 快照保存全部记录，适用于个人使用；数据量增长时读写成本随记录数增长，尚无自动归档或保留期限。

## 开发验证

```sh
corepack pnpm --filter dsh-usage-stats check
corepack pnpm --filter dsh-usage-stats test:ui
corepack pnpm --filter dsh-usage-stats preview:ui
```

`preview:ui` 启动仅含演示数据的预览，绑定 `0.0.0.0:4182`，可通过 `http://100.96.195.115:4182/#demo` 查看，不读取真实用量。使用 `DSH_USAGE_PREVIEW_PORT` 修改端口。

自动测试覆盖来源归类、Token 计算、日期/模型/会话筛选、取消与错误、流关闭、落盘失败、重启恢复与运行中重载、CSV 和宿主路由注册。浏览器验证使用 `agent-browser` 与 Chrome，对真实 React 组件配合模拟接口检查筛选、UTC 跨日刷新、自定义日期保持、分组、空态和错误恢复；不连接真实模型、不修改 DSH profile。macOS 默认使用系统 Chrome，其他环境可设置 `DSH_TEST_BROWSER_PATH`。

宿主接口基于本仓库锁定的 `@deepseek-ai/dsh-llm@0.2.1-rc.2`：`lib/types/index.d.ts` 的 `llm/stream` waterfall，以及 `lib/types/types.d.ts` 的 `GenerateOptions`、`TokenUsage`、`StreamChunk`。HTTP 注册沿用 `@deepseek-ai/dsh-client-connection`，由宿主处理身份认证、来源检查和原生传输。客户端使用 `settings.section` 插槽。

MIT。
