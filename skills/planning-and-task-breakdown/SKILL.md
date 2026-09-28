---
name: planning-and-task-breakdown
description: Scopes work before execution, distinguishing one focused ticket from a large engineer-owned plan; gates detailed technical tickets on reviewed HLD/LLD; breaks the full scope into milestones, estimated issues, and Linear cycles that each deliver a working, usable increment. Covers acceptance criteria, dependencies, disjoint owned paths, capacity, scope changes, and cycle reviews. Use when a request arrives and needs sizing, when you have a spec, PRD, or reviewed design to break into tasks, when a task is too large or vague, when planning a UI revamp or other large requirement, when a sprint starts or ends, or when unplanned work is discovered.
category: process
---

# Planning and Task Breakdown

## Overview

Scope first, design before detailed technical breakdown, then deliver usable increments. The appropriate discipline engineer owns the plan for the whole requested scope, not just the next implementation task. A small request may need one focused issue; a large request needs a project, milestones, and issues assigned to Linear cycles. Each cycle leaves the product working and adds a usable outcome toward the full scope.

The plan lives in `tasks/plan.md`; the work lives in Linear. A PRD story may require several focused technical issues. This skill owns scope, design readiness, and decomposition; `linear` owns tracker objects and operations; `continuous-delivery` owns the usable-increment standard. Personas and commands route here rather than maintain alternative planning steps.

## When to Use

- At intake, to decide whether one ticket suffices or the work needs a larger plan.
- A large requirement arrives, such as a UI revamp, even before design exists.
- A spec, PRD, or reviewed design needs an executable breakdown.
- A task is vague, dependencies are unclear, or agents will work in parallel.
- A cycle starts or ends, scope changes, or unplanned work is discovered.
- For small, obvious work, perform the scope check below and stop at one ticket; do not manufacture a project or a multi-sprint plan.
- NOT for creating or updating Linear objects: `linear`.

## Process

### 1. Scope the request before execution

Read the request, affected code and existing design, and current Linear work. Record the intended outcome, boundaries, non-goals, unknowns, and whether the scope is **small** or **large**. Scope size is a routing decision, not an implementation estimate.

- **Small:** one definite deliverable with known boundaries and a verification surface fits one focused ticket. Reuse current, reviewed design where it covers the change. A design-free chore needs no new HLD/LLD; record why design is not applicable. Small size does not excuse unresolved technical design.
- **Large:** multiple independently verifiable deliverables, flows, or components need a plan for the whole request. Select the appropriate engineer from the project's `AGENTS.md` persona table. For cross-discipline scope, identify the lead and delegate each discipline's design and tickets to its engineer, with shared dependencies explicit.

Do not implement during scoping. Preserve the full requested scope, including later phases, rather than shrinking the request to an MVP and forgetting the rest.

### 2. Resolve the design before detailed technical tickets

For a technical requirement with missing, incomplete, or outdated design, the **first actionable ticket creates or updates the required design documents**. Its goal is a bounded artifact, such as "Create checkout HLD" or "Specify order-close LLD", with user review as acceptance criteria. This documentation ticket can be scoped and estimated before implementation is known.

Use `hld` for component boundaries and communication; `lld` for exact contracts, schema, and internals. Those skills own document content and review.

Reuse approved documents that already answer these questions; do not rewrite them for ceremony. Write or revise the applicable HLD/LLD sections and obtain the user's review before deriving detailed implementation tickets, estimates, or cycle commitments. An approved HLD permits tickets for decisions it actually settles; API or schema details left open require the LLD first. A document still awaiting review is not approved.

Before that gate, high-level placeholders such as "Database schema needed" or "API work needed" are allowed in the backlog, explicitly **provisional, unestimated, blocked on design, and not executable**. Do not invent endpoint names, endpoint counts, exact scope, or delivery promises from these placeholders. Promote or split them after design review without creating duplicates.

### 3. Map dependencies from the reviewed design

Read the applicable HLD/LLD, PRD or issue-level requirements, domain model, existing code, and open milestones. Map component and issue dependencies; every dependency's shape must be resolved before implementation relies on it. Link each proposed technical issue to the design section that fixes its scope. Check that dependencies are acyclic and place high-risk work early.

### 4. Cut milestones and stories from the first usable outcome

Find the smallest flow a user or consuming service can exercise end to end. Cut milestones backwards from the full scope: each has a usable outcome, budget, verification command or manual flow, and explicit later scope. Order by user value and dependencies. The MVP is milestone 1; infrastructure alone is not a product milestone. Deterministic stubs are allowed only when the milestone explicitly calls for them; report that outcome as mock-backed, not production-complete.

