# DSH 浏览器调试浮窗

[English](README.md) | **简体中文**

支持英语和简体中文，随 DSH 的语言设置即时切换；宿主未提供语言服务时回退到英语。

`dsh-browser-devtools` 为 DSH Desktop 的 Sidebar Browser 增加 Chrome 风格的调试器。点击地址栏旁的调试按钮：

- **DSH 开发版**（从源码运行）允许浏览器页面使用 DevTools，按钮会直接打开 Chromium 自带的 DevTools。
- **DSH 正式版**在主进程中关闭了浏览器页面的 DevTools（`devTools: !app.isPackaged`），插件无法更改；此时按钮会在页面下方停靠插件自带的调试器。

停靠的调试器位于 DSH 自己的窗口中，而不是网页内，因此网页 CSS 无法影响它，也不会遮挡网页。拖动顶部边缘可调整高度，高度会被记住；颜色跟随 DSH 的浅色/深色主题和语言。注入网页的小型代理负责收集数据：

- **元素**：使用 Chrome 配色的 DOM 树，支持键盘导航、悬停时在网页中高亮（外边距、边框、内边距和内容区），以及在网页中点选元素的检查按钮。侧栏显示内联样式和匹配的 CSS 规则（样式），以及盒模型和全部计算属性（计算样式）。
- **控制台**：网页 `console` 输出和未捕获错误，支持级别过滤、文本过滤和重复计数；输入框可在网页中执行 JavaScript，`$0` 指向当前选中的元素。
- **网络**：以表格（名称、状态、类型、大小、时间）显示 Fetch、XMLHttpRequest 和资源计时记录，并提供 Chrome 的类型过滤。

DSH Desktop 不允许插件或网页打开独立的弹出窗口：网页弹窗会以 Sidebar Browser 标签页打开，插件界面只能显示在 DSH 窗口内。

构建并打包：

```sh
pnpm --filter dsh-browser-devtools check
pnpm --filter dsh-browser-devtools pack:plugin
```

将生成的 `.tgz` 安装到 DSH Desktop 后重启应用，打开 Sidebar Browser 页面，点击地址栏旁的调试按钮。调试器在页面跳转后保持打开，并自动连接新页面；点击其 × 按钮或工具栏按钮即可关闭。

这是网页调试器，不是完整的 Chromium DevTools；它只能读取网页脚本可读取的内容：没有请求头和请求体，无法读取跨域样式表规则，不支持断点，控制台只记录连接网页之后的消息。连接前发起的 Fetch 和 XHR 只能从资源计时中看到，不含方法和状态。
