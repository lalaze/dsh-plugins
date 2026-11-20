# Project Status

**English** | [简体中文](README.zh-CN.md)

Supports English and Simplified Chinese, following DSH's language setting with live updates.

`dsh-project-status` adds a **Status** tab to a conversation, between Git and Stats. It shows one status for the project the conversation works in: what the project is for, how far it is, what blocks it and what comes next, beside what Git already knows.

## One status per project

A project is a Git repository with all of its worktrees and branches. Whichever checkout a conversation is in, the tab shows the same status, and the status is not committed, so it never differs between branches. A folder outside Git is a project of its own.

The status is a Markdown file on the DSH host, `~/.dsh/storages/dsh-project-status/projects/<name>-<hash>.md` (under `DSH_HOME` when set). `<name>-<hash>` is the repository's main folder name and the first 8 hex digits of the SHA-256 of its common Git folder, the same name Remote Terminals gives the repository's worktree folder. The hash is of a path: another clone, or the same repository on another machine, is another project.

```md
# shop

## Goal

Ship the payment page

## Progress

Review in progress, branch `feat/pay`

## Blockers

Waiting for me to approve the copy

## Next

Run the regression and release 1.0.16
```

The four headings may be in English (`Goal`, `Progress`, `Blockers`, `Next`) or Chinese (`目标`, `进度`, `卡点`, `下一步`), in any order. Any other section is kept as it is when the tab saves.

## The tab

- **What Git says**, never out of date because nobody writes it: the branch, uncommitted files and unpushed commits of the conversation's folder, the repository's other worktrees and stashes, the last commit, and how many conversations the project has with the last time one was active.
- **The four texts**, with **Edit** and **Save**. A save is held against the text it started from: when the file changed meanwhile, the tab says so and keeps your edit instead of overwriting.
- **Ask the agent to update** puts a request into the conversation's input, or at the prompt of a TUI conversation, without sending it. The request names the file and the four sections; the agent reads and writes the file itself.
- **Copy the rule for AGENTS.md** copies a few lines for the project's `AGENTS.md` or `CLAUDE.md`, so that agents read the status before they start and update it when they stop. Whether to paste it is up to you; the plugin changes nothing in the repository.
- A **mark on the tab** while a blocker is written down.

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
