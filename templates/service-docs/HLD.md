# <service> High-Level Design

Owned by the EM. The cross-service HLD from the principal engineer is the source of truth; this file is the service's view of it. Sections follow the `hld` skill; a section that does not apply says so in one line rather than being deleted. Diagrams are code: `hld.drawio` for architecture, Mermaid for flows, both committed next to this file.

- Cross-service HLD: <link>
- Diagrams: `hld.drawio`, Mermaid blocks below
- Status: DRAFT | APPROVED · Approved by: <pe agent_id> on <date>

## Goals

## Non-goals

## Assumptions

## Constraints

## Purpose, responsibilities, and non-responsibilities

## Context and boundaries

- Upstream services and contracts consumed:
- Downstream services and contracts provided:

| Module / feature | Responsibility | Non-responsibilities | Owner |
|---|---|---|---|

## Domain model and glossary (service view)

| Term | Definition | Type (entity / value / sum type) | Typed id |
|---|---|---|---|

## API interfaces

| Interface | Direction | OpenAPI / schema | Owner |
|---|---|---|---|

## Interactions

```mermaid
sequenceDiagram
```

## Tradeoffs and alternatives considered

| Decision | Options | Choice | Why | Reversible |
|---|---|---|---|---|

## Dependencies and infra

- External services:
- Packages:
- Terraform resources:
- CI/CD needs:

## SLOs

| Path | Availability | Latency (p95) | Correctness |
|---|---|---|---|

## Observability (high level)

- Metrics: <technical / product / business>
- Logs: <boundaries and transitions>
- Alerts: <what pages, what warns>

## Light LLD (optional per subsection; detail lives in `LLD.md`)

### Important classes, interfaces, and interactions

### DB schema

- drawdb file: `schema.ddb`

### API contracts

## Left to staff engineers

- <internal choice> — <why it is theirs>

## One-way doors

## Open questions
