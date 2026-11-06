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
| `/flow stop` | End the flow running in this conversation |
| `/flow` | Show the current models |

Each step's result shows in the conversation. For the whole text, open the subagent list at the top: every step is a conversation you can open.

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
- The flow does not run inside the conversation's model, so that model does not know the result.
- A flow does not continue after DSH restarts.
- Read-only is enforced by DSH's sandbox. A Codex reviewer can run tests; a Claude Code reviewer can read code and git state, but its test commands are refused.
- A remote CLI only works in workspaces of its own machine. When the conversation itself uses a CLI on a machine, the same model on that machine is used.
- Needs DSH 0.2.1-rc.3 or later (tested on rc.5). With remote CLIs, use dsh-remote-agents 0.2.102 or later: older versions leave each finished subagent's process running on the remote machine.

## License

MIT
