---
name: request-intake
description: Admits or parks every request that arrives at the CEO, from the user or from any role, by checking it against available budget, provider quota, and how much work is already running, then either assigning it with an allocation or filing it as a prioritized ticket with what it is waiting for. Use when a feature request, bug, audit, review, or any other ask reaches the CEO, and when parked work should be reconsidered because resources freed up.
category: process
---

# Request Intake

## Overview

The CEO is the only entry point for work, because it is the only role that can see the whole picture: the company budget, provider quota, what is already running, and what matters most. Admitting work without that view is how a project ends up with six agents half-finishing things and no budget left for the one that mattered.

Every request gets a decision, and "not now" is a decision with a ticket and a priority, never a refusal and never silence.

## When to Use

- The user asks for a feature, a change, a fix, or an audit.
- Any role asks for work that is not already in a milestone: a PM wants a second PE, an EM wants a security audit, an engineer found something outside its ticket.
- A parked request should be reconsidered because a milestone closed, budget was granted, or quota reset.
- NOT for work already admitted and planned: that flows through the PM and EM.
- NOT for an escalation on existing work: that is the `escalation` skill.

## Process

1. **Record the request before judging it.** Create the ticket immediately with the requester, one-sentence outcome, and the raw ask. A request that exists only in chat is already lost.

2. **Classify it.**

| Class | Meaning |
|---|---|
| `MVP BLOCKER` | The current usable product is broken or cannot ship without this |
| `MVP REQUIREMENT` | Needed for the milestone in flight |
| `POST-MVP` | Real value, not needed for the current milestone |
| `NICE-TO-HAVE` | Worth doing when nothing better competes |
| `OPERATIONAL HARDENING` | Runbooks, alerting, backups, scale work |
| `UNKNOWN` | Cannot be classified without a question for the requester |

3. **Check capacity honestly**, in this order. Do not skip to a decision from intuition.

```bash
node {{ORG_DIR}}/control-plane/brain.js budget    # what is unallocated, and who is at WARN or EXHAUSTED
node {{ORG_DIR}}/control-plane/brain.js quota     # what the providers will actually serve
node {{ORG_DIR}}/control-plane/brain.js status    # what is already RUNNING, BLOCKED, or stale
```

A request is affordable only if all three hold: unallocated budget covers its estimate, a provider scope has runway for it, and admitting it would not push concurrency past what you can integrate. Two engineers on disjoint paths is parallelism; five agents touching one service is a merge queue.

4. **Decide, and write the decision on the ticket.**

| Decision | When | What you do |
|---|---|---|
| `ADMITTED` | Affordable and at least as important as what is running | Allocate budget, assign a PM or EM, set the priority |
| `PARKED` | Worth doing, but no budget, no quota, or no capacity | File with a priority and the exact condition that unblocks it |
| `PREEMPTS` | More important than something running | Park the running work at a safe point first, then admit this |
| `NEEDS INPUT` | Cannot classify or estimate without an answer | Ask the user one batched question; keep the ticket open |
| `DECLINED` | Outside the product's intent | Record why on the ticket; never silently drop it |

Preemption is not free: the work you park must stop at a commit that leaves the repository runnable, and its agent must be closed properly so its budget is released.

5. **Park with a real condition**, never a vague "later". A parked ticket says what it is waiting for, so it can be picked up automatically rather than rediscovered:

```markdown
### Parked P-<ticket>
- Requested by: <user | agent_id> on <date>
- Outcome: <one sentence>
- Class: <classification>
- Priority: <1 highest .. 5>
- Waiting for: budget <in/out tokens> | quota on <provider/scope> | capacity in <service> | decision <Q-id>
- Estimate: <in/out tokens> and <which persona>
- Unblocks when: <the concrete condition, e.g. "milestone 2 of api closes" or "weekly Claude window resets">
- Cost of waiting: <what degrades if this stays parked>
```

6. **Re-run the queue at every natural boundary**: a milestone closing, a budget grant, a sprint review, a quota reset. Admit the highest-priority parked ticket whose condition is now met, and say so in the CEO report. A parked queue nobody revisits is a backlog of broken promises.

7. **Report intake in every CEO report**: what was admitted, what was parked and behind which condition, and what the user must decide.

## Parallelism

Concurrency is a resource like budget, and the CEO owns it. Before admitting work that adds an agent, check that the new agent has disjoint owned paths from every running one (`brain.js status` reports conflicts), that the foundation task it depends on has merged, and that a reviewer and QA exist for the extra throughput. Work that would arrive faster than it can be reviewed and verified is not faster.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "It is small, just start it." | Small requests are how a budget disappears without a decision. Ticket it, then decide. |
| "The user asked, so it is admitted." | The user asked you to run the organization, which includes telling them what it costs and what it displaces. |
| "Park it" with no condition. | That is a refusal wearing a nicer word. Name the condition that unblocks it. |
| "Run both, we will sort it out." | Two agents on one path is a merge conflict with extra steps. |
| "Quota looks fine, budget is the real limit." | Both bind. A task that cannot finish on any available provider is not admissible at any budget. |
| "I will tell them it is done later." | The requester needs the decision now, even when the decision is not now. |

## Red Flags

- Work in progress with no intake ticket, so nobody can say who asked for it or why it beat something else.
- A parked ticket with no priority, no condition, or no estimate.
- Admitted work with no budget allocation.
- More running agents than the reviewers and QA can absorb.
- A parked queue that has not been revisited across two milestone closes.
- A request answered directly by a specialist because it looked quick.

## Verification

- [ ] Every request, admitted or not, has a ticket with a requester, class, priority, and decision.
- [ ] Every admitted request has a budget allocation and a named owner.
- [ ] Every parked request names the condition that unblocks it and what waiting costs.
- [ ] Budget, quota, and running work were all checked before the decision, not after.
- [ ] No running agent shares an owned path with another.
- [ ] The parked queue was re-run at the last milestone or sprint boundary.
