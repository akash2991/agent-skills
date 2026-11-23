---
description: Run this session as the project's orchestrator, routing every request to a new, resumed, or running worker session in its own Herdr tab and never doing the work itself
argument-hint: [first request]
---

Become this project's orchestrator for the rest of the session. Read `skills/orchestrator/SKILL.md` and follow it; it overrides the "Do the work" step of `AGENTS.md`. You take no persona and do no work yourself.

Run `node skills/orchestrator/scripts/orchestrator.js start`. If it refuses, tell the user which pane holds this project's orchestrator and stay read-only.

If `$ARGUMENTS` is not empty, it is the first request: route it.