Build one complete path at a time, not all schema, then all APIs, then all UI:

```
Bad:  Cycle 1 all schema · Cycle 2 all APIs · Cycle 3 all UI · Cycle 4 integration
Good: Cycle 1 close one order end to end · Cycle 2 bulk close with partial-failure handling
```

Stories describe user-observable outcomes and satisfy INVEST (independent, negotiable, valuable, estimable, small, testable). Technical issues beneath a story may deliver contracts, schema, or documentation individually; they need not each pretend to be a whole vertical slice. Their cycle must compose them into a usable increment. Every design module maps to a story; MVP stories come first.

### 5. Write focused issues, including foundations

One definite, observable deliverable per issue. "Build the feature", "Implement the backend", and "Do the UI revamp" are project-sized intentions, not executable tickets. Examples of bounded goals (implementation from reviewed design; documentation to establish it):

- "Define the close-order API contract from LLD §4.2."
- "Deliver the orders status schema migration from LLD §3."
- "Replace the account-menu layout while preserving keyboard navigation."
- "Create checkout HLD for service ownership and communication."

Each actionable issue carries acceptance criteria, verification, owned paths, interfaces consumed/provided, design references (or justified non-applicability for nontechnical work), dependencies, and an estimate. Documentation acceptance is reviewed artifacts; implementation acceptance includes tests and a working app. A ticket is not bounded merely because its title is short.

Identify the smallest shared foundation needed by the next slice. If contracts, schema, scaffolding, and types are independent deliverables, create separate focused foundation issues, not one kitchen-sink task. Each foundation blocks only its dependants. Record real dependencies between all issues; dependent work starts only after its prerequisites are merged. Independent work can run concurrently.

Owned paths of concurrent issues must be disjoint. If two need the same file, extract shared definitions into one prerequisite or serialize the work. Keep each PR independently deployable, flagged off when incomplete, and inside the PR size limit.

Split a ticket when it has independent goals, spans unrelated subsystems, cannot fit one focused session, or remains too uncertain to estimate. A single contract may require several acceptance criteria; do not remove necessary criteria to make it appear small.

### 6. Estimate using the team's Linear scale

Estimate relative effort, complexity, and uncertainty, not file count or a fixed conversion to hours. Use comparable completed issues as anchors; split large or uncertain work before committing it to a cycle. Provisional implementation placeholders stay unestimated until design resolves them.

Invoke `linear` to read the team's scale, set native estimates, and handle unavailable settings. It owns supported scales, T-shirt effort mapping, and capacity calculations; do not maintain another conversion here.

### 7. Plan delivery in Linear cycles

Invoke `linear` to select real scheduled **cycles** and read capacity, rather than invent a sprint calendar. Record the evidence or explicit assumption behind the capacity chosen.

Select focused issues in dependency order to fit capacity, with a **working product and a demonstrable usable increment at the end of every delivery cycle**. Name the end-to-end goal and verification flow before filling the cycle. Include the necessary contract, schema, implementation, integration, and tests for that slice in its plan. Reduce the slice if it cannot fit; do not move all integration to a later cycle. Each cycle must move toward the full requested outcome, not just keep the old product running unchanged.

Milestone dates and future cycles remain forecasts; only design-backed issues are executable commitments. High-level placeholders can show later scope without promised cycle dates.

Apply `continuous-delivery` when judging the cycle's product outcome; preparatory design tickets are not evidence of a delivered product increment.

### 8. Record and approve the plan

- Write `tasks/plan.md` using the template below. Never overwrite an incomplete plan for different work; stop and ask. Revise the same work's plan in place.
- Through `linear`, create or refine the project, milestones, focused issues, native estimates, dependency relations, and cycle assignments. The plan is an ordered index of real Linear identifiers, never a duplicate TODO tracker. Only when no tracker is configured, use `tasks/todo.md` as the task-list fallback; a failed tracker call does not authorize a second tracker.
- The appropriate engineer owns the full technical plan; the user reviews and approves it before implementation starts.
- Checkpoint after every two or three tasks and at each milestone: tests pass, the build is clean, and the core flow works. Keep HLD/LLD current; a changed design goes through review before recutting dependent issues.

### 9. Close every cycle with evidence

Record the usable outcome actually demonstrated and its verification, not only ticket counts. Report delivered work, spillover with reasons and revised estimates, estimation error, unplanned work, blockers, and the next cycle's capacity basis. Linear's automatic rollover is not acceptance of the old plan: review and re-plan rolled-over issues. Re-cut scope when a cycle misses its usable goal; do not represent layer-only progress as a successful product increment.

