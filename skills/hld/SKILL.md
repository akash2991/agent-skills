---
name: hld
description: "Produces a unified high-level design across services from a PRD: goals and non-goals, API interfaces, domain models and glossary, service boundaries and interactions, tradeoffs, assumptions, constraints, alternatives, dependencies and infra, SLOs, high-level observability, diagrams as code, a light LLD (key classes, DB schema, contracts), and explicit callouts of what is left to staff engineers. Use when a principal engineer receives an approved PRD and before any milestone planning or implementation."
category: design
---

# High-Level Design

## Overview

There are two altitudes and they have different owners. A principal engineer writes the **project** architecture in `{{ORG_DIR}}/docs/ARCHITECTURE.md`: which services exist, what each is for, the contracts between them, and where a change belongs. A staff engineer writes its **service** `HLD.md`: the modules inside one service, the contracts it exposes, and its data model. This skill serves both; keep to the altitude of the document you are writing.

An HLD makes parallel work possible without rework. It fixes boundaries, ownership, and contracts; it deliberately does not fix internals, because the code is the detail.

## When to Use

- A PRD is approved and touches more than one module or service, or introduces a new one.
- A cross-service contract must change.
- NOT for a single-service change with existing contracts; the EM updates the service `HLD.md` directly.
- NOT for internals: folder layout, private classes, and implementation patterns belong to the `lld` skill at service level.

## Process

1. **Read** the PRD fully, every affected service's `HLD.md`, `CONVENTIONS.md` (global then service), and global `DECISIONS.md`. List every entity, actor, flow, and metric the PRD implies.
2. **State goals, non-goals, assumptions, and constraints** first; they bound every later choice.
3. **Draw the system context and service boundaries**: which services exist, which change, whether a new service is justified or where a feature sits. Every responsibility has exactly one owner. A new service needs a recorded decision.
4. **Define the domain model and glossary** with the `domain-modeling` skill: entities, value objects, identifiers, states as sum types, invariants. One vocabulary across services.
5. **Define the API interfaces** between boundaries as OpenAPI contracts and shared types, not prose: method, path, auth, request, response, errors, ownership. Consumers will be generated from them.
6. **Describe interactions between services** for the critical paths as Mermaid sequence diagrams, showing which service decides what. Backend owns business truth; clients render it.
7. **Record tradeoffs and alternatives considered**: for each material choice, the options, the choice, the rationale, and reversibility. Name one-way doors.
8. **List dependencies and infra**: external services, packages, Terraform resources, CI/CD needs, data migrations.
9. **Set SLOs** for the feature's critical paths (availability, latency, correctness) at the level the PRD justifies.
10. **Sketch observability at high level**: which metrics (technical, product, business), which log points, which alerts, per `../../references/metrics-and-logging.md`. Detail belongs in the LLD.
11. **Write the light LLD where it unblocks parallel work**: important classes, their interfaces and interactions; the DB schema as a drawdb file; the API contracts. Keep it high level; skip sections you deem unnecessary and say so.
12. **Call out what is left to staff engineers**: the internals, choices, and open questions you deliberately did not decide, so the foundation engineer knows where their judgement starts.
13. **Diagrams as code**: architecture as a `.drawio` file next to the HLD, flows and sequences as Mermaid in the Markdown, schema as drawdb. Commit them; they are reviewed like code.
14. **Hand off**: write the HLD to `{{ORG_DIR}}/docs/` (cross-service) and link each service's section from its `HLD.md`; produce the implementation plan with the `planning-and-task-breakdown` skill; report with the PE design report template; request review by a different PE.

## HLD template

Sections marked *optional* may be omitted with a one-line reason.

```markdown
# HLD: <feature>
- Author: <pe agent_id> · PRD: <link> · Status: DRAFT | APPROVED · Reviewer: · Diagrams: `<name>.drawio`, drawdb `<name>.ddb`

## Goals
## Non-goals
## Assumptions
## Constraints
## System context and service boundaries
| Service / module | Responsibility | Non-responsibilities | Owner (EM) | New? |
## Domain model and glossary
| Term | Definition | Type (entity / value / sum type) | Owner |
## API interfaces
### <service A> → <service B>  (OpenAPI: `<path>`)
## Interactions between services
```mermaid
sequenceDiagram
```
## Tradeoffs and alternatives considered
| Decision | Options | Choice | Why | Reversible |
## Dependencies and infra
## SLOs
| Path | Availability | Latency (p95) | Correctness |
## Observability (high level)
- Metrics: <technical / product / business>
- Logs: <boundaries and transitions>
- Alerts: <what pages, what warns>
## Light LLD *(optional per subsection)*
### Important classes, interfaces, and interactions
### DB schema (drawdb)
### API contracts
## Left to staff engineers
- <internal choice> — <why it is theirs>
## One-way doors
## Open questions
```

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "I'll specify the internals too, to be safe." | That removes the service owners' judgement and makes the HLD stale on day one. Put it under "Left to staff engineers" instead. |
| "Diagrams can be drawn later in a tool." | Diagrams are code: Mermaid, draw.io, drawdb files in the repo, reviewed with the HLD. |
| "SLOs and observability are operational, not design." | They shape the design (timeouts, idempotency, what to measure). State them at high level now. |
| "The interface can be defined during implementation." | Then two services implement two different interfaces. Contracts come first. |
| "We may need to scale, so design for it now." | Design for the PRD's stated scale. Record scale as a later concern. |
| "The design is obvious, skip the review." | The second PE catches the boundary you did not see. It is a rule, not a preference. |

## Red Flags

- A responsibility with two owners or none.
- An interface described only in prose.
- Internals of a service specified beyond its contracts and domain model.
- No one-way doors section, no non-goals, or no "Left to staff engineers" section.
- A diagram that exists only as an image, not as a committed Mermaid, draw.io, or drawdb source.
- An HLD approved by its author.

## Verification

- [ ] Every PRD story maps to boundaries and interfaces in the HLD.
- [ ] Every interface is expressed as OpenAPI or shared types and has an owner.
- [ ] Goals, non-goals, assumptions, constraints, tradeoffs, alternatives, dependencies, SLOs, and high-level observability are present or explicitly skipped with a reason.
- [ ] Diagrams are committed as code next to the HLD.
- [ ] Decisions and one-way doors are recorded in the HLD and global `DECISIONS.md`.
- [ ] A different PE has returned `APPROVED` in a design review.
- [ ] The implementation plan exists and references HLD sections.
