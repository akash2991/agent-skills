---
name: deterministic-workflows
description: Converts agentic workflows into deterministic ones, made of code, scripts, and checks, with a model call kept only where judgment is genuinely needed. Use when designing an AI feature or endpoint that would use an LLM, tool calling, or an agent loop; when building a multi-agent pipeline in product code or a script; when a skill or procedure has an agent re-reason the same work every run; or when an agent repeats the same multi-stage procedure across sessions or tickets.
category: design
---

# Deterministic Workflows

## Overview

An agentic workflow lets a model decide what happens next. That costs tokens and latency on every run, gives a different answer to the same input, and fails in ways no test pins down. Most of the steps in such a workflow follow fixed rules that code can run. Find them and turn them into code, scripts, and checks. Keep a model only at the step that genuinely needs judgment, and give that step a typed boundary. Every agentic workflow becomes deterministic unless a step makes it impossible, and that step is named and justified.

## When to Use

- Designing or reviewing an AI feature or endpoint that calls an LLM, uses tool calling, or runs an agent loop
- Building a multi-agent pipeline in product code or a script, where agents hand work to each other
- A skill, runbook, or prompt describes steps an agent works out again on every run
- An agent repeats the same multi-step procedure (setup, a check, a migration, a release step) across sessions or tickets
- An existing agentic flow is slow, costly, flaky, or gives different results for the same input

**When NOT to use:**

- A single question answered once, with no workflow around it
- Making existing code read more simply, without changing who decides each step: outside this skill
- Wiring an already deterministic check into CI: that is `ci-cd-and-automation`
- The user or a slash command orchestrating personas (`/ship`, a review fan-out, the lifecycle commands): that is `../../references/orchestration-patterns.md`

## The Process

### 1. Find the candidates

Search the scope you were given for workflows a model drives:

- product code that calls a model: LLM clients, tool definitions, loops around a chat call
- prompts, skills, and runbooks that list steps for an agent to carry out
- multi-agent pipelines in product code or scripts: agents that hand work to each other
- procedures that recur in tickets, transcripts, or `docs/LEARNINGS.md`

List each candidate with where it lives, then take them one at a time.

### 2. List the workflow

Write the workflow as numbered steps. For each one, write its input, its output, and who decides it today (code, a model, a human). Include the control flow: what decides which step runs next, when the workflow loops, and when it stops. A workflow you can't list this way isn't understood yet; read the code or trace a real run until you can.

### 3. Classify every step

| Class | Test | Example |
|---|---|---|
| Deterministic | The output follows from the input by rules you can write down | parse an email header, look up a customer by id, route by plan tier or by listed keywords, run the tests, format a report |
| Judgment | The input is open-ended and no rule can be written down | the intent of a free-text message when no routing rule exists, summarizing a document, judging whether a design reads clearly |
| Human decision | The owner decides; no system should | approving a spend, accepting a risk, choosing between product options |

When unsure, ask: "Can an explicit rule or algorithm produce the output for every supported input without model judgment?" If yes, it is deterministic. Example outputs alone don't prove that: a summarizer can have golden examples and still need judgment. A rule already written down in a prompt ("if the message mentions refund, use billing") is deterministic, however natural-language its input.

While classifying, write down every case the current workflow leaves to the model without saying so: two rules that both match, a lookup that finds nothing, input no rule covers. Code has to decide each one; resolve it from the requirements or ask the owner, never guess.

### 4. Pick the lowest rung for each step

Rungs 1 to 3 are all deterministic; among them, pick by where the work runs, and prefer a check or hook when the rule must be enforced rather than remembered. Go to rung 4 or 5 only when none of them does the job:

```
1. Code in the product        a function, a state machine, a query
2. Script                     a script the procedure runs (step 7 says where)
3. Check or hook              a linter rule, a CI gate, a pre-commit or post-edit hook
4. One typed model call       fixed prompt, schema-validated input and output
5. Agent loop                 the model chooses tools and the next step
```

Rung 5 is allowed only when the path itself can't be known in advance: the sequence of steps depends on what earlier steps discover and can't be enumerated. Record that reason in an ADR (`adrs`). "The model can figure it out" is not that reason.

### 5. Fix the control flow in code

The order of steps, the branches, the loop bounds, and the stop condition live in code: a pipeline, a state machine, or a workflow script. A model may fill in a value at a step, and code may branch on that typed value; outside an agent loop an ADR allows, the model never chooses which step runs next. A human-decision step is an explicit checkpoint in that flow: the workflow stops, asks the owner, and resumes on the answer; a model never stands in for it.

