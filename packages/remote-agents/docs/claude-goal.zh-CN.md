# 在远程 Claude 主聊天中使用 DSH goal

在 DSH 普通模型选择器中选远程 Claude 并按会话显式启用后，可以操作当前会话的原生 DSH goal。**桥默认关闭。**可选的 `dsh-goal` MCP 桥只提供 `create_goal`、`get_goal`、`update_goal`，无需开启通用 MCP 共享。其他 CLI、终端/TUI 会话和委派出的 CLI 任务不会因此获得 goal 桥。

## 前提与使用

DSH 主机需要加载原生 goal、goal-tool、goal-round-driver 插件，并提供批量工具执行器及 agent initiator API。已核实并测试 `@deepseek-ai/*@0.2.2-rc.1`。会话实际选中的 scoped executor 必须通过公开 `describe()` 广告这三个直接调用。只接受 `run_code` 的 PTC、缺少 executor 的会话均明确不支持；桥不会替换或绕过执行器。旧版宿主或未加载 goal 服务时，普通远程聊天照常工作，但不提供 goal 工具。Claude 还须提供原生 `claudecode/toolUseId` MCP 元数据，缺失时拒绝调用。SSH/Node.js 要求沿用现有 MCP 转发机制。

在现有 `dsh-remote-agents` 插件配置中加入精确的 **DSH session ID**（不是远端 task ID，也不是 Claude 原生 session ID）：

```json
{"claudeGoalSessions":["the-exact-dsh-session-id"]}
```

默认 `[]` 对所有会话关闭桥。未列出的 Claude 聊天保留常驻进程和后台工作，即使已安装 goal 服务或其他会话已启用。移除 ID 并重载会撤销访问；synthetic 消息和模型请求不能自行启用。无需新增 UI。

安装包含本改动的构建并应用上述配置后，需要重载 remote-agents 插件或重启 DSH。**本次源码修改不会自动部署。** 对每条新投递、goal 可用的 Claude 轮次，适配器等待旧工作结束，释放空闲进程，然后以新进程和 MCP proxy 恢复**同一个原生 Claude session ID**。已有回执只回放，不新建授权或重启进程，不需要手动归档/恢复。此方式增加启动耗时，也会在轮次边界结束进程内后台工作，这是隔离跨轮 MCP 授权的代价。**仅在接受轮次间结束进程内后台任务时启用。** 常驻进程的 goal 模式尚未验证。未列入名单的 Claude 聊天及其他 CLI 提供方保持原有进程生命周期。

1. 选择远程工作区，并在主聊天选择远程 **Claude** 模型。
2. 示例：“创建一个 DSH goal，检查这些测试并修复失败，验证完成前持续推进，最多自动续 5 轮。”
3. 询问“当前 DSH goal 是什么？”可查看目标、revision 和状态，也可使用原生 DSH goal 界面。
4. 询问“暂停这个目标”可暂停。**paused** 目标需要用户通过 DSH goal 界面或原生 goal 命令恢复；原生模型工具会拒绝恢复 paused，即使用户在聊天中要求模型恢复。
5. 会话重启/恢复后，即使目标仍为 active，也会处于 **disarmed**。用户直接要求继续时，Claude 可通过原生 `update_goal` 的 `action: "resume"` 重新激活；桥不会自行激活恢复的目标。

自动续轮由原生 DSH driver 调度。每轮送到同一个绑定的 Claude session，保留原始 goal ID、revision、round 和指令文本，并明确标为自动上下文，不伪装成人类新请求。新用户输入沿用 DSH inbox/driver 的优先级。完成、阻塞、暂停、停止按钮及轮数上限均遵守原生规则。关闭 DSH 仍会让远端工作继续，但本地 driver 不在时，goal 工具没有执行授权；重开会话收取输出后，按需明确要求继续。

## 工具格式与权限

这里使用真实 DSH schema，并非 Codex API 的 `status`/`token_budget` 格式：

- `create_goal`：`objective`，可选 `max_goal_rounds`。
- `get_goal`：无参数，返回 `goal`（可能为 null）；有目标时还返回 `activation`。
- `update_goal`：`goal_id`、`revision`、`action`，按动作接受 `objective`、`max_goal_rounds`、`blocked_reason`。动作包括 `edit`、`pause`、`resume`、`complete`、`blocked`。

更新前读取当前目标，过期 revision 会被拒绝。创建、编辑、暂停、重新激活需要根 agent 当前轮次中的直接人类输入；定时消息、团队指令、自动续轮不提供此权限。complete/blocked 也允许在该目标的精确原生续轮中调用，blocked 仍受原生配置的轮数阈值限制。应遵循原生工具返回的错误。

凭据绑定 **goal 命名空间 + 远端任务 + DSH 会话 + 远端消息 + 随机启动 epoch**。每个新进程使用唯一命名、不可覆盖的凭据文件。常驻 proxy 只在启动时读取一次身份，在等待连接之前固定本次调用的原生 tool-use ID，重连仍使用原身份。wire 不提供“获取当前 grant”的接口，也没有可重读的当前凭据文件。grant 关闭后，旧 token、旧连接均失效；仅把参数改为新 epoch 不能升级旧 token。

