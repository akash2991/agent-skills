---
name: linear
description: "Operates Linear as the organisation's single tracker, in Linear's own vocabulary: projects divided into milestones made of issues, cycles, labels, estimates, relations, triage, templates, and the one workflow every issue follows from request to production; carries the issue rules M1–M7. Use when any persona creates, updates, reads, queries, or reassigns anything in Linear, files a bug or a review finding, posts a status or project update, records a skipped state, sets up a project's Linear team, or the user says \"make a ticket\", \"create a project\", or \"track this\"."
category: tools
---

# Linear

## Overview

Linear is the source of truth for all work: what was asked, what was decided, what changed, and why. This skill speaks Linear's vocabulary so that what you must do is what Linear shows. A **project** holds a large scoped outcome: "a unit of work that has a clear outcome or planned completion date, comprised of issues and optional documents". A project is divided into **milestones**, "different stages in a project's lifecycle", each a usable outcome. An **issue** is the smallest unit of work and the one an agent works on: from a few minutes to several days. Assign it to the relevant existing project and milestone; a small standalone request does not require manufacturing a new project. A **cycle** is the team's time-box. The rules (M1–M7) say when an issue exists and what it carries; the objects table says how that lands in Linear; the workflow says where the work is; the templates in `templates/` say what to write. What a project, its milestones, and its issues contain is decided by `planning-and-task-breakdown`.

## When to Use

- Setting up a project's Linear team: creating the workflow states and labels once.
- Filing the issue before any work starts; creating a project, a milestone, a cycle, or an issue.
- Changing an issue's state, assignee, labels, estimate, milestone, cycle, or relations; posting a status update, a project update, or a blocker.
- Filing a bug or a review finding; recording a skipped state or an override.
- Answering what an issue or a project is about, what changed, or where it is.
- NOT for deciding how a feature is divided into milestones and issues: `planning-and-task-breakdown`.

## Rules

| ID | Rule |
| --- | --- |
| M1 | **An intake issue before work; actionable issues before execution.** Record the request, then apply the scope and design-readiness decisions from `planning-and-task-breakdown`. Use the Workflow below to represent their readiness in Linear; an issue's existence alone does not make it executable. |
| M2 | **An issue created from a direct user request carries the prompt verbatim.** |
| M3 | **A workflow state that is skipped is recorded on the issue with the reason.** An override of any convention (one-shot development, a migration plan change) is accepted only on an explicit user instruction and is recorded in `docs/LEARNINGS.md`, with a note on the issue. |
| M4 | **The issue carries the reasoning; the code and the commit carry the issue id.** The issue and the commit message together replace most documentation: do not repeat on one what the other already says. |
| M5 | **Every state change, reassignment, or re-estimate is a status update on the issue**; a `Blocked` update carries the blocker block. A project gets a project update at every milestone close and whenever its health changes. |
| M6 | **Linear is the single place.** No markdown TODO lists, notes files, or chat threads for work; bugs live only as `bug` issues; reviewers file findings as `review` issues. |
| M7 | **Read before write; write, then read back.** Search for the project, milestone, cycle, or issue first and never create a duplicate; quote the identifier of what you created or changed; if a call fails, report the failure and retry once. Never fabricate an identifier. |

## Setup

- **The team and the key** come from the project's local `.env`, never from the repository: `LINEAR_TEAM` is the team key, `LINEAR_API_KEY` a personal API key. One team per repository unless the user says otherwise.
- **The workflow** is created once per team by the user: `skills/linear/scripts/create-workflow.sh` reads `LINEAR_TEAM` and `LINEAR_API_KEY` from the environment and `skills/linear/workflow.json` from this skill, enables triage, creates the missing states in their categories, puts them in the workflow's order, never renames or deletes an existing one, and prints the team's states as JSON. `Triage` and `Duplicate` are Linear's own reserved states: enabling triage creates them and Linear refuses every write to them, so the script only checks they are there. When a project starts, list the team's states; if any of the workflow's states is missing, ask the user to run the script. Create the labels below yourself, once.
- Verify with a read-only call before writing anything.
- Read the team's estimate scale, cycle schedule, upcoming cycles, and capacity before planning. Reuse existing cycles; do not change team settings silently. If estimates or cycles are disabled, or the available tool cannot read or set the needed field, report the gap and ask for setup rather than inventing values or identifiers.

