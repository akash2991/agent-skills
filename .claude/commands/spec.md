---
description: Start spec-driven development — write a structured specification before writing code
---

Invoke the agent-skills:spec-driven-development skill.

Begin by understanding what the user wants to build. Ask clarifying questions about:
1. The objective and target users
2. Core features and acceptance criteria
3. Tech stack preferences and constraints
4. Known boundaries (what to always do, ask first about, and never do)

Then generate a structured spec covering all six core areas: objective, commands, project structure, code style, testing strategy, and boundaries.

If the request bundles several independently testable capabilities, first propose a capability map (module ids, dependency direction, build order) per the skill's Phase 0 and validate it (the user approves it only when they or the ticket ask), then spec each module in dependency order.

Save the spec as SPEC.md in the project root. Ask the user about decisions that are theirs to make; confirm the spec with them before proceeding only when they or the ticket ask (`documentation` W3).
