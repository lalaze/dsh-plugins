# TUI 输出热路径优化（2026-11-07）

## 已定位的额外工作

基线：`f6954f0ad6e7d9e7ff8dc7b47532df91d3cd407d`，remote-agents 0.2.117。

1. [shell-menu](../packages/remote-agents/src/client/workspace/shell-menu.ts) 在 body 每次 childList 变化时同步扫描整页菜单。终端 DOM 行更新也触发；若菜单打开，还读取菜单/按钮布局并写入位置。
2. [custom-model-label](../packages/remote-agents/src/client/composer/custom-model-label.ts) 在全页 childList/characterData/title 变化后扫描全部模型标签。终端持续输出不涉及模型标签，却反复触发扫描。
3. [TuiTerminal](../packages/remote-agents/src/client/workspace/tui.tsx) 外层订阅完整终端快照。输出/ACK 更新也让生命周期外层重渲染，重新生成 Body 的 view/hooks 和绑定后的订阅函数。

这些是可验证的冗余开销，不等于已证明用户所有严重卡顿都由它们导致。未在用户桌面实际卡顿的会话中采集 trace，也没有把历史调研数字当作本次实测。

## 修改

- 新增 [DOM 变更过滤](../packages/remote-agents/src/client/dom-mutations.ts)：只检查变更目标的祖先和新增/移除的子树；批次与菜单/模型选择器无关时不做全页扫描。菜单新增和内容变化仍在 observer 微任务中处理，不改成延迟一帧出现。
- TUI 外层只订阅所需的 `issue`，稳定 Body 接口与订阅；Body 继续收到完整快照，不丢输出、不跳过 ACK。重新显示时从当前模型读取连接状态，保留原有重连时机。
- 未更换终端实现、修改 holder/SSH 协议、调整 WebGL/模糊默认值、禁用鼠标或结束现有会话。

## 定量回归

环境：远端 macOS，Node 22.23.2 / pnpm 10.34.7 / JSDOM 26.1.0。测试页面包含 1000 个会话行、模型选择器，以及可选的打开菜单。

[DOM 回归测试](../packages/remote-agents/test/tui-mutation-performance.test.ts) 分 200 个独立 observer 批次交替替换终端行、更新文字。起始挂载已稳定后才计数。基线运行通过 esbuild 的 onLoad 从上述 HEAD 读取两个 observer 的原始实现；修复版使用工作树。同一测试分别运行三轮，计数每轮完全一致。

| 场景 | 基线整页 querySelectorAll | 修复后 | 基线布局测量 | 修复后 |
|---|---:|---:|---:|---:|
| 菜单关闭，200 批 | 300 | 0 | 0 | 0 |
| 菜单打开，200 批 | 400 | 0 | 200 | 0 |

三轮模拟循环耗时（ms，含 DOM 修改与事件调度，不是输入回显延迟）：

- 关闭菜单：基线 143.667 / 145.143 / 144.314；修复 29.374 / 28.503 / 28.695。
- 打开菜单：基线 201.452 / 196.407 / 193.053；修复 26.604 / 23.672 / 23.698。

JSDOM 不执行真实浏览器布局/绘制，布局接口是计数替身；不能把这些耗时或降幅称为真实对话加速。新增回归还覆盖后插入的嵌套菜单/模型选择器、title 单独变化、菜单内容更新和卸载。

[React 回归测试](../packages/remote-agents/test/tui-terminal.test.tsx) 使用生产 TuiTerminal 与受控 Body 替身：连续 30 个快照仍产生 30 次 Body 更新，每帧内容正确；外层新增 render 为 0，订阅/退订以及四类接口依赖 effect 的新增执行均为 0。还验证可见性、只读附件重连、missingTerminal、主题变更、generation 替换及卸载清理。Body 替身不代表已经对 DSH 自身的全部 effects 做了 profiling。

复跑：

```sh
pnpm --filter dsh-remote-agents exec node --import tsx --import ./test/setup.mjs --test test/tui-mutation-performance.test.ts test/tui-terminal.test.tsx test/shell-menu.test.ts test/custom-model-label.test.ts
pnpm --filter dsh-remote-agents run check
```

## 验证与生效范围

最终 `pnpm --filter dsh-remote-agents run check` 退出 0：627 项测试中 626 通过、1 跳过、0 失败，类型检查和完整构建均通过；`git diff --check` 通过。聚焦 DOM 测试 15/15 通过。

验证过程曾受工具环境限制：第一次完整命令被 30 秒工具超时中断；另一个远端 CLI 的默认沙箱禁止 Unix socket，导致该轮 relay 测试失败/挂起并已终止。最终结果来自当前授权远端环境的独立完整运行，不使用上述两轮作成功或源码失败依据。

本次改的是远端工作区源码及构建产物；没有发布、安装到当前桌面 profile、重启 DSH 或声称当前页面已热更新。需要将本次构建加载到使用中的插件后再验证真实对话体感。原有未跟踪调研文件和截图保留。