## Linear objects and how we use them

| Linear object | What it is | How we use it |
|---|---|---|
| **Workspace** | the container for all teams, projects, and issues | one |
| **Team** | owns its workflow, triage, and cycles | one per repository; its key is `LINEAR_TEAM` in the local `.env`; the workflow created once by the user with the script, checked by you |
| **Initiative** | a strategic effort above projects | optional: a roadmap theme grouping several feature projects; the PM owns it |
| **Project** | **a scoped outcome**: a clear outcome or completion date, comprised of issues and optional documents; can be shared across teams | one per large scoped outcome; small work can remain an issue. Lead = the persona driving it; members = the personas working it; description = `templates/project.md`; documents = the PRD, HLD, LLD, and ADR links; a target date at the certainty the user has; a project update (`templates/project-update.md`) at every milestone close and when health changes |
| **Milestone** | a stage of a project, dividing its issues; progress is the percentage of its issues started and completed; belongs to one project | **a usable outcome**: something a user can exercise after it; ordered by earliest usable outcome; an optional target date; description = the milestone record from `planning-and-task-breakdown`; the first milestone is the MVP |
| **Issue** | **the fundamental unit of work**: the smallest thing tracked, from minutes to days; in at most one project and one milestone at a time | **what an agent works on**: one goal in one sentence as the title, `templates/issue.md` as the body, an estimate, owned paths, `blocks` relations; assigned to a cycle when planned; moved through the workflow by the agent doing it |
| **Sub-issue** | an issue under a parent, for "work too large to be a single issue but too small to be a project"; inherits the parent's team, priority, and project | only when an issue must be broken down further; each is a full issue with its own state and estimate; the parent is done when its sub-issues are done, never before |
| **Cycle** | the team's recurring time-box; Linear creates upcoming cycles automatically; unfinished issues roll over; nothing is assigned to a cooldown | our sprint: use the team's configured cadence and real cycle id; record the usable goal, verification, capacity basis, and planned issues in `templates/cycle.md`; review outcomes and rollover at close. Cycles are not release gates: ship ready increments throughout them |
| **Estimate** | the issue's native estimate on its team's configured scale | use the enabled scale (Fibonacci, linear, exponential, or T-shirt), based on relative effort, complexity, and uncertainty; split oversized or unclear work. Do not force 1/2/3/5/8 on a differently configured team or substitute prose for the native field |
| **Priority** | urgency on an issue | set by the PM: urgent, high, medium, low, none |
| **Label** | classification on an issue | `service:<name>`, `persona:<name>`, `bug`, `review`, `contract`, `bug:<functional\|regression\|performance\|security\|data\|ux\|flaky-test\|environment>`, `severity:<blocker\|high\|medium\|low>`; created once per team |
| **Relation** | a link between issues | `blocks` / `blocked by` for dependencies (the foundation issue blocks every dependent one), `related` for context, `duplicate` before cancelling |
| **Triage** | the team's inbox for new work | a direct user request lands in `Triage` as a request (`templates/request.md`: feature, product change, tech improvement, chore, question) with the prompt verbatim, then is classified into a project or an issue |
| **Template** | a body per object | `templates/` in this skill: request, project, issue, bug, status update, project update, cycle; read the one you need when you write |
| **Attachment** | a link on an issue | the PR (title starts with the issue id); verdicts mirrored as status updates |
| **Comment** | a record on an issue or a cycle | status updates (`templates/status-update.md`), the cycle review, the blocker block; never chat that belongs elsewhere |
| **Workflow state** | where the work is | the Workflow below |

A bug is an issue with the `bug` label (`templates/bug.md`), related to the issue it affects. A review finding is an issue with the `review` label, related to the PR's issue. Each focused foundation issue records its actual dependants through `blocks`; contract issues carry the `contract` label. Only dependent implementation waits for it to land; unrelated ready work can proceed. A story in the PRD is delivered by one or more issues in the milestone that ships it.

### Estimates and cycle capacity

