# 更新日志

## 0.1.0 — 为手机 Web App 清单换上深色底栏配色

- 在 DSH 的 `webServer` 上接管 `/manifest.webmanifest`，把 DSH 写的白色 `theme_color` 和 `background_color` 换成 `#151517`（可配置），DSH 自带清单的其它字段原样保留，DSH 升级后自动跟随，解决 Android 主屏 Web App 底部系统导航栏与键盘切换底栏发白的问题。
- 插件自己不带清单：读到 DSH 的文件之前路由仍由 DSH 提供；之后文件消失或无法解析时继续使用上一次读到的内容。
- 不改页面：不加样式，`<meta name="theme-color">` 仍由 DSH 负责。
