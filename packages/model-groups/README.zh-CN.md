# DSH Model Groups

[English](README.md) | **简体中文**

`dsh-model-groups` 让 DeepSeek Harness 模型选择器中的提供方分组可以折叠。点击 **CodeBuddy Code** 等提供方标题即可展开或收起该组模型；焦点在标题上时，按 Enter 或空格切换折叠，按左、右方向键分别收起、展开。当前模型所在的分组默认展开，其余分组默认收起；手动选择保存在当前浏览器中。搜索时会展开匹配的分组，清空搜索后恢复原来的折叠状态。每个标题旁显示该组的模型数量。

适用于所有提供方，包括 `dsh-remote-agents` 的远程 CLI，以及 `dsh-codex-subscription` 替换 DSH 原生菜单后的模型菜单。外层菜单、模型标签、推理等级和其他选项仍由 DSH 负责；插件只为模型列表内的提供方标题增加折叠功能，遇到无法识别的结构会保持原样。

构建并安装：

```sh
pnpm --filter dsh-model-groups check
pnpm --filter dsh-model-groups pack:plugin
dsh plugin --profile web add "$PWD/dist/dsh-model-groups-0.1.0.tgz"
```

需要 DSH ≥0.2.1-rc.2 且 <0.3.0。安装后请刷新客户端。

## 从远程智能体迁移

0.2.56 及之前的 `dsh-remote-agents` 自带分组折叠，当时保存的折叠选择会保留。如果仍加载着自带折叠的旧版远程智能体，本插件会把分组交给它处理，避免一次点击被折叠两次；远程智能体更新后，本插件会接管。

## 开发

`pnpm --filter dsh-model-groups test` 在 jsdom 中用模拟菜单测试折叠逻辑。基于 DSH 官方模型菜单的浏览器回归由 `dsh-remote-agents` 运行（`pnpm --filter dsh-remote-agents test:models`），它会加载本插件构建好的客户端，请先构建本插件。
