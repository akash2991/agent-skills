---
name: model-routing
description: Chooses the model, thinking effort, and harness for each task from its complexity tier, the remaining budget allocation, and live provider quota, then records the choice in the control plane and the tracker. No persona is tied to a model. Use when an engineering manager is about to hand a task to an agent, when a task fails and needs re-routing, when budget crosses a threshold, or when provider quota changes what is available.
category: process
---

# Model Routing

## Overview

The Engineering Manager is the LLM router. Every task gets a tier; the tier suggests a model class, a thinking effort, and a review requirement; the remaining budget and live provider quota decide what is actually available. No persona is tied to a model, so the decision is made per task and written down, and anyone can later see why a task ran on the model it did.

## When to Use

- Before handing a task to any agent, in any harness.
- After a task fails or is returned `PARTIAL`, to decide whether to re-route.
- When a budget allocation crosses its warning threshold or is exhausted.
- When provider quota changes which models can actually serve the work.
- NOT for deciding *who* does the work: the persona comes from the task's discipline, and a task no persona covers is a hiring request.

## Process

1. **Classify the task** into a tier using the table and the up/down signals.
2. **Check the budget and the quota**: `brain.js budget` for the remaining allocation, `brain.js quota` for what each provider will serve. Apply the budget rules below.
3. **Set the review path** from the tier and the blast-radius rule in `ORG.md`.
4. **Record** the assignment record (below) in the ticket, and the model and effort on the agent's row in the control plane.
5. **Hand the decision to the spawner.** Put the model, effort, and harness in the assignment packet. Who spawns depends on the harness (see "Execution" below): on this harness the spawn mode is `{{SPAWN_MODE}}`. The spawner applies the pair verbatim; it never re-decides.
6. **On failure**: if the task returns `PARTIAL` or `BLOCKED` for reasons of capability (not missing information), re-route one tier up once. A second failure is an escalation, not a third attempt.

## Decision versus execution

Routing has two halves that live in different places:

| Half | Who | Where recorded |
|---|---|---|
| Decision: tier, model, effort, harness, review path, budget | always the EM (or the driver EM) | assignment packet and the ticket |
| Execution: spawning the agent with that choice | the harness's spawner | the agent's row in the control plane |

{{ROUTING_NOTE}}

If the spawner cannot apply the choice, because the harness has no model switch or the model is unavailable, it does not substitute one: it records what actually ran on the agent's row and returns the gap to the EM, who re-routes or escalates. A spawner never re-decides routing on its own.

## Tiers

| Tier | Task shape | Model class | Thinking effort | Review |
|---|---|---|---|---|
| T0 | Mechanical: rename, formatting, docs, config value, generated code | small | low | direct merge if low blast radius |
| T1 | Well-specified, single service, clear acceptance criteria, known pattern in codebase | medium | medium | blast-radius rule |
| T2 | Multi-file or multi-module, needs design judgement, debugging with unknowns, new pattern, foundation task | large | high | peer review required |
| T3 | Irreversible or high-risk: auth, payments, migrations, data deletion, security, public API contract | large | max | peer review + PE sign-off |

Push **up** a tier when: acceptance criteria are unclear, the task crosses services, a prior attempt failed, the path had a recent RCA, or there are no existing tests. Allow **down** when: there is an exact precedent in the codebase, full test coverage exists, and the change is one file.

## Models

**No persona is tied to a model.** Any agent may run any model at any thinking effort; the choice belongs to the task, not the role. Three things decide it, in this order:

1. **What the task needs** — the tier below.
2. **What the budget can pay for** — the remaining allocation for this agent or team (`brain.js budget`).
3. **What the provider will actually serve** — quota, pace, and runway per provider (`brain.js quota`, the `quota-axi` skill).

Effort vocabularies differ per model, so choose a pair that the model genuinely supports (`low`, `medium`, `high`, `max` on the large Claude models; fewer levels on smaller ones; `--variant` values on OpenCode providers). A model that is not available in any harness you can invoke is not a choice, however suitable.

