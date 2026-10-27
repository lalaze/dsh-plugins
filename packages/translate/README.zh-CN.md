# DSH 翻译

[English](README.md) | **简体中文**

支持英语和简体中文，随 DSH 的语言设置即时切换；宿主未提供语言服务时回退到英语。

`dsh-translate` 为 DeepSeek Harness 增加翻译设置页、输入框旁的翻译按钮（也支持 `Alt/Option+T`）以及聊天选中文本翻译。服务端调用任意兼容 OpenAI Chat Completions 的接口，可配置备用接口，并在本地记录 token 用量；账本不保存原文和译文。

构建和安装：

```sh
pnpm --filter dsh-translate check
pnpm --filter dsh-translate pack:plugin
dsh plugin --profile web add "$PWD/dist/dsh-translate-0.1.1.tgz"
```

在 **设置 → 翻译** 填写接口地址、Key 和模型。Key 保存在当前浏览器配置中，只发送到填写的接口。单次翻译最多 5000 字符，同时最多处理 3 个请求。
