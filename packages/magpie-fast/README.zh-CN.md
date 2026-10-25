# GPT Fast 闪电开关

[English](README.md) | **简体中文**

支持英语和简体中文，随 DSH 的语言设置即时切换；宿主未提供语言服务时回退到英语。

`dsh-magpie-fast` 在聊天输入框的工具栏中添加一个闪电按钮，放在权限控制之后、任务列表之前。**仅当前模型为 GPT 时显示**。点亮后，本会话的后续 GPT 请求携带 `service_tier: "priority"`；再次点击关闭。

沿用原有提供商、模型 ID、远端地址、网关密钥和推理强度，不创建额外的“Fast 提供商”，也不修改 Magpie 配置。支持 dsh 自定义 OpenAI Chat Completions / Responses 提供商，包括远端 Magpie。CLI 子进程及其他协议的提供商会显示禁用状态和说明。模型 ID 需要是 `gpt-*` 或 `provider/gpt-*`；不猜测自定义别名、路由组的实际模型。

## 安装

需要 Node.js ≥ 22.19、DSH `>=0.2.1-rc.2 <0.3.0`。在安装插件的机器上，从本仓库根目录打包：

```sh
pnpm install --frozen-lockfile
pnpm --filter dsh-magpie-fast pack:plugin
```

桌面版先完全退出 DSH，在仓库根目录使用桌面应用自带的 `dsh` 命令安装，再重新打开：

```sh
dsh plugin --profile desktop add "$PWD/dist/dsh-magpie-fast-0.1.1.tgz"
```

独立 npm CLI 不允许管理保留的 `desktop` profile。也可在桌面版「设置 → 插件 → 添加插件 → 安装第三方插件」中填写该压缩包的绝对路径，安装后重启。Web 版使用 `--profile web` 安装同一压缩包，然后重启该 profile 并刷新浏览器。

在已有会话中选择原来的 Magpie GPT 模型，点击工具栏上的闪电即可。远端 Magpie 继续使用该提供商原有的网关密钥；无需另填地址或重复导入模型。

从 `0.1.1` 起，插件通过 DSH 的 `dsh-llm-pi-ai` 适配器复用其已安装的 OpenAI 实现。安装包不再依赖完整的 `pi-ai`，不会为本插件额外安装 Google SDK、`protobufjs` 或要求批准它们的安装脚本。源码中的 `pi-ai` 开发依赖仅用于类型检查。

## 行为

- 默认关闭。图标灰色表示关闭，点亮表示已保存开启；保存失败时保留原状态并提示重试。
- 开关按会话保存，刷新页面及重启后保留。切换到非 GPT 时隐藏，切回 GPT 时恢复该会话状态。
- 点击只影响下一次开始的模型请求，已在进行中的请求继续使用它开始时的设置。同会话的 GPT 压缩、标题等辅助请求若携带会话 ID，也使用该开关。
- 未开启、非 GPT、未配置为 Chat/Responses 的模型及无会话 ID 的请求，继续由原来的适配器处理。
- 推理等级、温度、工具调用、用量、回放、文件与图片投影复用 dsh 的请求处理链路。插件不全局修改 `fetch`，不替换模型选择器。

Fast 请求的是上游优先处理档位，并不降低推理强度。实际服务档位和费用/额度消耗取决于上游。可在 Magpie 请求日志查看 `tier_sent` 和 `tier_served`，区分已发送的请求档位与上游实际返回的档位。

## 可选配置

profile 的 `cordis.patch.yml` 可以覆盖插件设置；安装包已插入该 ID，只需按 ID 覆盖：

```yaml
- id: dsh-magpie-fast
  config:
    defaultEnabled: false
    # stateDir: /your/private/state/directory
```

`defaultEnabled` 控制没有单独偏好的会话。显式开关优先。状态保存在 `${DSH_HOME:-~/.dsh}/storages/dsh-magpie-fast/preferences.json`，只含会话 ID 和布尔值，不保存提示词、回复或密钥。写入串行化、原子替换，文件权限 `0600`；最多保留最近设置的 10,000 个会话。不同 DSH 进程请使用独立 `stateDir`，不支持多个进程同时写同一文件。

插件从 Host 的实时 settings 读取当前提供商的 `baseURL`、`api`、`models`、headers 和凭据引用。这些信息仅在服务端使用，不下发给闪电按钮。远端连接优先使用原提供商的 `apiKeyEnv`；也可复用其 pi-ai API-key 登录记录或显式 Authorization 标头。

## 验证与开发

```sh
pnpm --filter dsh-magpie-fast check
pnpm --filter dsh-magpie-fast test:ui
pnpm --filter dsh-magpie-fast preview:ui
```

最后一条启动演示界面，地址为 `http://100.96.195.115:4184/`，服务绑定 `0.0.0.0`。演示不读取真实会话或调用模型。

`check` 同时验证实际安装包：在空目录中使用严格脚本策略离线安装，确认没有新增完整 `pi-ai`、Google SDK 或 `protobufjs`，再从已安装的压缩包复用宿主实现，验证 Chat/Responses 请求都携带 priority。

自动化还覆盖推理强度、流式文本和工具调用、用量与回放、会话隔离、状态保存失败与重载、原提供商目录保持不变，以及界面显示、持久化、键盘与浅深色/窄屏。测试使用模拟 API，不代表真实上游已经授予 priority 服务。

MIT。
