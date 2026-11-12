# Autofix

**English** | [简体中文](README.zh-CN.md)

Bugs fixed inside DeepSeek Harness. Whatever source hands a bug in, it gets its own Git worktree and conversation, runs through plan → implement → review ([dsh-model-flow](../model-flow/README.md)), and stops at a local commit. Nothing is pushed, and the source is not told the bug is fixed, until you accept the fix.

> Not released yet: the package is private and the market skips it.

## Filing and accepting in a conversation

In any conversation of the project, type `/fix` and what is wrong; screenshots can be pasted along:

```
/fix the activity page is blank on iOS
```

- The repository is the one that conversation's workspace belongs to; elsewhere, start the line with `repo=<name>`, and `branch=<name>` for another branch (quotes around a name with spaces).
- The bug is fixed in its own worktree and its own conversation. A card stays in this conversation with the progress and a way to open that one.
- When the fix is ready, a card appears in the task's conversation: read the models' report and the changes, then accept or send back. Typing `/fix <what is still wrong>` there, with screenshots if needed, also sends it back.
- A task that fails puts a card there too, with a way to continue.

The board still lists every bug and task; bugs from TAPD and other sources are handed out from there.

Something to build goes the same road: `/flow wt=on <what to build>` ([dsh-model-flow](../model-flow/README.md) 0.1.11 or newer) makes a task here on a branch `feat/<number>`, worded for the models as a task rather than a bug, committed as `feat: …`, and with the models and rounds its line chose. With that version a task's card is the flow's own card: the same progress a `/flow` shows, then **Checks** and **Acceptance** at the end of the bar, and what you can decide under the report. In the task's own conversation the newest flow's card carries the task, so there is one card instead of two; earlier flows' cards stay as records of their rounds.

## Typing in one DSH, fixing in another

For working in the DSH on a laptop while a machine that is always on runs the fixes:

- On the DSH that runs fixes, add the repository and switch on "Take bugs from other DSHes" in Settings → Autofix.
- The laptop's DSH only needs this plugin: no repository to add, no address or password of the other one.
- Type `/fix` in a conversation of that project on the laptop. The bug is handed over through the machine that holds the repository; the card stays in that conversation, with the progress, the report, the changes, and accepting or sending back.

Both DSHes reach the machine that holds the repository, and the handover happens there, in `~/.dsh-autofix` of your own account. Whoever can sign in to that account can file and accept bugs, which is the boundary that already lets them change the repository. Both DSHes need `dsh-remote-agents` 0.2.130 or newer and `dsh-remote-terminals`; only the one that runs fixes needs `dsh-model-flow`.

## Sources

Autofix does not know any issue tracker. Bugs reach it from **sources**:

- **Typed in**, built in: **New bug** on the board takes a title, a description and up to 8 pictures (chosen, pasted from the clipboard, or dropped on the form).
- **Plugins of their own** that know a tracker or anything else bugs come from: [dsh-tapd](../tapd/README.md) is the first. Several can be installed at once; their bugs share one board, and each keeps its own sign-in and settings.

A bug's pictures are given to every model step as attachments, marked `[image N]` in the description. If one of the flow's models cannot see pictures, the task runs from the text and says so.

## What it does

1. **Fetch** asks every source for its open bugs; **New bug** adds one by hand. A source can also hand bugs in by itself.
2. **Assign** each bug a repository and a base branch (and, in a monorepo, optionally a package). A bug like earlier ones (same source and title prefix such as `【活动页】`, or same project in the source) gets the same place automatically.
3. **Start**: a worktree on a new branch `<source>/<bug>`, a conversation in it, and a model flow whose goal is the bug.
4. **Checks**: after the review passes, sensitive files and secrets are refused, then the repository's check commands run. A failed check goes back to the models.
5. **Waiting for you**: the fix is committed locally. Read the report and the diff, then **Accept** or **Send back** with what should change, in words, in screenshots (chosen, pasted or dropped), or both.
6. **Accept** merges into the base branch and pushes (or only pushes the branch, per repository), then tells the source, which writes back whatever it writes back.
7. **Remove workspace**: once the fix is out, the card it was accepted on asks whether its workspace can go; nothing is removed before you say yes. The worktree is deleted, its conversation archived, and its branch deleted when it was merged (a branch that was only pushed stays). A workspace holding files that are not committed or commits that are not pushed is left alone. A finished task keeps the button for later.

