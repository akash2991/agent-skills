---
name: delivery-status
description: Produces a truthful current-state report for a project, service, or milestone by reconciling the tracker, registry, git, and runtime, labeling every fact by freshness, detecting stuck work and agent loops, and accounting for model, token, and cost usage. Use when the CEO or an EM must report status, answer "what works right now", diagnose why delivery is stuck, or refresh state before resuming a long-running project.
category: process
---

# Delivery Status

## Overview

Chat memory and old reports are not the current state. This skill rebuilds the truth from sources, labels each fact by how fresh it is, finds work that is stuck or invisible, and reports usage without inventing numbers. The CEO uses it for progress updates to the user; the EM uses it for milestone status and to keep a service unstuck.

## When to Use

- The user or the PM asks what works, what is in progress, what is blocked, or what is next.
- Before resuming work after a break, a context reset, or a handoff.
- A milestone closes or a report is due.
- Delivery looks stalled, an agent seems to be looping, or a background agent's state is unknown.
- A question about tokens, cost, elapsed time, limits, or which model did what.
- NOT for adding telemetry to the product; use `observability-and-instrumentation`.

## Process

1. **Refresh sources, in this order**: git (`git status`, `git log`), the product runtime (does the app start, does the milestone verification command pass), the agent runtime (Herdr/API when configured), the tracker (tickets by state and assignee), and the control plane (run `node {{ORG_DIR}}/control-plane/brain.js status` and `brain.js quota`rvability/dashboard.js --json` for the parent-child tree, registry state, skills/documents, turns, context, tool calls, model usage, cost, elapsed time, and runtime bindings). Use `node {{ORG_DIR}}/registry/status.js` only as the compact registry-only fallback. Then read the service docs (`CURRENT_MILESTONE.md`) and open `bug` tickets.
2. **Label every fact**: `VERIFIED NOW` (checked in this refresh), `REPORTED` (claimed by an agent, not checked), `HISTORICAL` (true at a named time or commit), `PLANNED` (intended), `UNKNOWN` (no evidence). A previously verified fact becomes `HISTORICAL` until re-checked.
3. **Reconcile the registry with reality**: an agent is `RUNNING`, `COMPLETED`, `BLOCKED`, `FAILED`, or `UNKNOWN`; never `NO AGENT` merely because its report has not arrived. Compare registry rows with their `runtime`/`runtime_ref` binding. Correct rows that disagree with the runtime; write `UNKNOWN` where the runtime cannot be inspected. Preserve both facts when useful: `REPORTED RUNNING; VERIFIED NOW idle` exposes drift instead of hiding it.
4. **Detect stuck work**: a ticket `Blocked` with no next action; a dependency with no owner; a registry row with no heartbeat for longer than the sprint's cadence; an agent repeating the same command with the same failure; a story missing between plan and tracker. For each, name the evidence, owner, smallest next action, and escalation target; open an escalation with the `escalation` skill where a decision is needed.
5. **Check budgets**: run `node {{ORG_DIR}}/control-plane/brain.js budget`; list holders at `WARN` or `EXHAUSTED`, agents with spend but no allocation, and open budget asks.
6. **Account for usage**: for each agent and the session, record model, turns, tool calls/failures, skill/document context contribution, total context/window, model input/output/cache tokens, elapsed time, and cost with a source and window. Classify each value `MEASURED`, `ESTIMATED` (with formula), `UNAVAILABLE`, or `UNKNOWN`. A missing event is not zero. Record every model switch. Surface an exhausted or near-exhausted limit instead of degrading silently. Use `{{ORG_DIR}}/references/agent-observability.md` for measurement and privacy rules.
7. **Write the report** in the format below; the CEO folds it into `ceo-report.md`, the EM into `em-report.md`. Update `CURRENT_MILESTONE.md` and the registry with what changed.

## Report format

```markdown
## Delivery status — <project | service | milestone> — checked at <time>
- Current commit: <sha> (VERIFIED NOW)
- What works right now: <usable flows, how verified>
- What does not work: <known gaps>
- In progress: <ticket — owner — current operation — last evidence>
- Blocked: <ticket — blocker type — owner — next action — escalation>
- QA status: <verified / verifying / failed per story>
- Sprint: <n — delivered / planned points, spillover, estimation error>
- Open bugs: <count by severity>
- Deferred: <items and reason>
- Next: <next executable tickets>
- Agents: <agent_id — role — model — status — heartbeat>
- Budgets: <holders at WARN/EXHAUSTED, open asks B-ids, unbudgeted agents>
- Usage: <session and per-agent turns, tools, skill/doc context, model tokens, elapsed, cost — each with classification and source>
- Runtime controls: <focus/steer/interrupt capability by agent, or UNAVAILABLE>
- Decisions needed: <Q-ids>
```

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "The EM reported it working an hour ago, so it works." | That is `HISTORICAL`. Run the check or label it as such. |
| "No agent has reported, so there is no agent." | Background agents run without reporting. Inspect the runtime and registry before saying none exists. |
| "I'll estimate the token cost." | An estimate without a formula and source is a guess. Write `UNKNOWN` or show the calculation. |
| "Making good progress" is a fine update. | It says nothing. State exactly what works and what does not. |
| "The retry will probably work this time." | Same action, same failure, no new information is a loop. Stop and escalate. |

## Red Flags

- A status sentence without a freshness label.
- A registry row that disagrees with the runtime and was not corrected.
- A blocked ticket with no owner or next action.
- A cost or token number with no source.
- A model switch that nobody recorded.

## Verification

- [ ] Every fact in the report carries a freshness label and the commit is `VERIFIED NOW`.
- [ ] The registry matches observed runtime state or says `UNKNOWN`.
- [ ] Every stuck item has an owner, a next action, and an escalation where needed.
- [ ] Usage values are classified with a source, or `UNKNOWN`/`UNAVAILABLE`.
- [ ] The hierarchy, skill/document loads, turns, tool failures, context usage, and runtime bindings were checked in the observatory.
- [ ] `CURRENT_MILESTONE.md` and the registry were updated.
