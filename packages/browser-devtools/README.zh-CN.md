# DSH 浏览器调试浮窗

[English](README.md) | **简体中文**

支持英语和简体中文，随 DSH 的语言设置即时切换；宿主未提供语言服务时回退到英语。

`dsh-browser-devtools` 为 DSH Desktop 的 Sidebar Browser 增加 Chrome 风格的网页调试器。点击地址栏旁的 **在独立窗口打开调试器** 按钮（向外箭头），即可借助电脑已有的 Chrome / Edge 应用窗口打开调试器。被调试网页仍留在 DSH，窗口可拖到另一块屏幕。运行 DSH 后端的电脑需已安装 Chrome 或 Edge，无需另装辅助程序或修改 DSH 桌面端源码。

调试器位于独立窗口中，而不是网页内，因此网页 CSS 无法影响它，也不会遮挡网页；颜色跟随 DSH 的浅色/深色主题和语言。注入网页的小型代理负责收集数据：

- **元素**：使用 Chrome 配色的 DOM 树，支持键盘导航、悬停时在网页中高亮（外边距、边框、内边距和内容区），以及在网页中点选元素的检查按钮。侧栏显示内联样式和匹配的 CSS 规则（样式），以及盒模型和全部计算属性（计算样式）。
- **控制台**：网页 `console` 输出和未捕获错误，支持级别过滤、文本过滤和重复计数；输入框可在网页中执行 JavaScript，`$0` 指向当前选中的元素。
- **网络**：以表格（名称、状态、类型、大小、时间）显示 Fetch、XMLHttpRequest 和资源计时记录，并提供 Chrome 的类型过滤。

插件使用专用临时浏览器配置和仅限本机的 HTTP 通信，不使用日常浏览器资料，也不开放 Chrome 远程调试端口。每个窗口始终绑定最初打开它的 DSH 标签页，不会随当前选中的标签页切换；页面跳转后重置调试状态并重新连接。关闭 DSH 标签页或调试窗口时，会关闭对应会话并清理临时配置；DSH 连接丢失约 20–25 秒后会自动清理。断线后可从工具栏重新打开；刷新独立窗口会关闭该会话。

此功能面向本机 DSH Desktop 后端。使用远程或无桌面后端时，浏览器会尝试在后端机器启动，而非当前桌面。支持查找 macOS、Windows 常规安装位置的 Chrome/Edge，以及 Linux PATH 中的 Chrome/Edge/Chromium；已在 macOS 验证原生应用窗口启动。

构建并打包：

```sh
pnpm --filter dsh-browser-devtools check
pnpm --filter dsh-browser-devtools pack:plugin
# 可选浏览器界面回归（需要 agent-browser 和 Chrome）：
pnpm --filter dsh-browser-devtools test:ui
```

将生成的 `.tgz` 安装到 DSH Desktop 后重启应用，打开 Sidebar Browser 页面，点击地址栏旁的调试按钮。调试窗口在页面跳转后保持打开，并自动连接新页面；点击其 × 按钮、窗口关闭按钮或工具栏按钮即可关闭。

这是网页调试器，不是完整的 Chromium DevTools；它只能读取网页脚本可读取的内容：没有请求头和请求体，无法读取跨域样式表规则，不支持断点，控制台只记录连接网页之后的消息。连接前发起的 Fetch 和 XHR 只能从资源计时中看到，不含方法和状态。

验证范围：HTTP 通信桥和渲染端集成测试覆盖命令往返、导航竞态、凭证隔离、启动错误、断线、DOM/样式、控制台、网络与清理。浏览器界面回归使用模拟 DSH 网页，安装到真实 DSH Desktop 后仍需手动验收。
