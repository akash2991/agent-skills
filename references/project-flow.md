# Project flow

The order work moves in. **You drive it.** Nothing here starts by itself: you invoke each role, it does one step, and it tells you who to invoke next. Loaded by the CEO, PM, principal engineers, and EMs.

The loop is always **idea → spec → design → code → test → QA**, run per milestone and per sprint:

```text
You invoke each step. Nothing starts itself.

/brain-ceo             a requirement becomes tickets, or you get a status answer
/brain-pm              a ticket becomes a PRD
/brain-pe-<discipline> a PRD becomes a design: domain model, interfaces, plan
/brain-pe-<other>      a second principal engineer reviews the design
/brain-em              an approved design becomes milestones, sprints, and ready tickets
/brain-swe-<discipline> one ticket becomes a pull request with tests
/brain-review-<discipline> the pull request is reviewed and approved or rejected
/brain-qa              the story is independently verified
/brain-security        anything touching auth, payments, data, or external input
/brain-webperf         before a web milestone ships
```

Each role ends by naming which command should run next and with what. You decide whether it runs, and when. A step that adds nothing is skipped: that is your call, not the organization's.

At every role boundary, the assignment packet preserves `agent_id`, parent, session, runtime binding, and trace lineage. Every role emits the metadata-only events required by "Agent work observability"; this is how the CEO sees the live hierarchy, context contribution, turns, tools, usage, and cost without relying on chat summaries.

## Progressive usability

Before broad implementation the EM asks: *can I run the application and demonstrate something useful?* If not, stop expanding scope and build the smallest vertical slice. A typical order: app starts → login API and home API work (so the UI can be tested) → UI renders login and home → one core user action works end to end → persist it → secondary flows → polish and hardening. The exact sequence depends on the product; the principle is mandatory: something more usable after every increment, and the repository runnable after every commit.

## Story states

`Backlog → Ready → In Progress → In Review (PR raised) → Approved → Engineer Verified (merged) → QA Verifying → QA Verified → User Verifying → Done`, plus `Blocked` (with reason and next action). Changes requested on the PR move the ticket back to `In Progress`. Engineers move their own tickets and raise the PR; code reviewers move `In Review` to `Approved` or back; QA moves QA states; the EM closes milestones; the CEO owns prioritization and scope. Every move carries a structured status update and the PR link. Mapping to the tracker is in the `{{PM_TOOL}}` skill; the PR flow is in `{{ORG_DIR}}/references/pull-request.md`.

## Scope discipline

Discovered work is never added silently. Classify it: `MVP BLOCKER`, `MVP REQUIREMENT`, `POST-MVP`, `NICE-TO-HAVE`, `OPERATIONAL HARDENING`, `SCALE OPTIMIZATION`, `UNKNOWN`. Only the first two enter the current scope automatically; everything else is surfaced to the PM for prioritization. Work that is commonly deferred until traffic or the user requires it: duplicate-payment checks, alerting and dashboards (the metrics themselves are always emitted, see `{{ORG_DIR}}/references/metrics-and-logging.md`), runbooks, database backups, advanced scaling, sophisticated observability, Terraform, generalized platform abstractions. If the user asks for them or the MVP genuinely depends on them, they are in scope.

## Contract independence

Backend, web, and mobile proceed independently against agreed contracts. Backend lands a stable, tested contract (with deterministic stub data when real data is deferred) before clients depend on implementation details. Web and mobile use a replaceable mock adapter that matches the contract's schema, errors, and states; a mock never redefines the contract, and a mock-backed story is not "integrated" until real integration is verified. Backend owns business truth (eligibility, price, lifecycle); clients render state and submit intent.
