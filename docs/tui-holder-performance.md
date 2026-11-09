# TUI holder 实时输出优化（2026-11-09）

基线：`d652638f0ff5c5d8d12f9ebeb993e50d994a1971`，remote-agents 0.2.118。

## 发现与范围

上一轮 [DOM 热路径修复](./tui-performance-fix.md) 消除了全页扫描和外层重复渲染。本轮检查发现 [terminal-holder](../packages/remote-agents/src/terminal-holder.ts) 的实时输出仍必须等待 headless xterm 的 `write` 回调：先解析用于断线恢复的画面，再发给在线客户端。短回显也要等待异步解析调度；ANSI 突发还要等待解析队列。

这是一项可从代码和测试确认的额外等待，并不证明用户所有卡顿都由它导致。没有采集当前桌面卡顿现场的浏览器 trace，也未测实际 SSH 输入回显。

## 修改

新增 [HolderOutput](../packages/remote-agents/src/workspace/holder-output.ts)：

- 在线客户端立即收到原始输出帧，不等待 headless 解析，不做防抖、不丢帧。
- 正在接入的客户端先等待解析屏障并取得快照；屏障之后收到的帧暂存，快照发出后按原顺序补齐。这样不会把已经转发过但尚未解析的输出漏掉，也不会重复包含快照前的数据。
- 缓存引用共享帧，不为每个接入者复制数据。保留原有 2 MiB / 256 KiB 解析背压和 5 秒慢客户端超时；没有把解析队列改为无限增长。
- 断开或重复 hello 会使旧的快照回调失效，避免执行过期 resize 或重新加入已离开的客户端。
- 不改变 SSH/holder 协议、输入处理、退出码、终端实现、WebGL 与背景模糊偏好。

headless 仍在同一个进程中运行，仍有解析 CPU 成本，仍可能影响后续事件处理。本轮改善的是“已收到的这块输出不必等解析再转发”，不是将解析移到 worker，更不是整体吞吐量提升声明。

## 测量方法与结果

[可复跑脚本](../packages/remote-agents/scripts/benchmark-holder-output.ts) 使用真实 `@xterm/headless` 6.0.0，对比旧的 parse-first 调用顺序和新的 live-first 分发器；两条路径都保留解析回调。先预热，再交替顺序运行三轮。环境为远端 macOS arm64、Node 22.23.2。

[原始记录](../artifacts/tui-holder-benchmark.json) 的最后一块转发时刻（相对突发输入起点，ms）：

| 输入 | 旧顺序，三轮 | 新顺序，三轮 |
| --- | --- | --- |
| 14 字节短回显 | 0.918 / 1.791 / 0.640 | 0.009 / 0.010 / 0.004 |
| 256 KiB ANSI | 5.939 / 5.237 / 4.246 | 0.130 / 0.037 / 0.039 |
| 1 MiB ANSI | 19.058 / 15.616 / 20.470 | 0.128 / 0.119 / 0.175 |

这是一次进程内模拟突发，分块 4 KiB，总量低于生产解析高水位；发送端是计数回调，没有真实 socket、SSH、浏览器或背压阻塞。记录期间另有全量测试运行，耗时会受系统负载影响。结果只能证明移除了转发前的解析依赖，不能解释成用户输入延迟降到 0.1 ms。`parseDoneMs` 也已记录，后台解析耗时没有稳定下降。

## 回归

[新增测试](../packages/remote-agents/test/holder-output.test.ts) 覆盖：

1. 解析屏障未完成时，在线客户端仍同步收到输出。
2. 多客户端交错接入分别保持自己的快照边界，无漏字、无重复。
3. 断开和重复 hello 不执行过期快照/resize/接入回调。
4. 已在线客户端重新请求快照时，后续原始字节不会先于快照出现。
5. 分片 ANSI 和 UTF-8 字节保持不变。
6. 使用真实 headless xterm，快照与补发后的中文、ANSI、滚动历史及最终画面，与不间断在线客户端一致。

聚焦结果：新增 6/6 通过，原有 holder 集成 18/18 通过。最终完整 `check` 退出 0：633 项测试中 632 通过、1 项既有跳过、0 失败；类型检查及完整构建通过，`git diff --check` 通过。见 [完整检查日志](../artifacts/tui-holder-check.log) 和 [退出码](../artifacts/tui-holder-check.exit)。

首次全量命令被工具等待超时中断，不作为测试通过或失败依据；随后以独立进程完成上述检查。新增测试最初的 CommonJS 导入错误已修正，最终结果来自修正后的完整运行。

```sh
pnpm --filter dsh-remote-agents exec node --import tsx --import ./test/setup.mjs --test test/holder-output.test.ts test/terminal-holder.test.ts
pnpm --filter dsh-remote-agents exec node --import tsx scripts/benchmark-holder-output.ts
pnpm --filter dsh-remote-agents run check
```

## 生效与下一步

已随 Remote Agents **0.2.119** 发布到插件市场，详见 [发布记录](./releases/2026-11-09.md)。发布没有安装到当前桌面 profile、重启 DSH 或结束用户终端。

这次优化运行在 **新启动的远端 holder** 中。安装包含修复的版本后，新建 TUI 会话可启用新 holder；已存活的 holder 为保证会话不中断会继续运行旧代码，刷新网页或断线重连不会替换它。不要为验证性能直接杀掉正在工作的 holder。

对于持续滚动/重绘卡顿，下一步应在真实桌面对比渲染菜单里的“开启 WebGL / 关闭背景模糊”，并采集长任务、绘制和输入回显 trace。本轮不擅自改用户偏好，也不声称这个建议已经完成现场验证。
