# Project Status

**English** | [简体中文](README.zh-CN.md)

Supports English and Simplified Chinese, following DSH's language setting with live updates.

`dsh-project-status` adds a **Status** tab to a conversation, between Git and Stats. It shows the status of the project the conversation works in: what the project is for, and for each goal under way how far it is, what blocks it and what comes next, beside what Git already knows.

## One status per project

A project is a Git repository with all of its worktrees and branches. Whichever checkout a conversation is in, the tab shows the same status, and the status is not committed, so it never differs between branches. A folder outside Git is a project of its own.

The status is a Markdown file on the DSH host, `~/.dsh/storages/dsh-project-status/projects/<name>-<hash>.md` (under `DSH_HOME` when set). `<name>-<hash>` is the repository's main folder name and the first 8 hex digits of the SHA-256 of its common Git folder, the same name Remote Terminals gives the repository's worktree folder. The hash is of a path: another clone, or the same repository on another machine, is another project.

```md
# shop

## Goal

Take payments in the shop this year

## Sub-goals

### [ ] Payment page

- [x] Design
- [ ] Regression

#### Progress

Review in progress, branch `feat/pay`

#### Blockers

Waiting for me to approve the copy

#### Next

Run the regression and release 1.0.16

### [x] Icons
```

Each third-level heading under Sub-goals is one goal with a status of its own: `[x]` in the heading says it is reached, the task list under it is its to-dos, and the fourth-level headings Progress, Blockers and Next are its three texts, each left out when there is nothing to say. The things a project has under way at once each get a goal, so they are not mixed up.

The headings may be in English (`Goal`, `Sub-goals`, `Progress`, `Blockers`, `Next`) or Chinese (`大目标`, `小目标`, `进度`, `卡点`, `下一步`). Any other section, and any other fourth-level section under a goal, is kept as it is when the tab saves.

## The tab

- **What Git says**, never out of date because nobody writes it: the branch, uncommitted files and unpushed commits of the conversation's folder, the repository's other worktrees and stashes, the last commit, and how many conversations the project has with the last time one was active.
- **Overall goal** is a text: what the project as a whole is for.
- **Goals** are a card each: the box says it is reached, and under it are its own to-dos, progress, blockers and next step. A card can be closed to one line that says where it stands (the blocker when there is one, otherwise the next step); a goal that is reached starts closed. Type into the last line and press Enter to add a goal.
- Every text is edited where it stands. There is no edit mode and no Save button: it is saved a moment after you stop typing, and when you leave it; to-dos are ticked directly.
- Each text is saved by itself, against what it said when you began: when the same text was changed elsewhere meanwhile, the tab shows both and you choose **Use the new text** or **Keep mine**; a change to another goal or another text does not get in the way.
- **Ask the agent to update** puts a request into the conversation's input, or at the prompt of a TUI conversation, without sending it. The request names the file and its layout, and asks the agent to update only the goal this conversation worked on; the agent reads and writes the file itself.
- **Copy the rule for AGENTS.md** copies a few lines for the project's `AGENTS.md` or `CLAUDE.md`, so that agents read the status before they start and update it when they stop. Whether to paste it is up to you; the plugin changes nothing in the repository.
- A **mark on the tab** while a goal that is not reached has a blocker written down.

The tab reads the file again every few seconds, so an agent's edit shows without a reload.

## Workspaces on another machine

A workspace on a machine saved in Remote Agents shows Git's facts, read over that plugin's connection (it needs `dsh-remote-terminals`), and its status can be edited in the tab. The file stays on the DSH host, where an agent on the other machine cannot open it, so the two agent buttons are off there.

## For other plugins

The host half provides the service `projectStatus`: `get(folder)` answers the status of the project a folder belongs to, `list()` every project that has been opened in the tab.

## Install

```sh
pnpm --filter dsh-project-status pack:plugin
dsh plugin --profile web add "$PWD/dist/dsh-project-status-0.1.0.tgz"
```

## Development

```sh
pnpm --filter dsh-project-status check
```
