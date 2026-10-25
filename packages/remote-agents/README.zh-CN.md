# DSH Remote Agents

[English](README.md) | **简体中文**

一个安装包同时提供原 `dsh-claude-ssh` 的完整 Claude 接入，以及多 CLI 远程任务面板。DSH 使用系统 OpenSSH 直接启动远程机器上的 CLI，负责发现供应商、读取模型、管理任务、保存输出、审批和恢复会话。**不需要安装 Paseo，也没有 Paseo SDK 或 daemon 依赖。**

## 支持的 CLI

| CLI | 直接执行协议 | 模型与权限 |
| --- | --- | --- |
| Claude Code | 原生 stream-json 与 control 通道 | CLI 模型列表、权限确认、结构化问题、原生 UUID 恢复 |
| Codex | 原生 `codex app-server` stdio | 模型与思考强度、沙箱模式、命令/编辑审批、原生 thread 恢复 |
| DSH | ACP v1 `dsh --profile acp` | acp profile 的模型与思考强度、原生审批与 `session/resume` 恢复 |
| Antigravity（反重力） | `agy` 原生 stream-json | CLI 模型列表、流式输出、原生会话恢复、信号中断；不支持逐次交互审批 |
| Grok | ACP v1 `grok agent --no-leader stdio` | CLI 公布的模型、思考强度与权限选项 |
| CodeBuddy | ACP v1 `codebuddy --acp` | CLI 公布的模型、思考强度、模式与权限选项 |

发现过程只初始化协议、读取目录和模型，不发送任务指令。ACP 同时支持旧模型/模式字段和新版 `configOptions`，按模型分别读取可用思考强度。CLI 未公布模型时使用「CLI 默认」，会话恢复要求它支持 `loadSession` 或声明 `session/resume`；不支持时保留任务输出并显示错误。远端需要预先安装并登录对应 CLI，模型列表不保证账户具有额度或访问权限。

DSH 使用远端 `acp` profile 的供应商、模型和凭据配置，不会自动继承 `web` profile 的插件与模型设置。恢复调用原生 `session/resume`，输出历史由本插件保留。参见 [DSH ACP 协议说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/acp/acp/README.md)。

