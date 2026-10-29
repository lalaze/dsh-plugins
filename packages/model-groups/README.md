# DSH Model Groups

**English** | [简体中文](README.zh-CN.md)

`dsh-model-groups` lets you fold the provider groups in DeepSeek Harness's model picker. Click a provider heading, such as **CodeBuddy Code**, to expand or collapse its models; On a focused heading, Enter or Space toggles it, and the left and right arrow keys collapse and expand it. The group holding the current model starts expanded and the others start collapsed. Your choices are remembered in this browser. Searching expands the matching groups, and clearing the search restores your choices. Each heading shows how many models it holds.

It works with any provider, including the remote CLIs of `dsh-remote-agents` and the menu `dsh-codex-subscription` puts in place of DSH's own. DSH keeps its outer menu, model labels, reasoning controls and other options; folding only adds behavior to the provider headings inside the model list, and markup it does not recognize is left as it is.

Build and install:

```sh
pnpm --filter dsh-model-groups check
pnpm --filter dsh-model-groups pack:plugin
dsh plugin --profile web add "$PWD/dist/dsh-model-groups-0.1.0.tgz"
```

Requires DSH ≥0.2.1-rc.2, <0.3.0. Refresh the client after installing.

## Coming from Remote Agents

Folding was part of `dsh-remote-agents` up to 0.2.56. Choices saved there carry over. While an older Remote Agents that still folds the groups itself is loaded, this plugin leaves the groups to it, so a click never folds twice; once Remote Agents is updated, this plugin takes over.

## Development

`pnpm --filter dsh-model-groups test` runs the folding tests against simulated menus in jsdom. The browser regression against DSH's official model menu runs from `dsh-remote-agents` (`pnpm --filter dsh-remote-agents test:models`), which loads this plugin's built client; build it first.
