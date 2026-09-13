---
name: brownfield-adoption
description: "Brings an existing codebase under the organization: inventories services and assigns EMs and PMs, documents the current state as HLD, LLD, and DB diagrams at overall and service level, runs a gap analysis against the global conventions, and turns the gaps into a refactoring roadmap (domain typing per API, feature-first layout, generated typed clients) delivered through normal milestones and sprints. Use when the brain is first injected into a repository that already has code, or when a service has never been documented against the conventions."
category: process
---

# Brownfield Adoption

## Overview

An existing codebase is adopted in three passes: **know it** (inventory, owners, as-is documentation), **judge it** (gap analysis against `CONVENTIONS.md` and the LLD principles), **change it** (a roadmap of refactors delivered as ordinary milestones and sprints, one API or feature at a time, with the product runnable throughout). Nothing is refactored before it is documented as-is, and nothing is documented that has no owner.

## When to Use

- The brain has just been injected into a repository with existing code.
- A service exists in code but has no `services/<name>/` docs.
- Before any refactoring toward the conventions.
- NOT for greenfield features; use the normal flow (`prd-writing`, `hld`, `milestone-planning`).

## Process

### Pass 1: know it (a principal engineer, then EMs)

1. **Inventory services.** A principal engineer lists every deployable unit, package, and client app from the repository: entry points, build targets, Dockerfiles, CI jobs. Record the list in the global `DECISIONS.md` as the service map.
2. **Name owners.** One engineering manager per service. This is a note for the user, who invokes them; no agent assigns work. Record the service map in the global `DECISIONS.md` and create one tracker project per service named `Adoption: <service>` with a milestone `As-is documented`.
3. **Create service docs.** Each EM copies `templates/service-docs/` into `services/<name>/` and fills `CONVENTIONS.md` commands from what actually runs (never invented).
4. **Document the current state, as-is.** Per service, the EM assigns a PE (backend for services, web or mobile for clients) to write the *current* `HLD.md`, `LLD.md`, and DB schema (`schema.ddb`) with the `hld` and `lld` skills, describing what the code does today, including the ugly parts, with `hld.drawio` and Mermaid sequences for the critical paths. A cross-service PE writes the overall as-is HLD in the global docs. Every unknown is written as `UNKNOWN`, never guessed.
5. **Baseline verification.** Each EM records the commands that currently pass (tests, build, start) in `CURRENT_MILESTONE.md`; that is the floor no refactor may break.

### Pass 2: judge it (PEs, reviewed)

6. **Gap analysis** per service against the global `CONVENTIONS.md` and the `lld` principles, as a table: convention → current state → gap → blast radius → suggested tier. Typical rows: raw strings for closed sets, validation inside business logic, client-side validation, type-first folders, hand-written clients, missing OpenAPI, models shared across API and DB, untested constructors, missing metrics.
7. **Client contracts.** For every API a client consumes, record whether an OpenAPI document exists and whether the client is generated. Missing OpenAPI is the first gap to close, because typed clients and backend-only validation depend on it.
8. **Second PE review** of the gap analysis (design-review report). Gaps that need a product decision are named in the output for the user to decide, or to take to `/brain-pm`.

### Pass 3: change it (PM, EMs, staff)

9. **Roadmap** as PRDs per service or area (`prd-writing`): the outcome is "service conforms to conventions X, Y, Z with behavior unchanged", acceptance criteria are the gap rows closed and the baseline verification still green.
10. **Order the work**: (a) OpenAPI for every API and generated clients, (b) domain typing per API (typed ids, sum types, validation moved to the edges), one endpoint or feature at a time, (c) feature-first folder moves once types are in place, (d) metrics and logging, (e) remaining gaps. Foundation task first per service: shared types package and the generated-client pipeline.
11. **Milestones and sprints** as usual (`milestone-planning`); every task is a small PR with a characterization test written first (`test-driven-development`) that pins current behavior, then the refactor, then the same test green.
12. **Track**: each closed gap row is a status update on its ticket; `CURRENT_MILESTONE.md` shows the conformance count per service.

## Adoption record

```markdown
## Adoption: <service> — EM <agent_id> — PM <agent_id>
- Baseline verification: `<commands>` → green at <commit>
- As-is docs: HLD.md, LLD.md, schema.ddb, hld.drawio → DONE | PARTIAL (UNKNOWNs: <n>)
- Gap analysis: <n> gaps (T3: <n>, T2: <n>, T1: <n>) → reviewed by <pe agent_id>
- Roadmap PRD: <link> · Milestones: <list>
- Conformance: <closed>/<total> gaps
```

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "We know the code, skip the as-is docs." | The next agent does not. Undocumented code cannot be refactored safely or reviewed against a design. |
| "Refactor everything in one branch." | The product must stay runnable. One API or feature per PR, characterization test first. |
| "The old client works, generating one is churn." | Hand-written clients are where invalid requests come from. Generation is the foundation task. |
| "Fix the folder layout first, it's mechanical." | Moving untyped code gives typed-looking folders with the same bugs. Types first, then moves. |
| "Guess what that module does." | Write `UNKNOWN` and a ticket. A guessed HLD is worse than none. |

## Red Flags

- A service in code with no EM or no `services/<name>/` folder.
- A refactor PR without a characterization test.
- An as-is HLD that describes the desired design instead of the current one.
- A gap closed without its row referenced in a status update.
- Baseline verification red after a refactor merge.

## Verification

- [ ] Every service has an EM, a tracker project, service docs, and a recorded baseline verification.
- [ ] As-is HLD, LLD, and schema exist per service and overall, with unknowns marked, and a second PE reviewed the gap analysis.
- [ ] OpenAPI exists for every consumed API and clients are generated before domain-typing refactors start.
- [ ] Every refactor task has a characterization test and the baseline stays green.
- [ ] Conformance counts are current in each `CURRENT_MILESTONE.md`.