反重力直接调用 `agy`，不使用 Hub 桥接或远程控制服务。`agy models` 提供模型列表，`--conversation` 恢复原生会话。远端还需 Node.js 22+：插件通过一个临时进程转发器向自己启动的 agy 发送中断信号，无需单独安装服务。**原生无头模式会拒绝需要交互审批的操作**，不会在本面板弹出逐次授权；运行前请在 agy 中配置所需权限。插件不会自动添加跳过权限检查的参数。参见 [Antigravity 无头模式](https://antigravity.google/docs/cli/headless/)。

Grok 使用官方 Grok Build CLI，显式关闭 leader 模式；CodeBuddy 使用其原生 ACP 模式，不要求另外部署服务。协议参考：[Grok Build](https://docs.x.ai/build/overview)、[CodeBuddy ACP](https://www.codebuddy.cn/docs/cli/acp)、[ACP 配置项](https://agentclientprotocol.com/protocol/v1/session-config-options)。

## 安装与原 Claude 插件迁移

需要 Node.js ≥22.15.0、DSH ≥0.2.1-rc.2 且 <0.3.0。

在**运行 DSH 的机器**下载安装包，无需克隆或构建仓库。下载见 [Remote Agents 0.4.1 Release](https://github.com/lalaze/dsh-plugins/releases/tag/remote-agents-v0.4.1)。Web profile 安装命令：

```sh
curl -fL -o dsh-remote-agents-0.4.1.tgz \
  https://github.com/lalaze/dsh-plugins/releases/download/remote-agents-v0.4.1/dsh-remote-agents-0.4.1.tgz
dsh plugin --profile web add "$PWD/dsh-remote-agents-0.4.1.tgz"
```

安装后重启对应的 DSH profile 并刷新浏览器，在「设置 → 远程任务」进入。使用自定义 profile 时将 `web` 替换为其名称。桌面端请先完全退出应用，使用**桌面应用自带的 `dsh` 命令**，将安装参数改为 `--profile desktop`，然后重新打开应用；npm 版 CLI 不能管理这个保留 profile。若宿主提供上传安装入口，也可上传下载的 tgz。

远端执行机器只需 SSH 和已安装、已登录的目标 CLI；使用反重力时还需 Node.js 22+。不必在每台执行机器上再安装本插件。插件尚未发布到 npm，请使用 Release 安装包，不要直接安装仓库根目录。

已经启用 `dsh-claude-ssh` 时，先在 DSH 中停用旧插件，再启用合并包并重启 DSH。不要让两个插件同时注册 Claude。**无需删除旧数据**：合并包沿用 `DSH_OMC_STATE_DIR` 或 `~/.local/state/dsh-oh-my-claude`，保留 `claude-code` / SSH 主机供应商 ID、登录状态、会话和远程工作区路由。旧版自定义插件参数放到合并包的 `claude` 配置对象下。

合并包将旧引擎、后台 keeper、客户端功能与许可声明打入安装包，不要求额外安装旧插件。原有对话中的 Claude 控件、模型目录、Memory、Rewind、Changes、主机与会话管理继续使用原实现。设置中的「远程任务 → Claude SSH」是旧管理界面的入口。

## 使用

1. 在运行 DSH 的机器上，确认可用密钥或 SSH agent 非交互连接远端，且已验证并保存 SSH 主机密钥。插件使用 `BatchMode=yes` 和 `StrictHostKeyChecking=yes`，支持 `~/.ssh/config` 别名与 ProxyJump。
2. 在「设置 → 远程任务 → CLI 任务」添加 `build-box`、`user@build-box` 或 `ssh://user@build-box:2222`。
3. 输入远端项目的绝对目录，点击「发现 CLI」，选择可用供应商、模型、权限模式和思考强度。
4. 输入任务并开始；在面板中处理原生审批、问题、工具输出、后续指令和停止操作。输入框旁也有远程任务入口。

任务在所选远程机器的项目目录运行。已有工作区列表展示此面板曾使用的目录，也可以直接输入任意可访问的绝对路径。不自动同步当前本地项目，不自动创建 worktree。

## 生命周期与数据

关闭面板或刷新浏览器不终止任务。DSH 进程退出、插件卸载或 SSH 中断会断开直接 CLI 进程；不保证远端执行跨这些中断存活。远端离线时仍可查看已保存的输出。重新连接使用保存的原生会话 ID，保留所选权限模式，不自动重放上一条指令。执行结果不明时先查看记录，再决定是否人工补发。

新任务先保存唯一请求 ID，再创建原生会话，最后发送指令；每次发送先落盘消息 ID。重复 HTTP 请求不会重复发送任务或后续消息。只有 CLI 原生回执或输出会确认送达；未确认的消息不会自动重试。原生会话创建响应丢失时，重试可能创建空会话，但尚未发送任务指令。

每台机器最多保留 8 个 CLI 连接；满额时仅自动回收已声明恢复能力的空闲会话，优先回收最久未使用的连接，保留其输出和原生会话 ID。执行中、等待审批或正在提交指令的会话不会被回收；从 Store 保存后续消息之前到提交结束，全程保留连接。保存失败也会释放这层保护。

未声明 `loadSession` 或 `session/resume` 的 ACP 会话保持连接，避免丢失继续对话的能力。需要释放名额时，可在任务完成后手动「断开会话」；界面会提示该 CLI 未声明恢复能力。断开会话仍可查看保存的输出，但不保证能够继续原对话。执行中和等待审批时不能断开。

创建任务或后续消息被明确拒绝时，页面解除对应的本地待提交状态并保留内容供修改；两个输入框均限制为 100,000 字符。超时或响应丢失时保留原请求 ID；也可以「清除此提交记录」或「清除此消息记录」解除本地锁定。这些清除操作不会停止任务或撤回已发送的消息，再次提交前应先查看任务列表与输出。

主机固定绑定 SSH 机器身份，任务绑定主机、规范化项目路径、CLI 和原生会话。状态保存在 `$DSH_HOME/storages/dsh-remote-agents/state.json`（默认 `~/.dsh`），输出在同目录 `events/*.jsonl`，文件权限 `0600`。可通过 `stateDir` 改位置。CLI 凭据留在远端；插件不保存 SSH 密码。保留这些文件以保留任务记录。

0.1.x 的 Paseo 主机和任务记录不会自动转换成 SSH 任务。旧地址或身份不匹配时会拒绝继续执行，原数据保留；需要新增直接 SSH 主机并创建新任务。

## 开发与验证

```sh
pnpm --filter dsh-remote-agents check
pnpm --filter dsh-remote-agents test:ui
pnpm --filter dsh-claude-ssh check
pnpm --filter dsh-remote-agents pack:plugin
```

40 项协议与服务测试、原 Claude 的 76 个测试文件，以及桌面/手机浏览器回归已通过。协议回归使用隔离的 CLI 测试传输，反重力进程转发器使用真实子进程检查信号中断，浏览器回归使用模拟远程机器。另已用本机真实 Codex、Claude、Grok、CodeBuddy 验证初始化与模型发现，用真实 DSH/agy 验证空会话启动和恢复；这些检查不发送推理任务。真实供应商任务与远程 SSH 环境仍需部署时验证。
