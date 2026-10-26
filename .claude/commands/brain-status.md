---
description: Show the main agent and every subagent with runtime name, worktree, persona, skills, tools, model, harness, thinking effort, and ticket
---

When first-party brain tracing is enabled, query its non-secret structured state before reporting:

```bash
node "$HOME/.cache/agent-brain/bootstrap/brain-trace.cjs" context --actor <current-hook-actor> status
```

Use only this actor's exact hook-supplied actor value; never borrow a parent's value or guess an active session. If unavailable, report `UNKNOWN`.

Use this for the adopted persona/ticket/runtime and observed skill state. Do not claim permitted or merely installed skills were invoked; distinguish loaded from invoked skills. Missing telemetry remains `UNKNOWN`, not inferred from prose declarations.

Print the current state of the agents in this session, the main agent (you) first, then every subagent you started, one block each:

```
Agent: main | subagent <id>
Runtime Name: <the name the harness shows, normally `<ticket>-<slug> (<persona>)` or `<ticket> <scope> (<persona>)`; - if none>
Worktree: <path or ->
Persona: <name>
Skills: <loaded, in load order>
Tools: <in use>
Model: <model>
Harness: <harness>
Effort: <thinking effort>
Ticket: <id or ->
Type: - | fire-and-forget | fire-and-summarize
State: working | done | blocked
```

Report only what you know. A subagent that has not declared is `UNKNOWN` in every field you did not set yourself; ask it to declare rather than guessing. Do nothing else.
