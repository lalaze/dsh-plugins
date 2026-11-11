# TAPD

**English** | [简体中文](README.zh-CN.md)

TAPD as a source of bugs for [Autofix](../autofix/README.md): the open bugs under your TAPD name go in, pictures in their descriptions included, and status and comments are written back as each fix moves along. This plugin only talks to TAPD; worktrees, models, checks and acceptance are Autofix's.

> Not released yet: the package is private and the market skips it.

## Settings

**Settings → TAPD**:

- **Sign-in**: a personal access token, or an API account and password. Kept in `~/.dsh/storages/dsh-tapd/settings.json`, readable only by you, and never sent back to a page.
- **Which bugs**: your TAPD name (as in a bug's current owner), the TAPD projects, and the statuses to fetch, as API values (`new`, `reopened`) or as your project shows them (`待处理`).
- **What is written back**: the status of an accepted bug (default `resolved`), an optional status when a task starts, and whether a fix that waits for you is said in a comment.

**Test** asks TAPD for your open bugs with the saved settings.

## What is written to TAPD

| When | Written |
| --- | --- |
| A task starts | The in-progress status, if one is set |
| A fix waits for you | A comment with the branch, the commit and the checks, if comments are on |
| You accept | The done status and a comment with the merge commit or the pushed branch |

Comments are in Chinese when the bug's title is, in English otherwise. If TAPD refuses the last write, Autofix keeps it and offers **Write back again**.

## Requirements

- DSH 0.2.2-rc.1 or newer, and `dsh-autofix`.
