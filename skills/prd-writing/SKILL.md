---
name: prd-writing
description: Produces a detailed product requirements document for one feature: users, outcomes, scope, stories with testable acceptance criteria, affected services, budget, and deferred scope. Use when a product manager receives a feature from the user and before any design work starts.
category: process
---

# PRD Writing

## Overview

The PRD is the contract between product and engineering. It states what must be true for the feature to be done, in testable terms, and what is deliberately not being built yet. Principal engineers design from it; EMs plan from it; QA verifies against it.

## When to Use

- A ticket exists and there is no PRD, or the existing one is stale.
- Scope changed materially mid-feature.
- NOT for a single bug or a task with clear acceptance criteria already in the tracker.
- NOT for technical design: the PRD says what, not how.

## Process

1. **Gather inputs**: the ticket, spec and decisions, the current product, existing services and their `HLD.md`, known constraints (budget, deadline, compliance).
2. **Define the outcome**: target user, the problem, the measurable outcome, and how it will be verified once shipped.
3. **Cut the first usable increment**: what is the smallest version a user can use? Everything else goes to "Later" with a reason, classified as `POST-MVP`, `NICE-TO-HAVE`, `OPERATIONAL HARDENING`, `SCALE OPTIMIZATION`, or `UNKNOWN` (see scope discipline in `ORG.md`).
3b. **Check requirement clarity.** For every story ask: what exactly happens, to which entity, in which state, what happens on failure or reload, which technology or interaction model is expected, and who decides? "Pin the notes to the geometry" is not a requirement until those are answered. Unanswered questions that materially affect implementation go to the user; do not let engineering choose an architecture around a guess.
4. **Write stories** in user terms. Each has acceptance criteria that a QA persona could verify without asking questions.
5. **Map to services**: for each story, which services change and which EM owns each. Flag stories that need a cross-service contract.
7. **List risks, assumptions, and open questions.** Open questions that block design are named in the output for the user to decide.
8. **Publish**: put the PRD in the tracker project description and link it from every story. Post a `pm-report.md` to the user.

## PRD template

```markdown
# PRD: <feature>
- Owner: <pm agent_id> · Tracker project: <id> · Version: <n> · Date:

## Problem and outcome
- Target user:
- Problem:
- Outcome (measurable):
- How we will verify after shipping:

## Scope
### First usable increment
### Later (with reason)
### Not doing

## Stories
### S1: <title>
- As a <user>, I want <capability> so that <outcome>.
- Acceptance criteria:
  - [ ] <testable statement>
- Services: <service → EM>
- Cross-service contract needed: yes | no

## Metrics
- Product metrics (usage events and funnel steps that show the feature is used):
- Business metrics (the counts or amounts the outcome is measured by):

## Non-functional requirements
- Security required for this feature:
- Performance / scale actually needed now:
- Compliance / data handling:

## Budget

## Risks and assumptions

## Open questions
| Q-id | Question | Blocking | Owner |
|---|---|---|---|
```

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "Engineering can figure out the details." | Undefined acceptance criteria become guesses and rework. |
| "We'll add the deferred list later." | If it is not written, it silently creeps back into scope. |
| "Budget is unknowable up front." | A rough budget still lets the EM route. Write the assumption and revise. |
| "One big story is fine." | Stories that cannot be verified independently cannot be delivered incrementally. |
| "Engineering will ask if something is unclear." | They will guess and build a lot of code around the guess. Ask the clarity questions now. |

## Red Flags

- A story with an acceptance criterion containing "should work correctly".
- No "Not doing" section.
- A service is affected but has no EM named.
- The PRD lives only in chat.

## Verification

- [ ] Every story has testable acceptance criteria and named services with EMs.
- [ ] First usable increment, Later, and Not doing are all non-empty or explicitly "none".
- [ ] Budget is set at feature and service level.
- [ ] Product and business metrics are named so engineers can emit them.
- [ ] Open blocking questions are escalated; the PRD is linked from the tracker project and all stories.
