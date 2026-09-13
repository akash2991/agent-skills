---
name: self-improvement
description: Runs the loop where the organization improves itself: friction met while doing real work becomes a ticket against the brain's own sources, the change is made as a normal task with the org's own review and verification, the brain is rebuilt and re-injected, and the next session runs on the improved version. Use when an agent hits a missing skill, an unclear rule, a persona that does not fit, or a tool that fights the work, and when developing the brain repository itself.
category: process
---

# Self-Improvement

## Overview

The organization builds the organization. Friction met while doing real work is the only reliable signal of what to change, so the loop starts there rather than with speculation:

```text
real work → friction → ticket against the sources → change as a normal task
   ↑                                                        ↓
   └──── next session runs the improved brain ←── rebuild, re-inject
```

Two things make this safe rather than circular. The **sources** at the repository root are the only truth, and the injected `.agent-brain/` copy is a build artifact. And a session's rules do not change underneath it: a rule edited now takes effect at the next injection, so the agent that changed a rule is still bound by the old one until the loop closes.

## When to Use

- An agent hits a gap: no skill covers the task, a rule is ambiguous, a persona does not fit, a report has no field for what must be said, a tool fights the work.
- The same clarification is needed twice, which means the artifact is wrong, not the agent.
- You are working in the brain repository at all: every change here is a change to how every project behaves.
- NOT for a product bug in a project the brain was injected into. That is ordinary delivery.
- NOT for speculative improvement. An idea with no friction behind it goes to intake like any other request and competes on priority.

## The bootstrap invariants

Break these and the loop eats itself.

| Invariant | Why |
|---|---|
| The root sources (`org/`, `agents/`, `skills/`, `references/`, `control-plane/`, `templates/`, `scripts/brain/`) are the only truth | Two editable copies of a rule means the rule has no value |
| `.agent-brain/`, `.claude/skills/`, `.claude/agents/` in this repository are generated | Editing them is lost work, and it silently diverges the running brain from what ships |
| A rule takes effect at the next injection, not on save | A session whose rules shift mid-task cannot be reasoned about or reviewed |
| The checks are the contract | `npm run all`, the skill and eval gates, the control-plane tests, and an inject smoke test all pass before merge |
| A guard is never weakened to make a task pass | See below. This is the rule that keeps a self-modifying system honest |

## Guards that need the user, not a review

A system that edits its own rules can always make a task easier by relaxing the rule that made it hard. That must not be a decision the organization can take alone. Any change that weakens one of these is a request to the **user**, with the reason and what it would allow, and it does not merge on an internal review:

- the single-CEO lock, or anything that lets a second session claim the role
- a budget guard: the allocation chain, the exhaustion stop, or the warning threshold
- the blast-radius rule, the review gate, or what counts as a small change
- the definition of done, or any verification step
- the specialists-only rule, the escalation ladder, or the out-of-scope refusal
- the privacy boundary on observability events
- the checks themselves, or a validator's contract

Tightening a guard is ordinary work. Loosening one is the user's call. When a guard is genuinely wrong, say so plainly and propose the change; do not route around it.

## Which flow steps the brain skips on itself

The project flow exists to coordinate many roles across many services with a user who cannot read the code. This repository has two services, no public API, no external consumer of its internals, and one deployable artifact, so some of those steps cost more than they return. The owner authorized the exemptions below (brain-org D-1). They apply **only** when the work being done is a change to this repository. A repository the brain is injected into follows every step, without exception, and nothing here may be quoted to skip a step there.

| Step | On the brain itself | Why |
|---|---|---|
| PRD | Skipped. The friction ticket is the requirement | The ticket already says what hurt, what it cost, and what artifact is suspected. A PRD would restate it for an audience of one |
| HLD | Skipped entirely, for both services | Two services, no public API, one artifact. Each service keeps a small `LLD.md` as its whole design record |
| LLD | Kept, small. Module boundaries, the contracts others depend on, the decisions taken, and what must keep holding | This is the part that stops the next change from breaking an interface nobody remembered |
| Design review by a second principal engineer | Only when the change crosses both services, moves a contract in the table above, or touches a guard | A reviewer on a one-file rule change is ceremony |
| Milestones and sprints | Optional. Opened only when a change is large enough to need slicing | Most work here is one friction ticket, one PR. An empty sprint table is worse than none |
| Foundation-first ordering | Applies as written whenever two changes would touch the same contract | Nothing about repository size makes a contract race safe |

Everything else stands and is not negotiable here:

- **Intake.** Friction goes to the CEO and competes on priority against delivery (the coordinator). Skipping the flow is not permission to skip the queue.
- **Budgets.** Allocated and enforced the same way, with the same stop-and-ask at exhaustion.
- **Specialists only.** The `org-*` personas do this work. A missing persona is a hiring request, not an improvised generalist.
- **Code review.** By the reviewer the class table above names. Merge by blast radius applies unchanged.
- **Tests and verification.** The checks are the contract: `npm run all`, the skill and eval gates, the control-plane tests, and an inject smoke test.
- **The guard rule.** Loosening a guard is the user's call whatever the size of the change, and the exemptions on this page are themselves a guard: widening them is a request to the user, not a judgment call.

The brain's own stack is likewise allowed to differ from the stack it enforces (brain-org D-3, brain-platform D-2). Plain Node JavaScript and a single HTML page here; Node with TypeScript and React with TypeScript in every injected project. That is a recorded divergence with a reason, not a conformance gap, and nobody should "fix" it into one.

