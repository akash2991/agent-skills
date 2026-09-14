# Execution Checklist

The organization's standing gates, used by the EM at every phase and by staff engineers per task. The per-change quality bar is the repo-wide [definition of done](definition-of-done.md); this checklist adds the org's sequencing and verification gates around it.

## Before implementation starts (EM, after design approval)

- [ ] Requirement is clear: PRD exists with testable acceptance criteria and explicit non-goals
- [ ] First usable increment is defined; deferred scope is written down
- [ ] Design approved by a PE who did not author it
- [ ] API interfaces, domain models, and class interfaces are defined for the milestone
- [ ] Milestones, sprint, stories, and tasks exist in the tracker with dependencies mapped
- [ ] Foundation task identified and assigned to one engineer
- [ ] Every task has an owner, disjoint owned paths, and a verification command that runs in this repository
- [ ] Every task records the model and effort it actually ran at, and its review path

## During a task (staff engineer)

- [ ] One task at a time; the goal restated in one sentence
- [ ] Owned paths respected; interface requests filed instead of edits elsewhere
- [ ] Stable contracts maintained; mocks or stubs only where the milestone plan says so, and labeled
- [ ] Small working commits; the repository runnable after each
- [ ] Tests written for every acceptance criterion
- [ ] Verification commands run; results recorded
- [ ] Blockers surfaced through the tracker, never silently worked around
- [ ] Discovered work classified (see scope discipline in `ORG.md`), not silently added
- [ ] No repeated identical failed action; loops stop and escalate

## After each task (staff engineer, then EM)

- [ ] Engineer verification passed and quoted in the report
- [ ] Commit created with the ticket id; PR raised with the PR template and linked on the ticket
- [ ] PR inside the size guards, or a stated reason; not held open to grow
- [ ] The change is deployable on its own: CI green, migration backward compatible, incomplete work flagged off
- [ ] Blast radius classified; discipline code reviewer's approval obtained where required; every review comment resolved
- [ ] Metrics emitted for the audiences the story warrants; log points at boundaries only
- [ ] Service `CHANGELOG.md` and `LLD.md` updated where contracts or schema changed
- [ ] QA engineer verified independently (`QA VERIFIED`)
- [ ] User pinged that the story is ready to verify; independent work continues
- [ ] Tracker state updated

## After each sprint (EM)

- [ ] Sprint review posted: delivered, spilled over with reasons and re-pointing, estimation error with causes, unplanned work, next capacity
- [ ] Every ticket that moved has a structured status update; every `Blocked` ticket has a defined blocker (type, dependency, requirement, owner)
- [ ] Open bugs are `bug` tickets with the full template, none in files or chat
- [ ] `CURRENT_MILESTONE.md` sprint table updated

## After each milestone (EM)

- [ ] Type check, lint, unit, integration, and end-to-end verification pass
- [ ] Application starts; the current usable product still works
- [ ] Broken dependencies fixed before dependent work starts
- [ ] `CURRENT_MILESTONE.md`, service docs, and the EM report updated
- [ ] Next milestone's entry criteria met

## Definition of done for a story (all three verifications are complementary, none replaces another)

1. Implementation exists and acceptance criteria are satisfied.
2. Engineer verification passed (tests, verification commands).
3. Integration verification passed where the story crosses boundaries.
4. QA independently verified against the acceptance criteria.
5. The user can verify the flow; the user has been told it is ready.
6. The change is committed and the tracker reflects it.

Anything short of this is `PARTIAL` or `BLOCKED`. Never round up.
