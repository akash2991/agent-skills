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

Every agent creates its own worktree, containers, LocalStack, data, and optional observability, locally or on a shared, short-lived EC2 machine; contract first, mocks on both sides, concurrent backend work, dependency shapes resolved first: `development-setup` DS1–DS17.

## Testing

A failing test before the code, end to end the way users use the product, concurrency, canvas automation, deferred performance testing: `test-driven-development` T1–T5.

## Large-scale deprecation or migration

The seven-step sequence and its invariants: `deprecation-and-migration`.

## Brownfield

The conventions still apply. First, a conformance table, one row per convention, followed or not, with the evidence; then move the code incrementally. Move existing docs to their correct location; never delete them, never add to a deprecated doc.
