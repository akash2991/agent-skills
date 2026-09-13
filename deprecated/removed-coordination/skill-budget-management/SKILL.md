---
name: budget-management
description: Allocates, tracks, and enforces hierarchical token and cost budgets across the organization: the CEO holds the company budget and allocates to direct reports, EMs allocate within their teams, spend is measured from the observatory, and an agent that exhausts its allocation stops and raises a budget ask up the allocation chain until the CEO asks the user. Use when a project starts, a budget is allocated or re-allocated, a holder crosses the warning threshold, or an agent has run out of budget.
category: process
---

# Budget Management

## Overview

Budgets are counted in input tokens, output tokens, and cost, held in the control plane (`node {{ORG_DIR}}/control-plane/brain.js budget`), and measured from `model.completed` events in the observatory. They flow down the reporting tree: user → CEO (company) → PMs and EMs (features and teams) → agents. Nobody spends past their allocation; they stop and ask. Company default until the user changes it: 100,000 input tokens and 100,000 output tokens.

## When to Use

- A project starts and the company budget must be recorded and allocated.
- A PM, EM, or agent is about to start work and has no allocation.
- `node {{ORG_DIR}}/control-plane/brain.js budget` shows `WARN` or `EXHAUSTED` for a holder.
- An agent's registry usage or the observatory shows its subtree at or past its allocation.
- A budget ask arrives on a ticket assigned to you.
- A run fails or degrades in a way that looks like a provider wall rather than an allocation.
- NOT for choosing a model per task; that is the model and effort the coordinator chose, which must fit inside the allocation this skill sets.

## Two limits, both binding

The allocation says what the organization gave you. Provider quota says what the provider will actually serve. Neither implies the other, and work needs room in both.

| | Budget ledger | Provider quota |
|---|---|---|
| Question it answers | what was allocated to this holder and subtree | what is left on the plan, and until when |
| Source | `brain.js budget`, rolled up from `model.completed` events | `brain.js quota`, from quota-axi reading local credential stores (`quota-axi`) |
| Scope | one agent and its children | one provider scope, across every repository and every human using that account |
| Enforced by | the organization: allocations refuse to exceed their grantor | the provider: requests fail or degrade |
| When it runs out | stop, set `BLOCKED` with blocker type `budget`, raise an ask | route to a provider with room, or wait for the reset |

Read quota before allocating a milestone and before admitting expensive work. Three rules follow:

- **Healthy quota is never permission to exceed an allocation.** A full weekly window does not grant tokens the organization did not allocate.
- **A healthy allocation does not guarantee capacity.** A task inside budget still fails when the window is spent, so check runway against the reset clock before committing to a milestone.
- **Quota changes a routing decision, not a budget decision.** When a provider is exhausted, the EM re-routes to one with room (the model and effort the coordinator chose). The allocation is unchanged, because spend is counted in tokens, not in which provider served them.

Quota figures are a burn-down against a reset clock. A figure is `VERIFIED NOW` only when just read, and `HISTORICAL` after that. When quota-axi is absent, every figure is `UNKNOWN`, never a full plan.

## Allocation chain

| Holder | Granted by | Covers | Sub-allocates to |
|---|---|---|---|
| CEO | user | the company budget; keeps a reserve for itself, specialists, and hires | PMs (per feature), EMs (per service team) |
| PM | CEO | the PM's own work and the principal engineers designing that feature | PEs |
| EM | CEO | the service team: staff engineers, code reviewers, test engineer, auditors on its tasks | one allocation per agent or per task |
| Agent | PM or EM | its own tickets | nobody |

A holder's child allocations never sum to more than its own allocation. The observatory rolls spend up through the registry's `parent` column, so a holder's status reflects its whole subtree.

## Process

### Allocating (CEO, PM, EM)

