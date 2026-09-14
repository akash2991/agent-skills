---
name: delivery-status
description: Produces a truthful current-state report for a project, service, or milestone by reconciling the tracker, git, the running system, and firstmate's crew state, labeling every fact by freshness, detecting stuck work and agent loops, and accounting for recorded token and cost usage. Use when the user or an EM must report status, answer "what works right now", diagnose why delivery is stuck, or refresh state before resuming a long-running project.
category: process
---

# Delivery Status

## Overview

Chat memory and old reports are not the current state. This skill rebuilds the truth from sources, labels each fact by how fresh it is, finds work that is stuck or invisible, and reports usage without inventing numbers. The user uses it for progress updates to the user; the EM uses it for milestone status and to keep a service unstuck.

## When to Use

- The user or the PM asks what works, what is in progress, what is blocked, or what is next.
- Before resuming work after a break, a context reset, or a handoff.
- A milestone closes or a report is due.
- Delivery looks stalled, an agent seems to be looping, or a background agent's state is unknown.
- A question about tokens, cost, elapsed time, limits, or which model did what.
- NOT for adding telemetry to the product; use `observability-and-instrumentation`.

## Process

1. **Label every fact**: `VERIFIED NOW` (checked in this refresh), `REPORTED` (claimed by an agent, not checked), `HISTORICAL` (true at a named time or commit), `PLANNED` (intended), `UNKNOWN` (no evidence). A previously verified fact becomes `HISTORICAL` until re-checked.
2. **Read crew state from firstmate, do not rebuild it**: which tasks are running, waiting, stuck, or done, and on which model and effort, comes from the first mate's crew state or fleet view. Label it `REPORTED` unless you checked the pane or the branch yourself, and never write `NO AGENT` merely because a report has not arrived.
3. **Detect stuck work**: a ticket `Blocked` with no next action; a dependency with no owner; an agent repeating the same command with the same failure; a story missing between plan and tracker. For each, name the evidence, the owner, and the smallest next action, and say plainly which decisions the user has to make.
4. **Account for usage**: read the recorded figures with `node {{ORG_DIR}}/control-plane/brain.js status`; for each agent and the session, record model, turns, tool calls/failures, skill/document context contribution, total context/window, model input/output/cache tokens, elapsed time, and cost with a source and window. Classify each value `MEASURED`, `ESTIMATED` (with formula), `UNAVAILABLE`, or `UNKNOWN`. A missing event is not zero. Record every model switch. Surface an exhausted or near-exhausted limit instead of degrading silently. Use `{{ORG_DIR}}/references/agent-observability.md` for measurement and privacy rules.
5. **Write the report** in the format below; the EM folds it into `em-report.md`. Update `CURRENT_MILESTONE.md` with what changed.

## Report format

```markdown
## Delivery status — <project | service | milestone> — checked at <time>
- Current commit: <sha> (VERIFIED NOW)
- What works right now: <usable flows, how verified>
- What does not work: <known gaps>
- In progress: <ticket — owner — current operation — last evidence>
- Blocked: <ticket — blocker type — owner — next action — what the user must decide>
- QA status: <verified / verifying / failed per story>
- Sprint: <n — delivered / planned points, spillover, estimation error>
- Open bugs: <count by severity>
- Deferred: <items and reason>
- Next: <next executable tickets>
- Crew: <task — role — model/effort — state, from firstmate, with its freshness label>
- Usage: <session and per-agent turns, tools, skill/doc context, model tokens, elapsed, cost — each with classification and source>
- Decisions needed: <Q-ids>
```

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "The EM reported it working an hour ago, so it works." | That is `HISTORICAL`. Run the check or label it as such. |
| "No agent has reported, so there is no agent." | Background agents run without reporting. Check firstmate's crew state before saying none exists. |
| "I'll estimate the token cost." | An estimate without a formula and source is a guess. Write `UNKNOWN` or show the calculation. |
| "Making good progress" is a fine update. | It says nothing. State exactly what works and what does not. |
| "The retry will probably work this time." | Same action, same failure, no new information is a loop. Stop and escalate. |

## Red Flags

- A status sentence without a freshness label.
- Crew state reported as current with no freshness label.
- A blocked ticket with no owner or next action.
- A cost or token number with no source.
- A model switch that nobody recorded.

## Verification

- [ ] Every fact in the report carries a freshness label and the commit is `VERIFIED NOW`.
- [ ] Crew state came from firstmate and carries a freshness label, or says `UNKNOWN`.
- [ ] Every stuck item has an owner, a next action, and names any decision the user must make.
- [ ] Usage values are classified with a source, or `UNKNOWN`/`UNAVAILABLE`.
- [ ] Skill and document loads, turns, tool failures, and context usage were checked in the recorded events or in Langfuse.
- [ ] `CURRENT_MILESTONE.md` was updated.
