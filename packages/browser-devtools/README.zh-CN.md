# DSH 浏览器调试浮窗

`dsh-browser-devtools` 为 DSH Desktop 的 Sidebar Browser 增加网页内调试浮窗，不需要桌面端开启 Electron 原生 DevTools。

浮窗提供：

- 点选元素，并显示盒模型尺寸、属性和 HTML 摘要；
- 捕获页面 `console` 输出和未处理错误；
- 记录 Fetch、XMLHttpRequest 和资源计时网络请求。

构建并打包：

```sh
pnpm --filter dsh-browser-devtools check
pnpm --filter dsh-browser-devtools pack:plugin
```

将生成的 `.tgz` 安装到 DSH Desktop 后重启应用，打开 Sidebar Browser 页面，点击地址栏旁的调试按钮。浮窗注入当前页面，点击关闭按钮或重新加载页面即可移除。

这是网页调试器，不是完整的 Chromium DevTools；它不能查看浏览器进程内部、扩展页面，也不能补录打开浮窗前已经完成的请求。
