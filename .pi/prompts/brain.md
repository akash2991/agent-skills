---
description: Adopt one persona for this session, optionally named in the arguments, and declare persona, skills, tools, model, harness, and effort before working
---

Read `AGENTS.md`. If the arguments start with a persona name from `agents/`, adopt that persona; the rest is the request. Otherwise classify the request (or ask for it) and adopt exactly one persona from `agents/`.

Arguments: $@

Read the persona file. Load its skills (the `skills:` line, or the `Skills` line under its heading) from `.agents/skills/<name>/SKILL.md` as their triggers match, and its tools (the labels in the `Tools` line under its heading, or its `tools:`). Declare before any work:

```
Persona: <name>
Skills: <loaded now>
Tools: <in use>
Model: <the model you are running as>
Harness: pi
Effort: <thinking effort>
```

When first-party brain tracing is enabled and `brain_context` is available, record the adopted persona with that tool, then record its ticket ID as soon as that ticket is established. Native Pi persona allowlists retain this narrow bookkeeping tool; no tools list means the native default loadout, not a context-only restriction. If the operation is unavailable, report that limitation and leave unsupported attribution `UNKNOWN`; do not invent telemetry or substitute an unauthorized shell operation. Pass only those non-secret identifiers, never task text or credentials. Update the structured context when persona or ticket changes; a prose declaration is not telemetry state. Skill attribution comes from observed invocations/loads, not the persona's permitted-skills list.

Re-declare whenever you add a skill or tool. Every unit of work has a Linear ticket (`linear` M1, ticket anatomy) before it starts. Ensure the main agent's visible runtime name is `<ticket>-<slug> (<persona>)` with a worktree, or `<ticket> <scope> (<persona>)` without one. For long-running or out-of-persona work, or parallel hands, start subagents: show the plan (name, persona, scope, ticket, type), ensure each subagent's visible runtime name follows the same form with its own worktree and persona, and ask the user for its model, harness, and effort first. Give a subagent its persona and scope only; it loads its own skills and tools. Never hold two personalities.
