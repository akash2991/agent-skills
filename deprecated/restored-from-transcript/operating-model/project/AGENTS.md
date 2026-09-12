# Project Agent Instructions

This file specializes the user's global CEO/captain contract for this repository. Replace bracketed placeholders during project setup and remove sections that do not apply.

## Project

- Name: `[project name]`
- Product objective: `[one sentence]`
- Target users: `[users]`
- Current milestone: See `.agents/CURRENT_MILESTONE.md`.
- Current verified state: See `.agents/PROJECT_STATE.md`.
- Quality bar: Read `CONSTRAINTS.md` before changing code. Do not weaken it to make a change pass.

## Sources of Truth

Use this order for project facts:

1. Current user instruction.
2. This file and closer directory-level instructions.
3. `CONSTRAINTS.md` and the accepted specification for the active work.
4. `.agents/PROJECT_STATE.md`, refreshed against git/runtime evidence.
5. Accepted decisions under `.agents/DECISIONS.md` and `docs/decisions/`.
6. Story board and execution plan.
7. Historical reports and chat.

Do not treat a stale state file as current merely because it is canonical. Re-check the underlying source, then update the file.

## Commands

Fill these with exact repository commands before implementation. Use checked-in wrappers where available.

| Purpose | Command |
|---|---|
| Setup | `[set command]` |
| Start | `[set command]` |
| Focused test | `[set command]` |
| Full test | `[set command]` |
| Type check | `[set command or N/A]` |
| Lint | `[set command or N/A]` |
| Build | `[set command]` |
| End-to-end MVP check | `[set command or manual flow]` |

Do not invent a conventional command such as `npm test`; inspect the repository and CI.

## Preferred Starting Architecture

These are defaults for a new, undecided product—not authorization to restructure an established repository.

- Repository: monorepo for a multi-component product.
- Application shape: modular monolith.
- APIs: stable contract-first HTTP APIs documented with OpenAPI/Swagger where applicable.
- Web: React.
- Mobile: React Native/Expo, choosing the easiest viable approach first.
- Backend: Go or Python; surface the choice when not already decided.
- Database: SQLite or PostgreSQL; surface the choice when not already decided.
- Local development: Docker when it materially improves reproducibility.
- Infrastructure as code: use when deployment infrastructure is in scope; it may be explicitly deferred.
- Observability: Prometheus, Grafana, and Loki are preferred when observability is explicitly in scope.
- Optional reference: evaluate `https://github.com/Graphify-Labs/graphify` only when relevant; do not add it automatically.

Record actual choices and rationale in `.agents/DECISIONS.md`. Existing project decisions override defaults.

## Product Delivery

1. Define the smallest useful MVP and explicit deferred scope.
2. Create or update the sprint/milestone and story board.
3. Define contracts, domain models, boundaries, and relevant LLD sections before broad implementation.
4. Implement one small working story at a time.
5. Keep the repository runnable/testable after each increment.
6. Verify, commit when authorized, update durable state, and continue.

Use the existing SDLC skills as canonical workflows:

```text
DEFINE  → spec-driven-development
PLAN    → planning-and-task-breakdown
BUILD   → incremental-implementation + test-driven-development
VERIFY  → debugging-and-error-recovery when anything fails
REVIEW  → code-review-and-quality
SHIP    → shipping-and-launch
```

Use `project-captaincy` for multi-story accountable delivery and `delivery-visibility` for current status, usage, cost, and agent-state requests.

## Stories and Ownership

- Every change has an observable goal, acceptance criteria, verification, dependencies, status, and owner.
- Use `docs/stories/STORY_BOARD.md` and `docs/stories/stories.json` unless an existing external tracker is designated in `.agents/README.md`.
- One agent owns each path at a time. Concurrent assignments have disjoint paths.
- Shared contracts are owned explicitly and land before parallel consumers.
- Frontend and backend may work independently against stable contracts and deliberate mocks/stubs.
- The backend owns authoritative business rules and lifecycle state.

## Code and Design Rules

- Prefer the simplest solution that satisfies the current requirement. Do not design for hypothetical scale.
- Use strong types at boundaries and model domain states explicitly.
- Validate API, database, deserialization, persistence, and external-provider inputs at their boundaries.
- Keep API, application, domain, and database models separate when their responsibilities differ; translate explicitly.
- Name a design pattern only when it solves a concrete problem.
- Make payments a pluggable boundary when payment is in scope; do not build a generalized payment platform prematurely.
- Design common mobile capabilities—OTP login, notifications, forced update, analytics—with extractable boundaries when they are actually required.
- Do not add comments or logs by default. Add a comment for non-obvious intent or a log for an explicit debugging/operational requirement.
- Maintain database schema/design documentation when persistence exists.

## Verification and State

- Engineer verification, QA verification, and CEO/user verification are separate.
- QA independently verifies acceptance criteria for completed stories.
- A failed build blocks dependent work; safe independent work may continue.
- Before status reports, re-check relevant git, runtime, tracker, and agent state.
- Update `.agents/PROJECT_STATE.md`, `.agents/AGENT_REGISTRY.md`, `.agents/BLOCKERS.md`, `.agents/USAGE.md`, and `docs/execution/STATUS.md` when their facts change.
- Never fabricate usage, cost, verification, or agent state. Use `UNKNOWN` or `UNAVAILABLE`.

## Boundaries

### Always

- Preserve user-authored and unrelated work.
- Surface material ambiguity, one-way doors, and product-changing workarounds.
- Keep MVP, post-MVP, deferred, and blocked scope explicit.
- Stop repeated identical failed operations with no new information.
- Maintain a changelog for durable user- or consumer-visible changes.

### Ask First

- Destructive or irreversible changes.
- Production mutations, deployment, publication, external messages, credentials, payments, or secrets.
- Material schema, architecture, dependency, or product-behavior choices not already decided.
- Replacing an existing tracker, rules system, or project architecture.

### Never

- Commit secrets or unowned changes.
- Delete or weaken tests/constraints to get green.
- Expand scope silently.
- Present reported or historical state as verified current state.
- Let a persona invoke another persona.