| Rough class | Examples | Fits |
|---|---|---|
| large | `claude-fable-5-1`, `claude-opus-5` | design, planning, debugging with unknowns, foundation tasks, T2 and T3 |
| medium | `claude-sonnet-5`, comparable models on other providers | well-specified T1 implementation with a precedent in the codebase |
| small | `claude-haiku-4-5-20251001` | mechanical T0 work only |

Cross-provider choices are open: a Kimi, GLM, or Groq model through OpenCode, or a Codex model, is as valid as a Claude model if it suits the task and the quota favors it. Invocation is in `{{ORG_DIR}}/references/cross-harness-delegation.md`.

## Recording the choice

The pair is not a preference, it is a record. Put it in the assignment packet, then register or update the agent so the control plane holds what actually ran:

```bash
node {{ORG_DIR}}/control-plane/brain.js agent register --agent-id <id> --role <persona> \
  --parent <you> --ticket <id> --model <model> --effort <effort> --harness <harness>
node {{ORG_DIR}}/control-plane/brain.js agent set --agent-id <id> --model <model> --effort <effort> --reason "<why re-routed>"
```

A re-route is a mutation with a reason, and the control plane keeps the before and after. Spend then attributes to the right model automatically, which is what makes the by-model view in `brain.js serve` meaningful.

## Budget rules

The budget a task draws on is the EM's team allocation in the control plane, sub-allocated per agent or task (`budget-management`). Routing must fit inside it: a tier whose expected spend exceeds the remaining allocation is a budget ask first, not a silent downgrade.

- Track spend with `brain.js budget`, which rolls up the registered parent tree. Unknown usage is `UNKNOWN`, never estimated silently.
- At **80%** of an allocation: route new T1 work to the smallest model with a precedent, defer T0 polish, report to the PM.
- At **100%**: start no new tasks, let in-flight ones finish their atomic step, and raise a budget ask.
- **Never** downgrade a T3 or foundation task to save budget. If the budget cannot cover it, escalate; if provider quota cannot cover it, route to another provider.

## Assignment record

```markdown
- Ticket: <id>
- Tier: T0 | T1 | T2 | T3
- Model / effort: <model>/<effort>
- Harness: <where it will run>
- Budget for this task: <input>/<output> tokens (or UNKNOWN), from allocation <holder>
- Quota evidence: <provider/scope, percent remaining, runway> or UNKNOWN
- Review path: direct | peer | peer + PE
- Routing reason: <one line: why this model, this effort, this harness>
```

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "This persona always runs on model X." | No persona is tied to a model. Choose per task from complexity, budget, and quota, and record what you chose. |
| "I'm the CEO session spawning this, I'll pick a cheaper model." | The EM owns the decision; the spawner executes it. Re-route through the EM if you disagree. |
| "Same effort level works on every model." | Effort vocabularies differ per model. Pick a level the chosen model actually supports. |
| "Use the biggest model for everything to be safe." | Budget is finite. Over-routing T0/T1 work starves T2/T3 work of budget later. |
| "It's a small change, small model is fine." | Small diff is not small risk. Auth, schema, and contracts are T3 regardless of size. |
| "I'll just retry on the same model." | A retry with no new information repeats the failure and spends budget. Re-route up once, then escalate. |
| "Recording the tier is bureaucracy." | The record is how the PM and CEO see where budget went and why a task failed. |

## Red Flags

- A registry row with no model or effort recorded, or a model in the row that differs from the assignment with no re-route reason.
- A T3 task on a small or medium class.
- Three attempts at the same task on the same tier.
- Milestone spend past 80% with no PM report.
- A PE running below `high` effort.
- A spawned agent whose recorded model differs from the assignment without a re-route reason.
- A model chosen because it was the harness default rather than routed.

## Verification

- [ ] Every task in the milestone has an assignment record in the tracker and a registry row with model and effort.
- [ ] No T3 or foundation task is below the large class.
- [ ] Budget spend is recorded or explicitly `UNKNOWN`.
- [ ] Any re-route is explained by a failure or a budget threshold in the ticket comments.
