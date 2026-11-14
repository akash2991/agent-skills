# Development loop

How a development agent moves from a request to a deployed change. Loaded by the engineers and the product manager.

## The loop

The loop is the Linear workflow (`linear` § Workflow): one ordered set of states from the user's request to production, on the issue itself, so the ticket always shows where the work is. Use its readiness gates and skipped-state procedure rather than a separate shortcut for bugs or small tasks. The user may short-circuit the workflow; record the instruction and skipped states on the issue.

An HLD, LLD, or PRD counts once merged with no open question; the user reviews it first only when they or the ticket ask (`documentation` W3).

## Size

Invoke `planning-and-task-breakdown` at intake: it owns the small/large decision, technical design-readiness gate, and whole-scope delivery plan. Use `linear` for the tracker operations; do not maintain another planning procedure here.

## Continuous delivery

The app works at every point, flags and code without an entry point, the MVP first, the one-shot override: `continuous-delivery` L3–L6.

## Development setup

Every agent creates its own worktree, containers, LocalStack, data, and optional observability, wherever it runs; contract first, mocks on both sides, concurrent backend work, dependency shapes resolved first: `development-setup` DS1–DS9, DS16.

## Testing

A failing test before the code, end to end the way users use the product, concurrency, canvas automation, deferred performance testing: `test-driven-development` T1–T5.

## From code to merge

The engineer takes its own change to merge; the user is not a step unless the ticket names them.

1. **Verify it yourself.** Run the tests and the running app in your own environment, and exercise every acceptance criterion through the entry point a user uses (`test-driven-development` T1, T2). Never leave testing to the user, the reviewer, or QA.
2. **Grade the blast radius** and open the PR ready for review, never as a draft, with the verification in its body (`git-workflow-and-versioning` P11, P17).
3. **Route it by `git-workflow-and-versioning` P17.** Low or medium, and the ticket asks for no review: merge it yourself with `merge-pr.js` (`github`) when CI is green, and move the ticket. High, or the ticket asks for review: hand the PR to a `code-reviewer` subagent to review and merge, under the assignment name `<ticket> review (code-reviewer)` (`project/AGENTS.md` names its default model, harness, and effort); resolve every finding with a commit or a reply, then hand the new head to that reviewer, or start a fresh one under the same assignment name, until it approves and merges. The assignment name is what clears its change request; a runtime name such as `… review r2` is not.
4. **Wait on the user only when the ticket asks** for their review, approval, or testing; their go-ahead is recorded on the ticket before anyone merges (P17).
5. **A refused merge says why.** A missing or malformed `Blast-radius:` line fails `pr-rules`; after fixing the body, push a new commit, since a failed run on a head keeps blocking it.

## Large-scale deprecation or migration

The seven-step sequence and its invariants: `deprecation-and-migration`.

## Brownfield

The conventions still apply. First, a conformance table, one row per convention, followed or not, with the evidence; then move the code incrementally. Move existing docs to their correct location; never delete them, never add to a deprecated doc.