仅有 epoch 仍不足以证明来源。宿主保留每条原生 user 帧实际发送的 UUID。首个 root assistant（包括 thinking）或 partial 帧中的原生 `user_message_uuid` 必须先绑定到该次发送，root tool call 才能得到 `claude_goal_origin` 证明。后续帧依赖不可变的原生 response 归属及已验证的 root 流边界，不能用 activeMessage 或当前 grant 补齐缺失来源。逐项匹配 UUID、原生 session/response、epoch、消息 ID、调用 ID、工具名和参数。独立的追加式插件来源账本跨重载、展示历史截断保留 seen/closed ID；它不是原生 goal 持久化文件。带 parent 的子代理输出、回放输出、历史上已出现的调用 ID、后台轮次都不能为新调用提供证明。MCP 元数据必须与这条独立输出证据一致。工具卡片仍是记录，不触发执行；两条传输链路发生竞态时限时等待证据，超时明确失败，不以“当前 grant”推断来源。

调用继续核验精确 live agent、open turn、取消信号和任务绑定，并通过原生 guard 在异步审批后再次检查。执行仍走公开 `agents.withInitiator` 和宿主选定的 `tools.execute({ calls, agent, signal })`，保留校验、权限、审批、guard 和 revision CAS。卸载时撤销授权，并通过公开 `goals.disarm` 停用自动激活；不直接修改持久化或 durable phase/revision。

只转发这三个 goal schema 及其结果，不发送本地 system prompt 或其他本地工具 schema。原生完成/阻塞后的收尾上下文随 MCP 结果返回 Claude，并保留 `tool-goal` 来源，避免让 DSH 重跑最后一条人类请求。远端工具卡片仍仅展示，不重复执行。

## 恢复与排查

续轮使用现有持久化消息回执去重。重试同一续轮只回放已有回执，不重复投递。已暂停、完成或 disarmed 的续轮可以回放已有回执，但不会获得新 goal 授权，也不能投递新消息。插件重启不会重建授权或激活目标。同一 live grant 内，相同原生调用 ID 和参数会回放已结算结果（含完成/阻塞收尾上下文），参数改变则拒绝。因此 complete/blocked 已提交但回应丢失时，不会重复状态变更。grant 关闭或插件重载后，旧凭据被拒绝，应在新的人类轮次查询原生状态。旧远端轮次和后台轮次不能借用后续人类授权。

显式携带旧输入 UUID 的 result 不能结束或失败当前轮次。现代 opt-in 会话的 success result 缺少可验证输入 UUID 时，不能宣称完成；但会话级无 UUID 错误会明确报告为保守失败：撤销当前 grant、disarm goal 激活并停止自动续轮，保留 `errors[]` 的错误详情。未启用桥的普通会话保留正常错误处理和进程，包括后台错误收尾。此处理不会把 durable goal 标为 complete 或 blocked。

看不到 goal 工具时，检查精确会话 allowlist、宿主插件是否齐全、scoped executor 是否支持直接调用、Claude 是否提供原生 tool-use 元数据。下一条主聊天新消息会启动其专属 proxy，回执回放不会升级旧授权。goal 代理断连时不会返回缓存工具，调用会明确失败。仅在“打开的会话”面板里发消息或 Claude 自行启动的后台轮次没有主聊天授权；请通过 DSH 普通主聊天继续。此桥不会开放 DSH 主机的文件或 shell 工具。

## 本次验证范围

仓库 `artifacts/claude-goal/COMPATIBILITY.md` 记录精确命令和输出。测试包含真实 GoalService/ToolRuntime/AgentRegistry，以及真实 AgentLoop/GoalRoundDriver 驱动适配器、远端后端使用替身的自动续轮测试，覆盖完成、新用户输入、Stop、外部 pause、reload/disarm 和轮数上限。真实嵌入式 proxy 使用内存传输替身测试延迟请求/重连；真实 CliSession 解析器使用受控原生输出帧验证来源。真实 Claude Code 2.1.319 已成功初始化隔离 stdio MCP server，并发现三个真实 goal schema；没有发送模型请求或执行任何业务操作。

当前受限环境拒绝监听 `127.0.0.1`（`EPERM`），因此 **未验证** SSH 反向转发/socket 链路，以及由真实远程模型完成的创建 → 自动续轮 → 完成全过程。Claude 探针严格属于**初始化/工具发现 smoke**：直接 stdio 夹具不代表真实模型工具调用、live 模型输出的元数据、SSH 主机上的每轮进程替换或 goal E2E 已通过。原生元数据字段另已从已安装 Claude sender 实现中核实。未通过提权或绕过限制重试 socket 链路。未修改已安装/运行中的插件或全局配置。
