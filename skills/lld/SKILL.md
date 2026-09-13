---
name: lld
description: Turns an approved HLD section into a low-level design for one service or module: folder structure, types and interfaces as code, data model and migrations, API contracts, state machines, error handling, and testing strategy. Use when a principal engineer needs to pin cross-service contracts in detail, or when a foundation staff engineer or EM designs a service's internals before implementation.
category: design
---

# Low-Level Design

## Overview

The LLD is what an engineer implements from without asking questions. At the cross-service level the PE writes only what other services depend on; inside a service the EM and the foundation staff engineer write the rest. The LLD lives in the service `LLD.md` and stays in sync with the code.

## When to Use

- After HLD approval, before the foundation task of a milestone.
- When a contract, schema, or state machine changes.
- NOT before the HLD is approved.
- NOT as a substitute for reading existing code: the LLD extends what is there.

## Process

1. **Read** the approved HLD section, the domain model, the service `CONVENTIONS.md` (global first), and the existing code the module touches.
2. **Folder structure**: list the files an engineer will create, feature-first (`<feature>/{api,application,domain,persistence,tests}`) per the global `CONVENTIONS.md`.
3. **Types and interfaces as code**: enums, discriminated unions, DTOs, entities, error types, ports. Use the language of the service. If a concept cannot be expressed in the type system, say why.
4. **Data model**: tables, columns, types, constraints, indexes; migration steps and rollback.
5. **API contracts**: every endpoint or message with method, path, auth, request, response, errors, idempotency.
6. **State machines** where lifecycle exists: states, transitions, guards, side effects, terminal states.
7. **Error handling and resilience**: classification, retries, timeouts, idempotency keys.
8. **Testing strategy**: what is unit, contract, integration, end-to-end; which fakes exist.
8b. **Observability**: the technical metrics each endpoint, job, and external call emits, and the log points at boundaries and state transitions; reference the product and business metrics the PRD names so the implementer emits all three.
9. **Classes and interfaces**: list the interfaces, implementations, ports and adapters, repositories, services or use cases, and handlers the module needs, with dependency direction.
10. **Patterns**: name each pattern used and the problem it solves; keep the implementation consistent with the name. Catalog: Strategy, Adapter, Repository, Unit of Work, State Machine, Builder, Factory/Registry, Policy, Command/Handler, Observer/Event. Never add a pattern to look sophisticated.
11. **Write** the sections into the service `LLD.md`; link from the tasks that implement them. Open questions go through the the coordinator skill.

## Principles every LLD applies

1. **Make illegal states unrepresentable**: sum types for states and variants, product types for required-together data, enums for closed sets, typed identifiers (UUID wrappers) for every entity. No raw strings for anything closed.
2. **Validate at the edges**: when receiving data from the API, the database, an event store, or an external provider. Business logic has zero to minimal defense.
3. **If a defensive check is unavoidable**, make that illegal state a first-class domain object (for example `ExpiredToken`, `OverdrawnAccount`) so the error is explicit and typed, not an implicit branch.
4. **Strong typing follows the domain model**: the types in code are the glossary from the HLD.
5. **OpenAPI first, generated clients**: the contract is the OpenAPI document; clients (`packages/api-client`) are generated, never hand-written. JSON is typed at every boundary.
6. **Separate API, domain/application, and DB models** so each layer evolves independently; translate explicitly.
7. **Low cyclomatic complexity**: small functions, early returns, exhaustive `switch` over sum types, lookup tables or polymorphism instead of nested conditionals. A function that needs a comment to follow its branches is too complex.
8. **Comments explain the why, rarely.** Product or business reasoning only; the what must be self-explanatory. If the reasoning lives in a ticket, put it there and link the ticket id in the code.
9. **Testable by construction**: inject dependencies (never construct concrete dependencies inline); route `random()`, `time.now()`, and environment reads through injected providers so tests control them.
10. **Composition over inheritance**: interfaces and small composed units instead of class hierarchies.
11. **Deliberate domain models**: typed UUID wrappers per entity, sum types for lifecycle states, product types for aggregates, invariants enforced in constructors.
12. **Diagrams as code**: the DB schema as a drawdb file next to `LLD.md`; sequences as Mermaid.

## Section checklist

| Section | Required when |
|---|---|
| Folder structure | always |
| Types and interfaces | always |
| Data model and migrations | persistence changes |
| API contracts | any external or cross-service surface |
| State machines | any entity with lifecycle |
| Error handling | always |
| Testing strategy | always |
| Classes and interfaces (ports, adapters, repositories, use cases, handlers) | always |
| Patterns and rationale | any pattern used |
| Sequence diagram (Mermaid) | every critical path |
| DB schema as drawdb file | persistence changes |
| Generated client update (OpenAPI) | any contract change |
| Observability: technical metrics (rate, errors, duration, saturation) and log points per boundary and state transition | always; dashboards and alerts only when in scope |

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "Types will emerge from the code." | Then every engineer invents their own. Types first is how parallel work stays consistent. |
| "A quick null check here is harmless." | Defense in business logic hides an illegal state. Make it unrepresentable or make it a domain object. |
| "I'll write the client by hand, it's small." | Hand-written clients drift from the contract. Generate it. |
| "We can add the migration rollback later." | A migration without rollback is a one-way door nobody approved. |
| "The error cases are obvious." | Unlisted error cases become unhandled error cases. |
| "The LLD is done once written." | An LLD that drifts from code is worse than none. Update it in the task that changes the code. |

## Red Flags

- A type described as "an object with the relevant fields".
- A raw string where an enum or typed id belongs; a hand-written API client; `time.now()` or `random()` called directly in domain code.
- A type-first folder layout (`controllers/`, `models/`) for new code.
- An endpoint without an error model.
- A pattern used without a stated problem.
- `LLD.md` not touched by a task that changed a contract or schema.

## Verification

- [ ] Every section in the checklist that applies is filled with code-level detail.
- [ ] Every task implementing this module links to its LLD section.
- [ ] Contracts match the HLD's key interfaces exactly (names, enums, endpoints).
- [ ] Migrations have rollback steps.
