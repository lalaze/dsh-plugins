# 项目状态

[English](README.md) | **简体中文**

支持英文和简体中文，跟随 DSH 的语言设置并即时更新。

`dsh-project-status` 在对话的标签栏里加一个**状态**标签页，位于 Git 和统计之间。它显示这个对话所在项目的状态：项目要交付什么、推进到哪、卡在哪、下一步干什么，旁边是 Git 已经知道的事实。

## 一个项目一份状态

项目指一个 Git 仓库连同它所有的 worktree 和分支。对话在哪个检出里，看到的都是同一份状态；状态不进仓库，所以不会随分支分叉。不在 Git 里的目录自成一个项目。

状态是 DSH 主机上的一个 Markdown 文件：`~/.dsh/storages/dsh-project-status/projects/<名字>-<hash>.md`（设置了 `DSH_HOME` 时在它下面）。`<名字>-<hash>` 是仓库主目录名加上 common Git 目录路径的 SHA-256 前 8 位，和 Remote Terminals 给这个仓库的 worktree 目录起的名字一致。hash 取自路径：另一份克隆，或者另一台机器上的同一个仓库，算另一个项目。

```md
# shop

## 目标

支付页上线

## 进度

审核中，分支 `feat/pay`

## 卡点

等我确认文案

## 下一步

跑通回归，发布 1.0.16
```

四个标题可以用中文（`目标`、`进度`、`卡点`、`下一步`）或英文（`Goal`、`Progress`、`Blockers`、`Next`），顺序不限。其他小节在标签页保存时原样保留。

## 标签页

- **Git 说的事实**，不靠人写，所以不会过期：对话所在目录的分支、未提交文件数和未推送提交数，仓库的其他 worktree 数和 stash 数，最后一次提交时间，以及这个项目的对话数和最后活动时间。
- **四栏内容**，可以**编辑**和**保存**。保存以编辑开始时的内容为准：期间文件被改过，标签页会提示并保留你的编辑，不会覆盖。
- **让 agent 更新**把一段提示放进对话的输入框，TUI 对话则放到终端的提示符处，不会自动发送。提示里写明文件路径和四个小节，由 agent 自己读写文件。
- **复制给 AGENTS.md 的规则**复制几行可以贴进项目 `AGENTS.md` 或 `CLAUDE.md` 的规则，让 agent 开工前先读状态、停下时更新。贴不贴由你决定，插件不改仓库里的任何东西。
- 写了卡点时，**标签上有一个点**。

标签页每隔几秒重新读一次文件，agent 改完不用刷新就能看到。

## 其他机器上的工作区

「远程智能体」里保存的机器上的工作区，可以看到 Git 事实（通过那个插件的连接读取，需要 `dsh-remote-terminals`），也可以在标签页里编辑状态。文件仍在 DSH 主机上，那台机器上的 agent 打不开，所以那里两个给 agent 的按钮不可用。

## 给其他插件

服务端提供 `projectStatus` 服务：`get(folder)` 返回某个目录所属项目的状态，`list()` 返回在标签页里打开过的全部项目。

## 安装

```sh
pnpm --filter dsh-project-status pack:plugin
dsh plugin --profile web add "$PWD/dist/dsh-project-status-0.1.0.tgz"
```

## 开发

```sh
pnpm --filter dsh-project-status check
```