Read the configured scale before setting each actionable issue's native estimate. T-shirt sizes are XS/S/M/L/XL (with optional extended values); Linear maps them to Fibonacci values for effort calculations. Use Linear's reported effort or that documented mapping and state the basis, rather than summing labels or inventing conversions. Unestimated is not zero: Linear can count unestimated issues as one point, so provisional placeholders must not be mistaken for sized commitments.

Linear's capacity dial uses the previous three completed cycles; without history it estimates from team membership. Distinguish that forecast from any explicit planning assumption. Keep estimates and capacity in the same team scale, use the outcome-based cycle plan from `planning-and-task-breakdown`, and read back estimate and cycle assignments after writing. Reassess automatically rolled-over work rather than treating rollover as a new commitment.

Sources: [Linear estimates](https://linear.app/docs/estimates) and [Linear cycles](https://linear.app/docs/use-cycles).

## Workflow

One workflow per team, the whole cycle from the user's request to production, as ordered Linear workflow states in Linear's categories (Triage, Backlog, Unstarted, Started, Completed, Canceled, Duplicate). It is the development loop: there is no other. `workflow.json` defines it and the script creates it; this table says what each state means. Every issue follows it, but not every issue needs every state: skip what the work does not need and record every skip on the issue with the reason (M3).

| Category | State | The issue is here while | It leaves when |
|---|---|---|---|
| Triage | `Triage` | a request arrived (`templates/request.md`), in the user's words, not yet classified | it has a kind, an owning persona, scope boundaries, and a size: design-ready small work → `Todo`; unclear intent → `Spec`; missing technical design → a documentation issue in `Design`; large work → the project's planning issue |
| Backlog | `Backlog` | accepted, in a project or not, not planned into a cycle | it is pulled into a cycle |
| Unstarted | `Todo` | one bounded deliverable is ready: implementation has reviewed design and settled contracts; a documentation issue has clear design questions and artifact acceptance criteria | its execution prerequisites are met and an agent declares and starts |
| Started | `Spec` | intent is being pinned down: interview, refine, spec; a feature gets its phased PRD | the user reviewed the PRD, or the spec is on the issue |
| Started | `Design` | HLD, LLD, ADRs; the contracts and the DB model | the user reviewed the design and the contracts exist |
| Started | `Planned` | reviewed design has been decomposed into focused issues with real dependency relations | actionable issues have native estimates, owned paths, and cycle assignments whose goals are usable increments |
| Started | `In Progress` | code and tests, in the agent's own environment | the PR is raised |
| Started | `In Review` | the PR is open; findings inline and as `review` issues; the author resolves every thread | approved, or review made optional on the issue and CI green |
| Started | `QA` | independent verification of a milestone's usable outcome, end to end and under concurrency | QA verified; a failure is a `bug` issue |
| Started | `Merged` | in `main`, releasable, changelog line added; build and deploy pending | it is deployed |
| Started | `Blocked` | it cannot continue; the status update carries the blocker block | the blocker is resolved; it returns to the state it left |
| Completed | `Done` | the issue's deliverable is verified: code deployed and exercised where specified (production by default); a design-only issue has committed artifacts and recorded user review | never; a regression is a new `bug` |
| Canceled | `Canceled` · `Duplicate` | it will not be done, or another issue tracks it (related as duplicate) | |

Typical paths, the skipped states recorded:

- **A design-ready bug or small issue**: `Triage` → `Todo` → `In Progress` → `In Review` → `Merged` → `Done`. Small size alone does not justify skipping unresolved design.
- **Missing technical design**: track the documentation deliverable in `Design`; keep provisional implementation placeholders in `Backlog` with `blocked by` relations and no estimate or committed cycle. Close a design-only issue after artifact and user-review evidence, recording inapplicable deployment states as skipped. After the design gate in `planning-and-task-breakdown` is met, refine the implementation issues and assign the native estimate and cycle fields.
- **A large feature**: one planning issue runs `Triage` → `Spec` → `Design` → `Planned` and produces the project, its milestones, and their issues; then each issue runs `Todo` → `In Progress` → `In Review` → `Merged` → `Done`; the milestone's usable outcome gets a `QA` issue before the milestone closes; the project completes when its last milestone's issues are `Done`.
- **A one-shot override** (M3): `Todo` → `In Review`, the skipped states named in the note.

The agent doing the work moves the issue, with a status update on every move (M5). A parent issue never runs ahead of its sub-issues; a milestone closes when its issues are `Done` and its outcome is verified, with a project update.

## Interaction with other skills

- `planning-and-task-breakdown` decides what the project, its milestones, its cycles, and its issues contain; this skill creates and tracks them in Linear's terms.
- `github` links the PR to the issue; `test-driven-development` writes the test behind every acceptance criterion.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "It's a small change, I'll file the issue after." | An issue comes before any work; without it nobody could see the work in progress and the skipped states were never recorded (M1, M3). |
| "The prompt is long, I'll paraphrase it." | The verbatim prompt is what the issue is judged against later. Paste it (M2). |
| "The user said to one-shot it, so the convention is gone." | An override is accepted only on an explicit user instruction and is recorded in `docs/LEARNINGS.md` with a note on the issue (M3). |
| "I'll explain the reasoning in a code comment." | The issue carries the reasoning; the code carries the issue id (M4). |
| "A one-line comment is enough for this state change." | Without the structured update nobody can later tell why the issue moved (M5). |
| "I'll track this small thing in the PR description / a notes file." | Linear is the single place; things that live elsewhere get lost and cannot be queried, assigned, or linked (M6). |
| "The call failed, I'll note the id I expected." | A guessed identifier corrupts every report that quotes it. Report the failure and retry once (M7). |
| "A large feature is just one big issue." | Large scope needs a project, milestones, a planning owner, and focused issues. Small, bounded work may remain one issue after the scope and design-readiness checks. |
| "I'll nest sub-issues to organise the milestone." | Milestones organise a project's issues. A sub-issue is only for an issue too large to be one issue and too small to be a project. |
| "The team's states are close enough; I'll map ours onto them." | Run the script; it adds what is missing and touches nothing else. Every project uses the same workflow. |

## Red Flags

- Work started with no issue, or a direct request with no verbatim prompt (M1, M2).
- A state skipped, or a convention overridden, with nothing on the issue or in `docs/LEARNINGS.md` (M3).
- A commit or PR with no issue id (M4).
- A state change without a status update; a `Blocked` issue without the blocker block; a milestone closed without a project update (M5).
- A bug outside the tracker or without reproduction and severity; work in a markdown list only (M6).
- A quoted identifier that was never read back; a duplicate project, milestone, cycle, or issue (M7).
- A team whose states are not the workflow; large multi-deliverable scope tracked as one executable issue; an issue in a project with no milestone; an issue with no owned paths, no outcome, or no verification surface; an issue rolled over without a reason.
- An issue `In Review` with no PR link, or a merged PR whose issue did not move; a cycle closed without a cycle review.

## Verification

- [ ] The team has the workflow states and labels; `LINEAR_TEAM` and `LINEAR_API_KEY` are in the local `.env`, not in the repository.
- [ ] The request is scoped before execution and its actionable issue exists; large work has a project and design/planning issue before implementation breakdown. Detailed implementation issues wait for applicable design review (M1).
- [ ] A request is filed with `templates/request.md` and carries the prompt verbatim; skipped states and overrides are recorded (M2, M3).
- [ ] The issue is in the workflow state its work is in; a skipped state has a status update with the reason (M3, M5).
- [ ] Every actionable issue follows `templates/issue.md` with a definite deliverable, native estimate, verification, owned paths, and design basis; provisional placeholders remain explicitly blocked and unestimated. Every project follows `templates/project.md` with its documents attached.
- [ ] Every state change has a status update; `Blocked` updates carry the blocker block; every closed milestone has a project update (M5).
- [ ] Every bug is a `bug` issue with the full template and labels; every review finding is a `review` issue (M6).
- [ ] Every delivery cycle has a real Linear id, a usable goal, verification, and capacity in the team's scale; its review records actual product outcomes and reassessed spillover, not only ticket counts.
- [ ] Every object was read back and its identifier quoted; no duplicate was created (M7).