1. Read the company row and your own allocation with `node {{ORG_DIR}}/control-plane/brain.js budget`, which shows allocated, spent, and remaining per holder with the subtree roll-up. Read `brain.js quota` alongside it: an allocation larger than the provider's remaining runway is a plan that cannot be executed.
2. Decide each child's allocation from the milestone plan: tier mix and expected turns, not evenly. Keep a reserve (default 15%) for re-routes and reviews.
3. Allocate to each child: `brain.js budget allocate --holder <child> --granted-by <you> --input <n> --output <n> --scope "<what it covers>"`. The command refuses an allocation that exceeds your own and records a `budget.changed` event.
4. Put the allocation in the assignment packet (`Budget for this task`) and the ticket description.

### Spending (every agent)

5. Before starting a ticket, check your allocation; no row means ask before starting. While working, keep the registry `usage` column current from the runtime's numbers or `UNKNOWN`.
6. At the warning threshold (default 80%), finish the current atomic step, post a status update with the figures, and tell your grantor. Do not start a new task.
7. **At 100%: stop.** Finish the atomic step you are in (a commit that leaves the repository runnable, or a report), run `brain.js agent set --agent-id <you> --status BLOCKED --blocker <ask id>`, raise the ask with `brain.js budget ask --from <you> --to <grantor> --input <n> --output <n> --reason "..."`, post the budget-ask block on your ticket, and reassign the ticket to your grantor. Do not "just finish" past the line.

### Receiving an ask (PM, EM, CEO)

8. Read the ask and the holder's roll-up (`brain.js budget`), and check `brain.js quota` before granting: granting tokens the provider will not serve moves the failure instead of fixing it. Decide with `brain.js budget decide --id <ask> --status GRANTED|PARTIAL|DENIED|ESCALATED [--input <n> --output <n>]`, which raises the allocation on a grant and records the event. If you cannot cover it, escalate up your own chain with your attempt attached.
9. The CEO, when it cannot cover an ask from the company reserve, puts it in the CEO report under "Decisions I need from you" with the figures and what stops if denied. The user is the last holder.
10. When granted, the agent's row is unblocked with a status update and work resumes from the recorded state.

## Budget-ask block

```markdown
### Budget ask B-<ticket>-<n>
- From: <agent_id> (<role>) → To: <grantor agent_id>
- Allocation: <in>/<out> tokens (cost <x or UNKNOWN>) · Spent: <in>/<out> (<n>% / <n>%) · Source: <observatory | runtime | UNKNOWN>
- Ask: <in>/<out> tokens (cost <x or UNKNOWN>) to finish: <remaining work in one sentence>
- Why the allocation was insufficient: <estimation miss | re-routes | scope | failures>
- If denied: <what stops, what is left in a usable state>
- Stopped at: <commit or report>
```

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "I'm 95% done, I'll finish and then report." | The line is the line. Finishing "just this" is how budgets stop meaning anything. Stop at the atomic step and ask. |
| "Usage is UNKNOWN, so I can't be over." | Unknown is not zero. Report UNKNOWN, keep the runtime's numbers where it exposes them, and ask your grantor how to proceed. |
| "I'll take some budget from a sibling." | Only the grantor moves allocations. Ask. |
| "Allocate evenly, it's fair." | Allocate by tier and risk. Even splits starve the T3 work. |
| "The CEO can always ask the user." | The user is the last resort, reached only after every holder below has tried to cover the ask. |

## Red Flags

- An agent with spend in the observatory and no allocation row or budgeted ancestor.
- Child allocations summing past their parent's allocation.
- A holder at `EXHAUSTED` whose registry status is still `RUNNING`.
- A budget ask without figures, or granted without a ledger row.
- A CEO report where spend is not `MEASURED`, `ESTIMATED`, or `UNKNOWN` with a source.

## Verification

- [ ] The company budget and every holder's allocation exist in the control plane; children never exceed parents (the CLI refuses it).
- [ ] `node {{ORG_DIR}}/control-plane/brain.js budget` shows no unbudgeted agents with spend and no `EXHAUSTED` holder still `RUNNING`.
- [ ] Every budget ask has a ticket block, a ledger request row, and a decision.
- [ ] Every allocation, exhaustion, and decision has a `budget.changed` event.
- [ ] The CEO report states spend against the company budget with a source.
