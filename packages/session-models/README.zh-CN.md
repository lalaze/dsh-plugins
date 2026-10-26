# DSH 会话模型

[English](README.md) | **简体中文**

支持英语和简体中文，随 DSH 的语言设置即时切换；宿主未提供语言服务时回退到英语。

`dsh-session-models` 在 DeepSeek Harness 侧栏中显示每个会话使用的模型。会话标题前的位置显示厂商图标（Claude、OpenAI、DeepSeek、Gemini、Grok、Qwen、Kimi、GLM、豆包、MiniMax、Mistral、Antigravity、CodeBuddy，或通用标记）。DSH 自带的状态标记保留为图标右下角的小徽标：运行中为转圈，等待审批或回答为黄点，完成为绿点，失败为红点，定时任务为时钟。悬停卡片额外显示具体模型；`dsh-remote-agents` 会话还会显示远端 CLI。

构建和安装：

```sh
pnpm --filter dsh-session-models check
pnpm --filter dsh-session-models pack:plugin
dsh plugin --profile web add "$PWD/dist/dsh-session-models-0.1.0.tgz"
```

图标对应会话下一次请求将使用的模型，与 DSH 模型选择器显示的一致。优先按模型名判断厂商，因此聚合服务或多模型 CLI 显示模型本身的厂商；无法判断时再按服务商判断。历史尚未加载的会话在其行出现时读取一次 DSH 会话投影，不会打开对话。旧存储格式的会话在打开一次（DSH 会升级其格式）之前没有模型信息；未知模型的会话和已归档会话保持 DSH 默认样式。

DSH 没有可与状态标记并排渲染的扩展位，因此插件通过样式表按行结构（`data-row-key="session:<id>"` 及行首单元格）装饰侧栏，不修改 DSH 的 DOM。DSH 更新若改变该结构，图标可能在插件更新前不显示，状态和导航不受影响。

`pnpm --filter dsh-session-models test:ui` 使用宿主行结构的副本运行浏览器回归，需要 `agent-browser`。设置 `DSH_TEST_SCREENSHOTS=<目录>` 可保留浅色和深色截图。

图标来自 [LobeHub Icons](https://github.com/lobehub/lobe-icons)（MIT），见[第三方声明](THIRD_PARTY_NOTICES.md)。可用 `node scripts/vendor-icons.mjs <解压后的 @lobehub/icons-static-svg>` 重新生成。
