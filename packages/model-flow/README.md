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
| `/flow stop` | End the flow running in this conversation, like the Stop button on its card |
| `/flow` | Show the current models |

A flow is one card in the conversation. While it runs, the card says what is happening, how long it has taken, and has **Stop**; a progress bar covers every step the flow can still take (the plan, then each round's implementation and review); and a timeline lists the steps with their model and time, the latest thing the running step is doing, and the first line of what a review sent back. When it ends, the card shows the outcome (passed in which round, sent back how often, or why it stopped), the steps fold away, and the report is part of the card: what was built and what the review found. Show the steps again from the card, click a step for its whole result, and **Open** to read that step's conversation beside the chat. Passed is green, sent back orange, failed red.

Attach images and files to `/flow`, with or without a written goal. Every step receives the attachments, including later rounds and a review asked again for its missing verdict. If any selected model declares that it does not support images, a flow with images will not start.

## Common combinations

**Settings → Model flow** keeps named sets of models, thinking levels and rounds. Click one to use it; **Save current** adds what the rows show now, and using a name again replaces that one. A few to start from appear the first time, made from the models you have, and you can delete them.

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
- A remote CLI only works in workspaces of its own machine. When the conversation itself uses a CLI on a machine, the same model on that machine is used.
- With remote CLIs, each step uploads its own copy of the attachments to the remote workspace. These copies are not cleaned up automatically.
- Needs DSH 0.2.1-rc.3 or later (tested on rc.5 and 0.2.2-rc.1). With remote CLIs, use dsh-remote-agents 0.2.114 or later: older versions do not end the commands Codex started when you stop, and Claude Code cannot search the web while planning or reviewing; those before 0.2.113 do not pass the flow's result to a remote CLI conversation or show which tool a delegated Codex is running, and those before 0.2.102 leave each finished subagent's process running on the remote machine.

## License

MIT
