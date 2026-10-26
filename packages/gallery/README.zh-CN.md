# DSH 图库

[English](README.md) | **简体中文**

支持英语和简体中文，随 DSH 的语言设置即时切换；宿主未提供语言服务时回退到英语。

为 DeepSeek Harness 提供本地壁纸库。在「设置 → 图库」浏览图片，给聊天和侧栏设置背景。交互参考 Paseo 的壁纸库，使用 DSH 插件接口独立实现。

- 获取最近 8 天的 Bing 每日壁纸，保留名称、日期和图片来源。
- 开启背景后，应用打开且可见时每小时检查更新，新图片自动归档到本设备。
- 固定任意壁纸，或恢复每日自动切换；固定期间仍会归档每日图片。
- 上传 JPG、PNG、WebP：每张最多 10 MB、4000 万像素，每次最多 20 张。
- 来源筛选、名称与日期搜索、大图预览、方向键翻图、缩放、下载、删除。
- 调节图片不透明度、模糊及 Bing 地区，保留菜单和输入框的原有底色。
- 图片和偏好通过 IndexedDB 保存，刷新后恢复；已保存图片可离线使用。

## 安装

需要 Node.js ≥ 22.15.0，DSH `>=0.2.1-rc.2 <0.3.0`，支持 Web 与桌面端的 Web 界面。

在仓库根目录执行：

```sh
pnpm install --frozen-lockfile
pnpm --filter dsh-gallery pack:plugin
dsh plugin --profile web add "$PWD/dist/dsh-gallery-0.1.1.tgz"
```

重启对应 profile 并刷新页面，打开「设置 → 图库」，点击「更新壁纸」或「上传图片」，再开启「使用图库背景」。背景默认关闭。点击图片打开大图，预览中可保存原图；鼠标移到卡片上显示「使用／删除」及图片信息，「使用」会固定该图片并开启背景。触屏上直接显示浮层。

桌面端请完全退出应用，使用该桌面应用自带的 `dsh` 命令，将上述安装命令的 profile 改为 `desktop`，安装后重新打开。通过 npm 安装的普通 `dsh` 命令不能管理 `desktop` profile。

## 数据与更新

图片和偏好仅属于当前设备、当前应用或网站地址。本地文件不上传，不修改 DSH 的主题偏好。关闭应用或背景后暂停自动获取，手动更新始终可用。首次获取最近 8 天，之后持续积累；无法补回 Bing 不再提供的历史图片。

图片与信息在同一个事务中归档，下载失败保留已有图库和背景。当前壁纸及所选地区最新的每日壁纸不能直接删除，先切换背景再删除其他图片。清除网站或应用数据会删除图库。卸载插件会撤销背景样式并保留数据，重新安装到同一地址可继续使用。

DSH 主机需要能访问 `www.bing.com`。图片来源链接保留原始版权信息，插件不附带或重新授权 Bing 图片。

## 开发与验证

```sh
pnpm --filter dsh-gallery check
pnpm --filter dsh-gallery test:ui
pnpm --filter dsh-gallery preview:ui
```

`check` 执行类型检查、核心测试与构建。`test:ui` 需要 `agent-browser` 与 Chrome，使用独立会话和模拟 Bing 图片，验证真实 IndexedDB、刷新恢复、上传、每日与固定模式、失败恢复、预览、移动端布局及卸载清理。可用 `DSH_TEST_BROWSER_PATH` 指定 Chrome，用 `DSH_GALLERY_SCREENSHOT_DIR` 保存截图。

`preview:ui` 使用真实 Bing 接口，在 `0.0.0.0:4183` 启动独立预览，访问 `http://100.96.195.115:4183/`。可通过 `DSH_GALLERY_PREVIEW_PORT` 修改端口。预览包含简化宿主外壳，数据与正式 DSH 地址分开保存。

服务端仅通过 DSH connection 注册 `/api/gallery/bing` 和 `/api/gallery/image` 两个 GET 接口，沿用宿主认证与来源检查。图片代理只接受合法 Bing ID，限制大小、超时及重定向，不接受任意网址。

MIT。