In a multi-agent pipeline built into product code or a script, the code owns the hand-offs and agents sit only at the leaves: it starts each agent with a fixed brief, collects its output against a schema, and decides what happens next. No agent decides which agent runs next or when the pipeline is done. Orchestrating personas from the user or a slash command is out of scope here; it follows `../../references/orchestration-patterns.md`.

### 6. Confine each judgment step

Every model call that remains:

- has a typed input and a typed output (an enum, a JSON Schema, a record), never free text that later code parses ad hoc
- validates its output against that type; a failure takes an explicit branch (reject, route to a human, mark the item `UNKNOWN`); any retry follows `coding-standards`
- has a fixed prompt kept in the repository, versioned with the code
- carries a one-line comment or ADR entry saying why this step can't be code
- is wrapped so tests replace it with a fake that returns fixed outputs

### 7. Put the result in one place

Product logic goes in the service's code, in the feature it belongs to. An agent's own repeated procedure goes in a script:

- **In a project:** the project's `scripts/`. Installed skills are copies the next brain update overwrites, so the script does not go in them; when the script replaces steps a skill describes, write a `workaround` note in `docs/LEARNINGS.md` naming that skill; a procedure no skill covers needs only the script and the ticket.
- **In the brain repository:** `skills/<skill>/scripts/` when a skill owns the procedure. The skill then says "run the script", not "do these steps", and the prose steps the script replaced are deleted.

### 8. Prove the behavior

For a new feature with no old workflow, verify against the owner-approved requirements and acceptance examples. For a conversion, run the old workflow and the new one on the same inputs: recorded real runs where they exist, plus one input for each case found in step 3. Compare the outputs. Each difference is a bug in the new workflow, fixed now; a decision the old one made inconsistently, recorded with the rule the new one follows; or an owner-approved behavior change, linked to its requirement and covered by an acceptance test. Any other difference is a bug.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "The model handles the edge cases better" | The model handles them differently on every run. Edge cases you can name belong in code and tests; the rest go to the confined judgment step. |
| "It's only run once" | It's the second run that matters. When the task comes back, write the script. |
| "Writing the code takes longer than prompting" | Once. Every agentic run after that costs tokens, latency, and a review of output that may have changed. |
| "An agent loop is more flexible" | Flexibility you can't test is drift. If the path really is unknowable, record that in an ADR; otherwise fix it. |
| "The lead agent can decide which agent runs next" | Then the pipeline changes when the model changes. Put the hand-offs in code and keep the agents at the leaves. |
| "Structured output is enough" | A schema fixes the shape of one answer. It doesn't fix which step runs next, when to stop, or what happens when validation fails. |
| "The new code does what the prompt said" | The prompt left cases open and the model filled them in. Compare old and new on the same inputs before calling it equivalent. |

## Red Flags

- An agent decides the next step when the order is known in advance
- A prompt that says "first do X, then Y, then Z" where X, Y, and Z are lookups, transforms, or commands
- A model parses, formats, filters, sorts, counts, or routes by a fixed rule
- Model output is parsed with regexes or string matching instead of a schema
- A retry loop around a model call (`coding-standards` owns when a retry is allowed)
- The same multi-step procedure appears in two tickets, prompts, or transcripts with no script behind it
- Tests can't run without a live model
- A conversion shipped without comparing the old and new workflows on the same inputs

## Verification

- [ ] Candidates in the scope are listed with where each lives
- [ ] The workflow is listed as steps, each classified as deterministic, judgment, or human decision
- [ ] Every case the old workflow left implicit is listed and resolved from the requirements or by the owner
- [ ] Every deterministic step is code, a script, or a check, with a test or a run showing its output
- [ ] Control flow, including branches, loop bounds, and the stop condition, lives in code or a script
- [ ] Each remaining model call has typed input and output, validation with an explicit failure branch, a prompt in the repository, and a recorded reason it can't be code
- [ ] Any agent loop has an ADR saying why the path can't be known in advance
- [ ] For a conversion, old and new ran on the same inputs and every difference is fixed, recorded with the rule chosen, or an approved change with its acceptance test; for a new feature, the approved acceptance examples pass
- [ ] The deterministic part runs twice on the same input with identical output (show both runs)
- [ ] Tests pass with every model call replaced by a fake
- [ ] A script sits where step 7 says; in the brain repository, the prose steps it replaced are deleted

## Interaction with other skills

- `ci-cd-and-automation` wires deterministic checks into the pipeline; this skill finds which steps become those checks.
- `adrs` records the reason a step stays agentic.
- `coding-standards` owns the retry rule a judgment step's failure branch follows.
- `herdr-fanout` runs parallel coding subagents; that is persona orchestration and out of scope here. A multi-agent pipeline built in product code or a script follows step 5.
- `security-and-hardening` owns model output as untrusted input and tool permissions; this skill decides which steps a model gets at all.
