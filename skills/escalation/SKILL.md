---
name: escalation
description: Moves a stuck ticket one level up the organization through the project-management tool, with the attempted answer and a recommended default attached. Use when an agent cannot resolve an ambiguity, blocker, or decision on its own ticket, or when a ticket assigned to you carries an open escalation from below.
category: process
---

# Escalation

## Overview

Ambiguity is resolved at the lowest level that can resolve it, and only the CEO asks the user. Escalation is a tracker action, not a chat message: the stuck agent reassigns its ticket to the persona one level up, with an escalation block as a comment. Each persona watches the tickets assigned to it and either answers or escalates again.

```text
Staff Engineer ─┐
                ├─→ Engineering Manager ─→ Product Manager ─→ CEO ─→ User
Principal Eng. ─┘
```

## When to Use

- You own a ticket and cannot proceed: the spec, design, or code does not answer a question that changes the result.
- You are blocked on another team's contract, path, or decision.
- A ticket assigned to you has an escalation comment from a lower level.
- NOT for questions the ticket, PRD, HLD/LLD, `DECISIONS.md`, or the code already answer. Look first.
- NOT for progress reports. Use the role's report template.
- ALSO for refusing a task outside your Role (out-of-scope block) and for a hiring request when no persona covers a task.
- A budget exhaustion uses the budget-ask block from `budget-management` and goes to the grantor (the allocation chain), not necessarily the role one level up.

## Process

### Escalating

1. **Try to answer.** Read the ticket, the PRD, the relevant HLD/LLD sections, global and service `DECISIONS.md` and `CONVENTIONS.md`, and the code. Note what you checked.
2. **Classify the blocker**: product ambiguity, technical decision, dependency, environment or tooling, ownership conflict, external service, or missing access. Attempt the smallest reasonable unblock that does not change product behavior (for example a deterministic stub the milestone plan allows, or a fixture). Never work around a blocker in a way that changes product behavior.
3. **Write the escalation block** (below) as a comment on your ticket. Include options, a recommendation, and a default.
4. **Decide blocking or not.** If the default is reversible and preserves intent, continue with it and say so. If irreversible, stop work on this ticket.
5. **Reassign the ticket** in the tracker to the persona one level up (by role, e.g. the EM of your service). Set state to `Blocked` if blocking. Add the `blocked by` relation when another ticket is the cause. Post the structured status update (state, reason, blocker block) as defined in the tracker skill.
6. **Update the registry**: your row gets `status: BLOCKED` (or `WAITING` if you continue on another ticket) and `blocker: Q-<ticket>-<n>`.
7. **Continue independent work** on other tickets assigned to you.

### Refusing out-of-scope work

Every persona is a specialist. A ticket whose work is not covered by your `## Role` and `## Responsibilities` is refused, not attempted: post the out-of-scope block, reassign the ticket to the EM, set your registry row to `WAITING`. The EM reassigns to the covering persona, or, if none exists, raises a hiring request to the CEO (`../../references/hiring.md`). Work on that ticket does not start until a covering persona exists.

### Receiving an escalation

1. Read the block and everything the asker checked. Do not re-ask what they already answered.
2. Try to answer within your authority (see your persona's Authorization). If you can: post the answer block, record it in the right `DECISIONS.md` (service or global), reassign the ticket back to the asker, clear `Blocked`.
3. If you cannot: append your own attempted answer and reassign one level up. Never skip a level.
4. The CEO batches open escalations and asks the user in one message with options and a recommendation, then records the answer and pushes it back down the chain.

## Escalation block

```markdown
### Escalation Q-<ticket>-<n>
- From: <agent_id> (<role>)
- To: <role one level up>
- Blocking: yes | no
- Blocker type: product ambiguity | technical decision | dependency | environment/tooling | ownership conflict | external service | missing access | budget
- Dependency: <ticket, contract, service, or person this waits on, or none>
- Requirement: <what must be true or decided for work to continue>
- Question: <one sentence>
- Smallest unblock attempted: <what you tried, or none>
- Checked: <ticket, PRD §, HLD §, DECISIONS.md rows, files>
- Options:
  1. <option> — <consequence>
  2. <option> — <consequence>
- Recommended: <option n> because <reason>
- Default if unanswered by <time/event>: <what you will do>
- Reversible: yes | no
```

## Out-of-scope block

```markdown
### Out of scope — <ticket>
- From: <agent_id> (<role>)
- Asked to: <one sentence>
- Why outside my Role: <which Role/Responsibility line it falls outside>
- Covering persona, if any: <persona name | none known>
- Returned to: <em agent_id>
```

## Hiring request block (EM → CEO)

```markdown
### Hiring request H-<ticket>-<n>
- Task: <ticket and one-sentence goal>
- Personas consulted: <names> — each refused as out of scope
- Role needed: <one sentence>
- Discipline: backend | web | mobile | cross-cutting
- Skills needed: <existing skill names, plus any that must be written>
- Suggested model / effort: <from the routing policy>
- Blocking: yes | no — default if unanswered: <ticket stays blocked>
```

## Answer block

```markdown
### Answer Q-<ticket>-<n>
- By: <agent_id> (<role>)
- Decision: <one sentence>
- Rationale: <one or two sentences>
- Recorded in: <service|global> DECISIONS.md#D-<n>
```

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "I'll just pick the sensible option and move on." | Fine only if reversible and recorded. Unrecorded guesses become silent product decisions. |
| "Asking the CEO directly is faster." | Skipping levels loses the context the EM and PM hold, and trains everyone to bypass ownership. |
| "It's a small question, a chat message is enough." | Chat is not tracked. The ticket reassignment is what makes the escalation visible and owned. |
| "I'll wait for the answer." | Waiting idle wastes budget. Continue with independent work or the reversible default. |
| "I already answered this for another ticket." | Then it is in `DECISIONS.md`. If it is not, record it now. |

## Red Flags

- A ticket is `Blocked` with no escalation block on it.
- An escalation has no "Checked" line, no blocker type, or no recommended option.
- A blocker was worked around in a way that changed product behavior.
- A question reached the CEO without an EM or PM attempt attached.
- The same question appears on two tickets.
- An agent is idle while an escalation is open.
- A persona doing work outside its Role "to be helpful", or a task started before a covering persona exists.

## Verification

- [ ] The escalation block is a comment on the ticket and the ticket is reassigned one level up.
- [ ] The registry row shows `BLOCKED` or `WAITING` with the Q-id.
- [ ] If continuing on a default, the default is reversible and stated in the block.
- [ ] When answered, the answer block exists and the decision is recorded in `DECISIONS.md`.
- [ ] The ticket is reassigned back to the asker and unblocked.