The board opens from the **Bugs** button in a conversation's header, or from **Settings → Autofix**.

## Requirements

- DSH 0.2.2-rc.1 or newer.
- `dsh-remote-agents` 0.2.130 or newer with `dsh-remote-terminals`, for worktrees on this computer and on saved SSH machines.
- `dsh-model-flow` 0.1.7 or newer on the DSH that runs fixes; from 0.1.8 its models are chosen right in **Settings → Autofix**.
- Git 2.38 or newer on the machine that holds the repository (accepting uses `git merge-tree --write-tree`).
- At least one source plugin.

A plugin from this list that is not running is named on the settings page, where it is needed, with a button that installs it from your plugin markets.

## Settings

**Settings → Autofix** holds everything a fix depends on, also what other plugins keep: the repositories, the models that plan, implement and review (Model flow's own choice, the same one `/flow` uses), how tasks run, and where bugs come from. A source plugin such as dsh-tapd puts its settings there, under the sources, instead of on a page of its own.

 A repository is a DSH workspace that is the Git repository ("project"), on this computer or on a remote machine. For a repository DSH has not opened yet, type its folder's path on the computer DSH runs on, and DSH opens it as a workspace. Per repository:

- **Checks before committing**: one command per line. `{package}` and `{script}` run the line once for each package the fix touched; `{script}` is the first of **Build scripts** that package has.
- **Package folders** (`packages/*`) and **Shared paths**: for a monorepo. The package is decided from the files the fix changed, not guessed from the bug. A fix touching several packages is shown as a warning, not refused.

## Safety rules

- The models are told not to commit, push or write to any tracker; committing, merging and pushing are done by the plugin.
- Changes to `.env*`, `.npmrc`, SSH keys or `secret(s)` paths, and added lines that look like a token, an API key or a private key, are never committed.
- Bugs labelled `security`, `payment`, `auth`, `migration` or `prod-incident` are not started (the list is a setting).
- The repository's own worktree setup commands (`.dsh/worktree.json`) run without asking when a task starts.

## Writing a source

A source is a DSH plugin that registers with the service `autofix`:

```ts
ctx.inject(['autofix'], scoped => {
  const remove = scoped.autofix.register({
    id: 'tracker',                 // lowercase; part of every bug's key, branch and commit message
    name: 'Tracker',
    unready: () => signedIn ? undefined : { key: 'Sign in to Tracker first.' },
    fetch: async signal => [{ source: 'tracker', id: '42', ref: '42', title: '…', body: 'plain text', url: 'https://…', project: { id: 'web', name: 'Web' }, labels: [] }],
    report: async (item, event) => { /* event.kind: 'started' | 'review' | 'accepted' */ },
    image: async (item, index) => ({ data: bytes, mediaType: 'image/png' }),   // picture `index` of an item with `images: n`
  });
  scoped.effect(() => remove);
});
```

- `fetch` returns everything open right now; a bug it no longer lists is shown as no longer open. Leave it out for a source that is not asked, and call `autofix.submit(id, items)` whenever there are bugs (an alert, a webhook, a chat message).
- `report` is told when a task starts, when a fix waits for a person (branch, commit, checks), and when it is accepted (merge commit). What it writes back is its own business. If it rejects on `accepted`, the task keeps the event and offers **Write back again**; nothing in Git is undone.
- `image` hands over one picture of an item that says how many it has (`images`); it is asked when a task starts. `discard` is called when an item is fixed or thrown away.
- Items are checked on the way in; `id` and `title` are required.

A source's settings belong in Autofix's page. The source plugin's client registers them with the client service `autofixSources` (version 1), which exists while Autofix 0.1.2 or newer is there: `register(id, { name, Panel, text? })` returns a function that takes them out again. `Panel` is a React component drawn under the source's line with the prop `embedded`; `text(key, values)` translates the source's own messages, such as the one `unready` returns. Without that service, the source registers a settings page of its own.

## Not there yet

- Managing the pool from a second DSH, previews, and fetching on a timer.
- A task interrupted by a DSH restart is marked stopped; **Continue** resumes it in the same worktree.
