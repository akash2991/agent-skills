---
description: Show the main agent and every subagent with runtime name, worktree, persona, skills, tools, model, harness, thinking effort, and ticket
---

When first-party brain tracing is enabled and `brain_context` is available, query it with no arguments before reporting your structured persona/ticket/runtime and observed skill state. Do not claim permitted or merely installed skills were invoked; distinguish loaded from invoked skills. Missing telemetry remains `UNKNOWN`, not inferred from prose declarations.

Print the current state of the agents in this session, the main agent (you) first, then every subagent you started, one block each:

```
Agent: main | subagent <id>
Runtime Name: <the name the harness shows, normally `<ticket>-<slug> (<persona>)` or `<ticket> <scope> (<persona>)`; - if none>
Worktree: <path or ->
Persona: <name>
Skills: <loaded, in load order>
Tools: <in use>
Model: <model>
Harness: pi
Effort: <thinking effort>
Ticket: <id or ->
Type: - | fire-and-forget | fire-and-summarize
State: working | done | blocked
```

Report only what you know. A subagent that has not declared is `UNKNOWN` in every field you did not set yourself; ask it to declare rather than guessing. Do nothing else.
