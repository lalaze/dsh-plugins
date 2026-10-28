# DSH Auth Cookie Cleanup

[English](README.md) | **简体中文**

[deepseek-ai/deepseek-harness#10598](https://github.com/deepseek-ai/deepseek-harness/discussions/10598) 的临时修复。DSH 官方修复发布后请卸载本插件。

## 问题

DSH Desktop 每次启动都会让 host 监听一个随机的 `127.0.0.1` 端口，而 host 把 60 天有效的会话 cookie 命名为 `dsh-auth-<sha256(host:port)>`。因此每次启动都会多出一个 cookie，旧的永远不会删除。Cookie 不区分端口，每个请求都会带上全部 cookie。启动约 70 次后，`Cookie` 请求头超过 Node 默认的 16 KB `maxHeaderSize`，host 拒绝请求，Desktop 报 `desktop welcome: Web authentication failed`，窗口无法打开。

## 插件做了什么

插件监听 host 的 `connection/request` 钩子，该钩子只对已经通过认证的请求触发。如果请求里带有当前端口以外的 `dsh-auth-*` cookie，插件会追加 `Set-Cookie` 让它们立即过期。当前会话的 cookie 不会被改动；请求里认不出当前 cookie 时，插件不做任何处理。

因此两次启动之间最多残留一个旧 cookie，请求头不会再增长。插件只有服务端部分，没有界面。

**取舍：** 如果在**同一个浏览器**里同时开多个不同端口的 `dsh web` 实例，它们会互相登出。Desktop 是单实例、cookie 独立，不受影响。

## 已经打不开了？

请求头超限后，Node 会在任何插件代码运行之前就拒绝请求。需要先手动清理一次 cookie，再安装插件：

1. 完全退出 DSH Desktop。
2. 对 Electron 用户数据目录（或直接对其中的 `Network/Cookies` 文件）运行随包附带的脚本：

   ```sh
   node bin/reset-auth-cookies.mjs "<用户数据目录>" --dry-run   # 只统计
   node bin/reset-auth-cookies.mjs "<用户数据目录>"             # 删除并备份
   ```

   脚本只删除 `127.0.0.1`、`localhost`、`[::1]` 下的 `dsh-auth-*` 行，删除前先写出 `Cookies.bak-<时间戳>` 备份。需要 Node ≥ 22.15（`node:sqlite`）。

没有 Node 时，也可以在应用关闭的状态下把 `Network/Cookies` 和 `Network/Cookies-journal` 改名。代价是应用内其他站点的登录状态也会丢失。

## 安装

```sh
pnpm --filter dsh-auth-cookie-cleanup pack:plugin
dsh plugin --profile desktop add "$PWD/dist/dsh-auth-cookie-cleanup-0.1.0.tgz"
```

Desktop 需完全退出后使用应用自带的 `dsh` 命令；Web 使用 `--profile web` 并重启。
