# 手机 Web App (PWA)

[English](README.md) | **简体中文**

把 DSH 网页版的 `/manifest.webmanifest` 里的 `theme_color` 和 `background_color` 换成深色（默认 `#151517`，即 DSH 深色主题底色），解决安装到手机主屏（Android WebAPK）后，底部系统导航栏和弹出/切换键盘时最底下那一栏发白的问题。

## 原因

从 0.2.2-rc.1 起，DSH 自带的 `manifest.webmanifest` 把 `theme_color` 和 `background_color` 都写成了白色（`#ffffff`）。页面加载后 DSH 会按页面底色写入 `<meta name="theme-color">`，所以顶部状态栏会跟随主题；但 Android 主屏 Web App 的底部系统导航栏（包括弹键盘/切换键盘时最底下带收起与切换键盘图标的那一条）以及窗口底色取的是应用清单（Android 14 及以前取 `theme_color`，Android 15 起透出 `background_color`），所以深色模式下底部依然是白的。

## 插件做了什么

- 读取当前运行的 DSH 自带的 `manifest.webmanifest`（通过 `frontend-static` 的 dist 目录，或正在运行的 `dsh` 旁边的 DSH 包找到），在 DSH 的 `webServer` 上用精确路由 `/manifest.webmanifest` 提供（优先于 `frontend-static`）。`name`、`short_name`、`start_url`、`scope`、`display`、`icons` 等字段原样保留，只换 `theme_color` 和 `background_color`（默认 `#151517`）。
- 跟随 DSH 的文件：DSH 升级改了清单，下一次请求就会用上新内容。
- 插件自己不带清单。读到 DSH 的文件之前不接管这个路由（仍由 DSH 提供，并记一条警告）；读到过之后如果文件消失或无法解析，继续提供上一次读到的内容，不会因为升级到一半而改动已安装的应用。
- 其它都不动：不改页面、不加样式，`<meta name="theme-color">` 仍由 DSH 的主题逻辑负责，页面顶部状态栏继续随浅色/深色/跟随系统切换。

纯服务端插件，无客户端脚本；在没有 `webServer` 的 profile 上会自动保持静默。

**代价与生效方式：**
- Web App 清单只能声明单色，因此浅色模式下 Android 底部系统栏也会是深色。
- Android 上**已经安装**的 Web App 不会立刻刷新清单颜色：在手机上卸载旧主屏应用后，从 Chrome 重新「安装应用 / 添加到主屏幕」即可立刻生效（或等待 Chrome 的周期性清单检查自动更新）。
- 如果 DSH 前面的反向代理自己回答 `/manifest.webmanifest`，看到的就不是本插件的清单；要让这个路径转发到 DSH。

## 配置项

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `themeColor` | `#151517` | 写入 `/manifest.webmanifest` 的 `theme_color` |
| `backgroundColor` | `#151517` | 写入 `/manifest.webmanifest` 的 `background_color` |
| `display` | `""` | 可选覆盖清单的 `display`（`fullscreen`、`standalone`、`minimal-ui`、`browser`）；留空沿用 DSH 原值 |
| `manifestPath` | `""` | 可选手动指定上游 `manifest.webmanifest` 路径；留空自动查找 DSH 原文件 |

## 安装

```sh
pnpm --filter dsh-pwa pack:plugin
dsh plugin --profile web add "$PWD/dist/dsh-pwa-0.1.0.tgz"
```

安装后重启或热加载 Web profile，确认 `/manifest.webmanifest` 里是 `"theme_color": "#151517"`，再在手机上重新安装 Web App 即可生效。
