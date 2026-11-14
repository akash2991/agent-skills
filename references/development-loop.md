# Development loop

How a development agent moves from a request to a deployed change. Loaded by the engineers and the product manager.

## The loop

The loop is the Linear workflow (`linear` § Workflow): one ordered set of states from the user's request to production, on the issue itself, so the ticket always shows where the work is. Use its readiness gates and skipped-state procedure rather than a separate shortcut for bugs or small tasks. The user may short-circuit the workflow; record the instruction and skipped states on the issue.

Every HLD, LLD, and PRD is reviewed by the user before it counts as approved.

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
3. **Low or medium:** when CI is green, merge it yourself with `merge-pr.js` (`github`) and move the ticket.
4. **High:** start a `code-reviewer` subagent on the PR (`project/AGENTS.md` names its default model, harness, and effort). Resolve every finding with a commit or a reply; the reviewer approves the head and merges when CI is green.
5. **Wait on the user only when the ticket asks** for their review, approval, or testing; record that on the ticket and say so in the PR.

## Large-scale deprecation or migration

The seven-step sequence and its invariants: `deprecation-and-migration`.

## Brownfield

The conventions still apply. First, a conformance table, one row per convention, followed or not, with the evidence; then move the code incrementally. Move existing docs to their correct location; never delete them, never add to a deprecated doc.
