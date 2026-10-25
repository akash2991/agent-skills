---
name: deterministic-workflows
description: Converts agentic workflows into deterministic ones, made of code, scripts, and checks, with a model call kept only where judgment is genuinely needed. Use when designing a feature that would use an LLM, tool calling, or an agent loop; when orchestrating several agents; when a skill or procedure has an agent re-reason the same work every run; or when the same procedure comes up a second time.
category: design
---

# Deterministic Workflows

## Overview

An agentic workflow lets a model decide what happens next. That costs tokens and latency on every run, gives a different answer to the same input, and fails in ways no test pins down. Most of the steps in such a workflow follow fixed rules that code can run. Find them and turn them into code, scripts, and checks. Keep a model only at the step that genuinely needs judgment, and give that step a typed boundary. Every agentic workflow becomes deterministic unless a step makes it impossible, and that step is named and justified.

## When to Use

- Designing or reviewing a feature that calls an LLM, uses tool calling, or runs an agent loop
- Orchestrating several agents: a fan-out, a review pass, a pipeline of personas
- A skill, runbook, or prompt describes steps an agent works out again on every run
- The same multi-step task (setup, a check, a migration, a release step) comes up a second time
- An existing agentic flow is slow, costly, flaky, or gives different results for the same input

**When NOT to use:**

- A single question answered once, with no workflow around it
- Making existing code read more simply: that is `code-simplification`
- Wiring an already deterministic check into CI: that is `ci-cd-and-automation`

## The Process

### 1. List the workflow

Write the workflow as numbered steps. For each one, write its input, its output, and who decides it today (code, a model, a human). Include the control flow: what decides which step runs next, when the workflow loops, and when it stops. A workflow you can't list this way isn't understood yet; read the code or trace a real run until you can.

### 2. Classify every step

| Class | Test | Example |
|---|---|---|
| Deterministic | The output follows from the input by rules you can write down | parse an email header, look up a customer by id, route by plan tier, run the tests, format a report |
| Judgment | The input is open-ended or the rule can't be written down | the intent of a free-text message, summarizing a document, judging whether a design reads clearly |
| Human decision | The owner decides; no system should | approving a spend, accepting a risk, choosing between product options |

When unsure, ask: "Could I write a test with fixed expected output for this step?" If yes, it is deterministic.

### 3. Pick the lowest rung for each step

Go down this ladder and stop at the first rung that does the job:

```
1. Code in the product        a function, a state machine, a query
2. Script                     skills/<skill>/scripts/ or the project's scripts/
3. Check or hook              a linter rule, a CI gate, a pre-commit or post-edit hook
4. One typed model call       fixed prompt, schema-validated input and output
5. Agent loop                 the model chooses tools and the next step
```

Rung 5 is allowed only when the path itself can't be known in advance: the sequence of steps depends on what earlier steps discover and can't be enumerated. Record that reason in an ADR (`adrs`). "The model can figure it out" is not that reason.

### 4. Fix the control flow in code

The order of steps, the branches, the loop bounds, and the stop condition live in code: a pipeline, a state machine, or a workflow script. A model may fill in a value at a step; it never chooses which step runs next.

For multi-agent work, a script owns the orchestration and agents sit only at the leaves. The script starts each agent with a fixed brief, collects its output against a schema, and decides what happens next. Example: a two-reviewer-plus-synthesis PR review is a script that starts two independent reviewers on the same revision, waits for both, then starts the synthesizer with both reports. No agent decides who reviews next or when the review is done.

### 5. Confine each judgment step

Every model call that remains:

- has a typed input and a typed output (an enum, a JSON Schema, a record), never free text that later code parses ad hoc
- validates its output against that type; a failure takes an explicit branch (reject, route to a human, mark the item `UNKNOWN`), never a silent retry (`coding-standards` C20)
- has a fixed prompt kept in the repository, versioned with the code
- carries a one-line comment or ADR entry saying why this step can't be code
- is wrapped so tests replace it with a fake that returns fixed outputs

### 6. Put the result in one place

Product logic goes in the service's code, in the feature it belongs to. An agent's own repeated procedure goes in a script: `skills/<skill>/scripts/` when a skill owns it, the project's `scripts/` otherwise. The skill or runbook then says "run the script", not "do these steps". Delete the prose steps the script replaced.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "The model handles the edge cases better" | The model handles them differently on every run. Edge cases you can name belong in code and tests; the rest go to the confined judgment step. |
| "It's only run once" | It's the second run that matters. When the task comes back, write the script. |
| "Writing the code takes longer than prompting" | Once. Every agentic run after that costs tokens, latency, and a review of output that may have changed. |
| "An agent loop is more flexible" | Flexibility you can't test is drift. If the path really is unknowable, record that in an ADR; otherwise fix it. |
| "The orchestrator agent can decide who to call next" | Then the workflow changes when the model changes. Put the routing in a script and keep the agents at the leaves. |
| "Structured output is enough" | A schema fixes the shape of one answer. It doesn't fix which step runs next, when to stop, or what happens when validation fails. |

## Red Flags

- An agent decides the next step when the order is known in advance
- A prompt that says "first do X, then Y, then Z" where X, Y, and Z are lookups, transforms, or commands
- A model parses, formats, filters, sorts, counts, or routes by a fixed rule
- Model output is parsed with regexes or string matching instead of a schema
- A retry loop around a model call with no bound or no failure branch
- The same multi-step procedure appears in two tickets, prompts, or transcripts with no script behind it
- An orchestrating agent whose job is mostly "decide which agent to call"
- Tests can't run without a live model

## Verification

- [ ] The workflow is listed as steps, each classified as deterministic, judgment, or human decision
- [ ] Every deterministic step is code, a script, or a check, with a test or a run showing its output
- [ ] Control flow, including branches, loop bounds, and the stop condition, lives in code or a script
- [ ] Each remaining model call has typed input and output, validation with an explicit failure branch, a prompt in the repository, and a recorded reason it can't be code
- [ ] Any agent loop has an ADR saying why the path can't be known in advance
- [ ] The deterministic part runs twice on the same input with identical output (show both runs)
- [ ] Tests pass with every model call replaced by a fake
- [ ] Prose steps replaced by a script are deleted, and the skill or runbook points at the script

## Interaction with other skills

- `code-simplification` makes code read more simply without changing behavior; this skill changes who decides each step.
- `ci-cd-and-automation` wires deterministic checks into the pipeline; this skill finds which steps become those checks.
- `adrs` records the reason a step stays agentic.
