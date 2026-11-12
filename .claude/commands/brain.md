---
description: Adopt one persona for this session, optionally named in the arguments, and declare persona, skills, tools, model, harness, and effort before working
argument-hint: [persona] [request]
---

Read `AGENTS.md`. If `$ARGUMENTS` starts with a persona name from `agents/`, adopt that persona; the rest is the request. Otherwise classify the request in `$ARGUMENTS` (or ask for it) and adopt exactly one persona from `agents/`.

Read the persona file. Load its skills (the `skills:` line, or the `Skills` line under its heading) from `skills/<name>/SKILL.md` as their triggers match, and its tools (the labels in the `Tools` line under its heading, or its `tools:`). Declare before any work:

```
Persona: <name>
Skills: <loaded now>
Tools: <in use>
Model: <the model you are running as>
Harness: <the tool running you>
Effort: <thinking effort>
```

When first-party brain tracing is enabled and this persona has Bash, record the adopted persona and established ticket ID through its context operation:

```bash
node "$HOME/.cache/agent-brain/bootstrap/brain-trace.cjs" context --actor <current-hook-actor> set --persona <adopted-persona> --ticket <established-ticket-id>
```

Use the exact actor supplied by this actor's tracing hook context; never copy a parent's actor into a child or guess a session. If no actor was supplied, report tracing context unavailable instead of fabricating one. Ordinary Bash commands are not rewritten. Use `brain-trace.cjs exec --actor <current-hook-actor> --harness pi|claude -- <native-args>` for traced subprocess children, or `launch --actor <current-hook-actor> ...` for an owned pane.

Shell-less personas must not call this unavailable shell operation or gain Bash for bookkeeping. A known native `agent_type` can establish persona, and a known ticket can inherit through an exact parent/launch binding. If a new/different child ticket needs an unavailable update operation, report context-update unavailability and do not claim the structured state was updated. Known inherited context is not evidence that the new ticket was recorded; otherwise unsupported attribution stays `UNKNOWN`, never a guessed value or borrowed parent actor.

Omit `--ticket` until it is known. Pass only non-secret identifiers, never task text or credentials. Update this structured context when persona or ticket changes; a prose declaration is not telemetry state. Skill attribution comes from observed invocations/loads, not the persona's permitted-skills list.

Re-declare whenever you add a skill or tool. Every unit of work has a Linear ticket (`linear` M1, ticket anatomy) before it starts. Ensure the main agent's visible runtime name is `<ticket>-<slug> (<persona>)` with a worktree, or `<ticket> <scope> (<persona>)` without one. For long-running or out-of-persona work, or parallel hands, start subagents: show the plan (name, persona, scope, ticket, type), ensure each subagent's visible runtime name follows the same form with its own worktree and persona, and ask the user for its model, harness, and effort first. Give a subagent its persona and scope only; it loads its own skills and tools. Never hold two personalities.