## Scope discipline

- Gather requirements before decomposition; phased PRDs and milestones preserve the whole request.
- Classify discovered work as MVP requirement, MVP blocker, or later. Only the first two enter automatically; other work becomes backlog issues with reasons. Re-check design and capacity before committing additions.
- Use the PM's PRD success target where applicable; engineers do not invent product targets. Technical requirements use their agreed measurable outcome.
- If a usable slice is technically impossible, state the blocker on the ticket and seek the explicit delivery override; do not silently turn a cycle into an unusable intermediate state.

## Plan document template

```markdown
# Implementation Plan: <request>

## Scope
<full outcome, boundaries, non-goals, small/large rationale, lead engineer and discipline owners>

## Design readiness
<design ticket ids, reviewed HLD/LLD sections, unresolved questions and provisional placeholders>

## Milestones
- Usable outcome: <what a user can do>
- Budget: <allocation and basis, or UNKNOWN>
- Verification: <command or manual flow>
- Prerequisites: <focused foundation issue ids>
- Deferred scope: <what comes later and why>

## Cycles and task index
<real Linear cycle ids/dates, usable goal, verification, scale, capacity/basis, planned effort>
<ordered issue ids per milestone/cycle, dependencies, checkpoints; no duplicate checklist>

## Risks and open questions
<risks, mitigations, decisions still needed from the user>
```

## Interaction with other skills

- Upstream: `prd-writing` supplies product stories and success targets; `hld` and `lld` resolve design before precise technical decomposition.
- Alongside: `linear` operates projects, issues, estimates, and cycles; `continuous-delivery` defines shippability; `development-setup` supports contract-first parallel implementation.
- Downstream: `test-driven-development` verifies acceptance criteria; `git-workflow-and-versioning` sets the PR size and release constraints.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "It's small, so I'll start coding." | Scope it first; one ticket may suffice, but missing technical design is still a gate. |
| "Planning only starts after design." | Intake scoping and the first documentation ticket come before design; detailed implementation breakdown comes after it. |
| "We know APIs are needed; let's estimate ten of them." | That is a provisional work area, not ten known deliverables. Resolve the LLD first. |
| "Build the feature is a clear ticket." | It hides multiple outcomes. Each issue needs one definite deliverable and proof. |
| "Every ticket must be a whole feature slice." | A contract or schema issue can be focused; the cycle must combine issues into a usable increment. |
| "The foundation ticket can include all shared work." | Independent deliverables get separate prerequisite issues and real dependency edges. |
| "The first sprint is all infrastructure." | Each delivery cycle must produce a usable product increment; planning artifacts are not that increment. |
| "Linear rolled it over, so the next cycle is planned." | Record the reason, reassess the estimate, and re-check capacity and usable outcome. |
| "The old plan is stale, I'll replace it." | Incomplete work may be in flight. Revise the same scope or ask before replacing another plan. |

## Red Flags

- Coding before the small/large scope decision or before the required design review.
- Detailed implementation estimates or cycle commitments derived from an unreviewed design or vague placeholder.
- A ticket titled "build feature"; foundation work bundled across independent goals.
- No design reference for a technical implementation issue, or endpoint counts guessed before the LLD.
- Parallel tasks sharing owned paths or starting before required contracts land.
- A delivery cycle with only documents, infrastructure, or isolated layers; no demonstrable usable outcome.
- Points hard-coded despite a different team scale; estimates only in prose; fictitious cycle ids.
- Silent spillover, undocumented scope additions, or an incomplete unrelated plan overwritten.

## Verification

Before implementation:

- [ ] Scope is classified small/large, boundaries are clear, and the appropriate engineer owns the entire plan.
- [ ] Missing technical design was handled by the first documentation ticket; applicable HLD/LLD sections are current and user-reviewed before detailed implementation tickets.
- [ ] Early placeholders are provisional and blocked; every executable issue has one definite goal, design basis, acceptance criteria, verification, owned paths, and dependencies.
- [ ] Native Linear estimates use the team's configured scale, with capacity based on delivery evidence or an explicit assumption.
- [ ] Every delivery cycle is a real Linear cycle with a working, usable outcome, verification, and a feasible dependency-ordered issue set.
- [ ] The full scope and deferred work remain visible, the user approved the plan, and no incomplete unrelated plan was overwritten.

At every cycle close:

- [ ] The usable increment is verified; delivered work, spillover reasons and re-estimates, estimation error, unplanned work, blockers, and next capacity are recorded.

## See Also

Acceptance criteria are per issue; the standing completion bar is `../../references/definition-of-done.md`.
