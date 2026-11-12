# DSH Model Flow

[中文](README.zh-CN.md)

Model division of labour for DeepSeek Harness: one command, one model plans, one implements, one reviews, and rejected work goes back to be fixed.

The plugin's code runs the loop, so no model can skip the review or pass its own work.

## Use

Choose the three models and their thinking levels in **Settings → Model flow** (planning can be skipped), then in any conversation:

```text
/flow add CSV to the export
```

Or change the models for one run:

```text
/flow plan=off impl=codex/gpt-6.1-sol review=claude/opus@high rounds=2 add CSV to the export
```

| Form | Meaning |
|---|---|
| `plan=` `impl=` `review=` | The model for this run: `codex`, `claude/haiku`, `qwen`, optionally `@thinking` |
| `plan=off` | Skip planning |
| `rounds=n` | Review rounds at most: 3 by default, up to 10 |
| `wt=on` `wt=off` | Run this one in a worktree of its own, or in this conversation, whatever the settings say |
| `repo=` `branch=` | For a worktree: which repository, and which branch it starts from (quotes around a name with spaces) |
| `/flow stop` | End the flow running in this conversation, like the Stop button on its card |
| `/flow` | Show the current models |

A flow is one card in the conversation. While it runs, the card says what is happening, how long it has taken, and has **Stop**; a progress bar covers every step the flow can still take (the plan, then each round's implementation and review); and a timeline lists the steps with their model and time, the latest thing the running step is doing, and the first line of what a review sent back. When it ends, the card shows the outcome (passed in which round, sent back how often, or why it stopped), the steps fold away, and the report is part of the card: what was built and what the review found. Show the steps again from the card, click a step for its whole result, and **Open** to read that step's conversation beside the chat. Passed is green, sent back orange, failed red.

Attach images and files to `/flow`, with or without a written goal. Every step receives the attachments, including later rounds and a review asked again for its missing verdict. If any selected model declares that it does not support images, a flow with images will not start.

## In a worktree of its own

By default a flow changes the files of the workspace its conversation is in, and ends when the review passes. With `wt=on`, or with **A typed /flow runs in → A worktree of its own** in the settings, it becomes a task of [dsh-autofix](../autofix/README.md) instead:

```text
/flow wt=on add CSV to the export
```

- The task gets a worktree, a branch (`feat/<number>`) and a conversation of its own in the repository this conversation works in. That repository must be one of **Settings → Autofix → Repositories**.
- It runs the same plan, implement and review, with the models and rounds of the line or the settings. After the review come the repository's checks and a local commit; nothing is merged or pushed before you accept, and after that the card asks whether the worktree can go.
- The card this line leaves follows the task, and the flow's card in the task's conversation carries the task: the same card as any flow, with **Checks** and **Acceptance** at the end of its progress bar, and Accept or Send back under the report.
- Only pictures can be attached. In the task's own conversation, `/flow <what is still wrong>` sends the work back, as `/fix` does there.
- Needs dsh-autofix 0.1.4 or newer; without it the line says so, and `wt=off` runs in the conversation.

## Common combinations

**Settings → Model flow** keeps named sets of models, thinking levels and rounds. Click one to use it; **Save current** adds what the rows show now, and using a name again replaces that one. The pencil on a card renames it; two cannot share a name. A few to start from appear the first time, made from the models you have, and you can delete them.

## The flow

1. **Plan** (read-only): the steps and the acceptance criteria.
2. **Implement**: changes the code in the workspace.
3. **Review** (read-only): checks the goal and the criteria, and ends with `pass` or `needs_revision`.
4. On `needs_revision` the findings go to a new implementation round and then to review again. When the rounds run out, it stops and leaves the decision to you.

A review with no verdict is asked once more. If there is still none the flow stops; it never counts as a pass.

## Worth knowing

- Each implementation and review round is a new session. It picks up from the prompt and the changes in the working tree, not the previous round's conversation.
- The flow does not run inside the conversation's model. That model hears how the flow ended with your next message, so "release it" means something to it.
- A flow does not continue after DSH restarts. Its card then says so, with the steps it got through.
- Read-only is enforced by DSH's sandbox. A Codex reviewer can run tests; a Claude Code reviewer can read code and git state, but its test commands are refused.
- With remote Claude Code or Codex, planning and review can search the web, and Claude Code can read pages too, so a model may send workspace content out in a search query or URL.
- Stopping interrupts the step's model at once, and the commands it started in that step end too. The exception is Codex 0.164's workspace sandbox on Linux, where a command runs on to its end.
- A remote CLI only works in workspaces of its own machine. In a workspace on a saved machine, the same model on that machine is used, whichever machine you chose it on (needs dsh-remote-agents 0.2.130 or later). When that machine does not have the model, the flow does not start, and says which model is missing and what the machine has.
- With remote CLIs, each step uploads its own copy of the attachments to the remote workspace. These copies are not cleaned up automatically.
- Needs DSH 0.2.1-rc.3 or later (tested on rc.5 and 0.2.2-rc.1). With remote CLIs, use dsh-remote-agents 0.2.114 or later: older versions do not end the commands Codex started when you stop, and Claude Code cannot search the web while planning or reviewing; those before 0.2.113 do not pass the flow's result to a remote CLI conversation or show which tool a delegated Codex is running, and those before 0.2.102 leave each finished subagent's process running on the remote machine.

## For other plugins

The service `modelFlow` (version 2) runs a flow in a conversation, as a typed `/flow` does, and answers how it ended: `start(agent, { goal, rounds?, models?, attachments?, tag? })` resolves to `{ done, stop, progress, stepBody }`, where `done` gives the ending, the report and the steps, `progress()` is the flow's card as it is now, and `stepBody(index)` one finished step's full result. `tag` names the flow for the plugin that started it, as `<plugin>:<its own words>`; the card carries it. A flow whose model cannot read attached images is refused with the code `flow/images-unsupported`.

In the page, the client service `modelFlowSettings` (version 1) offers `Models`, a React component with the combinations and the model of each job, for another plugin's settings page whose work runs as flows. It reads and saves this plugin's own choice, the one `/flow` uses.

The client service `modelFlowCard` (version 1) offers the card itself: `View` draws a flow from `{ card, active, report?, stop?, stepBody? }`, with `head` (what stands at the top instead of the flow's own words), `stages` (steps after the flow, at the end of the progress bar), `caption` and children around it. `extend(prefix, { Card, claims, Row })` lets a plugin draw the cards of the flows it tagged with that prefix, and the rows its server answered a handed-over `/flow` line with. dsh-autofix draws its tasks this way.

## License

MIT