## Process

### 1. Capture the friction where it happened

Do not fix it inline and move on, and do not work around it silently. File it with what you were doing when it bit:

```markdown
### Brain friction F-<ticket>-<n>
- Hit by: <agent_id> (<role>) while: <the real task>
- Friction: <one sentence: what was missing, unclear, or wrong>
- What I did instead: <the workaround, or "blocked">
- Cost: <time, tokens, a wrong turn, a rework>
- Suspected artifact: <org part | persona | skill | reference | report | control plane | pipeline>
- Recurrence: <first time | seen before in <ticket>>
```

A second occurrence raises the priority by itself. The same question asked twice is a defect in an artifact, not a slow learner.

### 2. Let intake decide

The friction goes to the CEO like any other request (the coordinator). It competes on priority against product work, because improving the brain is not automatically more important than delivering. Recurring friction and anything that blocks work outrank a one-off annoyance.

### 3. Classify the change, because that decides the review

| Class | Lives in | Reviewed by | Verified by |
|---|---|---|---|
| Rule | `org/NN-*.md` | `org-principal-engineer`, then the user if it touches a guard | the rendered `ORG.md` reads correctly and no other artifact contradicts it |
| Persona | `agents/*.md` | `org-code-reviewer` | the persona linter, and the role's own report format still fits |
| Skill | `skills/<name>/SKILL.md` | `org-code-reviewer` | skill anatomy, an eval case with a behavioral eval, the trigger gate |
| Reference | `references/*.md` | `org-code-reviewer` | link check, and no duplication with the skill that owns the topic |
| Control plane | `control-plane/` | `backend-code-reviewer` | a test in `control-plane-test.js` for the property, not just the path |
| Pipeline | `scripts/brain/` | `backend-code-reviewer` | build every target, then inject into a scratch repository and exercise it |

### 4. Make the change as a normal task

One ticket, one PR, inside the size guards, deployable on its own. "Normal" here means the flow minus the exemptions above: no PRD, no HLD, the service `LLD.md` updated in the same PR when a boundary or contract moves. The brain's own conventions apply to the brain: no duplication across a skill, a persona, and a reference; one artifact owns a topic and the others point at it.

### 5. Close the loop

A change that is merged but not injected has improved nothing:

```bash
npm run all            # validate, select, build every target
npm run inject:self    # this repository runs on its own output
```

Then start a new session so the harness picks up the rebuilt commands, skills, and rules. Record in the ticket that the loop closed, with the commit.

### 6. Check whether it worked

The measure is not that the change merged. It is whether the friction stopped:

- Did the same friction recur in a later session? Then the fix addressed the symptom.
- Did the artifact get used at all? A skill that never triggers is either wrongly described or was not needed.
- Did the change make something else harder? A rule that fixes one role's problem by adding work for three others is a bad trade.

Review the friction tickets at each milestone close alongside the parked queue.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "I'll just work around it this once." | The workaround is invisible to everyone else, so the next agent pays the same cost. Thirty seconds to file it saves the repeat. |
| "I'll edit the injected copy, it's faster." | That copy is overwritten on the next build. The change is lost and the running brain silently diverges from what ships. |
| "The rule is in my way, I'll adjust it." | Then the rule stops meaning anything. Tighten freely; loosening a guard is the user's decision. |
| "This improvement is obviously worth it." | Obvious improvements still compete for budget with delivery. Send it through intake and let priority decide. |
| "I changed the rule, so it applies now." | It applies at the next injection. Until then you are bound by the version you started under. |
| "Let me redesign the whole organization while I'm here." | A rewrite has no friction behind it and no way to tell whether it helped. Change what hurt. |
| "No test is needed, it's just markdown." | A skill with no eval case is unroutable, and a rule nothing checks is a suggestion. |
| "The brain skips the flow, so I can skip the review too." | The exemptions are a named list. Review, tests, intake, and budgets are not on it. |
| "The brain doesn't use TypeScript, so the rule must be soft." | The brain's divergence is a recorded decision about the brain. The enforced stack binds every injected project exactly as written. |

## Red Flags

- A workaround in a report with no friction ticket behind it.
- An edit to `.agent-brain/`, `.claude/skills/`, or `.claude/agents/` in this repository.
- A guard loosened on an internal review, with no record of the user agreeing.
- A merged change to the sources with no re-injection, so nothing actually improved.
- The same friction in two sessions with the earlier ticket still open.
- A new skill with no eval case, or a new persona with no report format that fits it.
- A change to a validator's contract made to let a change through rather than to fix the code.
- Brain work admitted ahead of delivery with no stated reason.
- An exemption on this page cited while working in a repository the brain was injected into.
- A contract moved without the service `LLD.md` changing in the same PR.
- The exemption list widened by an agent rather than by the user.

## Verification

- [ ] The change traces to a friction ticket describing real work, not a speculative idea.
- [ ] It was admitted through intake, with its priority against delivery recorded.
- [ ] The class was identified and reviewed by the matching reviewer.
- [ ] Anything that weakens a guard has the user's explicit agreement on the ticket.
- [ ] `npm run all`, the skill and eval gates, the control-plane tests, and an inject smoke test all pass.
- [ ] `npm run inject:self` ran after merge, and a new session was started on the result.
- [ ] Any step skipped is one this page names, and the work is in this repository.
- [ ] The service `LLD.md` matches the code if a boundary, contract, or invariant moved.
- [ ] The friction ticket records whether the friction actually stopped.
