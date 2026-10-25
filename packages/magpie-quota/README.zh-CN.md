# Magpie 账号额度

[English](README.md) | **简体中文**

支持英语和简体中文，随 DSH 的语言设置即时切换；宿主未提供语言服务时回退到英语。

`dsh-magpie-quota` 在 DSH 聊天输入框下方显示一排紧凑的「服务商图标 + 剩余百分比」，每个账号独立显示。点击图标查看该账号的额度窗口、重置倒计时、套餐、余额、读数时间与刷新按钮。设置 → **Magpie 额度** 展示全部账号的卡片。

图标的百分比取该账号**已返回的有限额窗口中的最低剩余值**。例如 5 小时剩余 75%、7 天剩余 63%，图标显示 63%；窗口分别展示，百分比不相加。不限额显示 `∞`，没有读数显示 `—`，余额账号显示返回的余额。读数异常或已回退到旧数据时，图标旁显示提示点。

## 安装

需要 Node.js ≥ 22.19、DSH `>=0.2.1-rc.2 <0.3.0`，以及支持额度接口的 Magpie。在仓库根目录执行：

```sh
pnpm --filter dsh-magpie-quota check
pnpm --filter dsh-magpie-quota pack:plugin
dsh plugin --profile web add "$PWD/dist/dsh-magpie-quota-0.1.0.tgz"
```

重启对应 Web profile 并刷新页面。桌面端通过桌面应用所用的插件管理入口安装同一压缩包，然后重新打开应用。部分独立 `dsh` CLI 不能管理保留的 `desktop` profile。

## 连接 Magpie

默认读取 DSH 实时 settings 中 ID 或名称包含 `magpie` 的提供商，复用其 `baseURL`、自定义 headers 和网关凭据。显式 `Authorization` / `x-api-key` 优先，其次是 `apiKeyEnv` 引用的凭据、该提供商保存的 pi-ai API Key。连接和凭据信息只在后端使用。

没有匹配的提供商时，默认尝试本机 Magpie，读取 `${XDG_CONFIG_HOME:-~/.config}/magpie/settings.json` 的 `port`，缺省端口为 3425。设置了明确的提供商列表或独立地址后不再自动回退到本机。

可以在 profile 的 `cordis.patch.yml` 按已插入的 ID 覆盖配置：

```yaml
- id: dsh-magpie-quota
  config:
    # 指定既有提供商；适合名称不含 magpie 的自定义提供商。
    providers: [office]
    cacheSeconds: 45
    discoverLocal: true
```

也可直接指定网关，不创建新的模型提供商：

```yaml
- id: dsh-magpie-quota
  config:
    baseURL: https://your-magpie.example/proxy/v1
    apiKeyEnv: MAGPIE_GATEWAY_KEY
    discoverLocal: false
```

地址可包含 `/v1` 和反向代理路径前缀。远端使用原有网关密钥，且必须允许网络访问。受预算、模型或账号限制的密钥默认不能读取账号额度；Magpie 所有者可通过 `magpie gateway-key quotas <id> on` 开启允许范围内的额度可见性。插件明确显示鉴权失败、权限不足、接口不存在与连接失败。

## 更新与数据范围

- 页面可见时每 30 秒同步一次；后端默认缓存 45 秒并合并并发请求。多个会话、设置页共享同一前端查询。页面隐藏时暂停定时同步，恢复可见时重新读取。
- 定时同步读取 `GET /v1/magpie/quotas`，仍受 Magpie 自身缓存和“仅主动询问时读取”策略影响。读数时间使用上游 `readAt` / `asOf`，不会用网页刷新时间替代。
- 点击账号的刷新按钮才调用 `POST /v1/magpie/quotas/refresh?provider=…&user=…`，随后重新读取标准化列表。相同账号 30 秒内不能重复主动刷新。Claude 保存账号的刷新可能由 Magpie 运行该账号自己的 Claude Code `/usage`。
- 网络失败可保留上次读数并注明状态；401 / 403 会移除之前可见的账号。更换网关地址或凭据后不复用旧凭据的缓存。
- 只展示 Magpie 返回且当前密钥有权查看的账号。不根据 DSH 的 Token 日志估算订阅余额，不推断未知窗口。嵌套远端账号可以展示，主动刷新需连接账号所属的 Magpie。
- 最近服务标记只说明该账号最近响应过请求；不承诺下一次请求选择同一账号。套餐有效期与额度窗口重置时间分别显示。

## 开发与验证

```sh
pnpm --filter dsh-magpie-quota check
pnpm --filter dsh-magpie-quota test:ui
pnpm --filter dsh-magpie-quota preview:ui
```

预览服务绑定 `0.0.0.0`，地址为 **http://100.96.195.115:4185/**。预览使用标明的演示数据，不连接真实账号。

单元测试覆盖窗口与卡片结构转换、多账号、缺失/无限额度、凭据与路径、缓存合并、断网回退、权限变更、刷新节流及 DSH 接口。浏览器回归使用 agent-browser，覆盖图标与展开明细、刷新和失败、键盘焦点与收起、设置页、深浅色、窄屏、大量账号和低高度窗口。真实网关查询与模拟刷新测试的范围分别记录，不把模拟成功当作真实账号刷新成功。

MIT。
