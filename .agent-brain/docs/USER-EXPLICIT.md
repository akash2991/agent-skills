# Explicit user instructions

**An explicit instruction from the user overrides everything in this organization** for the session it is given in: these rules, the conventions, a persona's authorization, a skill's process, any document. Follow it, and record it here.

**This file is a record, not a rule.** Nothing in it binds a later session. An agent does not read this file to find out how to behave, and an entry here never overrides a convention for anyone other than the person who was told. If an instruction should apply from now on, it belongs in `CONVENTIONS.md`, a persona, or a skill, where it is enforced for real. Leaving it here would mean quietly accumulating rules nobody agreed to.

What the record is for is the opposite of enforcement: it shows where the defaults keep being wrong. An instruction the user has to give more than once is a default worth changing, and this is where you would notice.

## How to log one

**Write the entry before you carry on.** You, the agent that received it. Not later, not at the end of the run.

Record what the instruction actually was, not your interpretation of it. If you are unsure whether something was an override or a passing preference, ask, then write down the answer.

If you notice the same instruction already in the table below, say so to the user and name the convention, persona, or skill that should absorb it. That is a suggestion, not a change you make on your own.

## Log

Newest first. One row per explicit instruction.

| Date | Session or ticket | The instruction, in the user's words | What it overrode |
|---|---|---|---|
| 2026-09-14 | Integrating firstmate: delete overlapping brain functionality | "delete the code / functionality which is taken care by firstmate" | AGENTS.md "Ask first before deleting material that is not clearly a relic of the upstream fork" (the instruction is the ask). Goal.md update 18, which relied on each harness's native subagents and had every role confirm model and effort: firstmate now spawns the crew in herdr panes and sets model and effort per task. The brain-on-itself flow (friction ticket through `/brain-pm`, an `org-*` persona, code review): done directly in the session on the owner's instruction. Removed material is archived under `deprecated/removed-for-firstmate/` per the repository's convention rather than destroyed. |
| <YYYY-MM-DD> | <ticket, or what you were doing> | <quote them> | <the rule, convention, or persona section it beat, or `nothing, it was new ground`> |
