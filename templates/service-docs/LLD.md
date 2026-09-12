# <service> Low-Level Design

Owned by the EM; foundation sections written by the dedicated foundation staff engineer; module sections by their implementers. Keep in sync with the code: the task that changes a contract, schema, or type updates this file in the same PR. Sections follow the `lld` skill and apply its principles: illegal states unrepresentable, validation at the edges only, typed ids and enums, injected dependencies and clocks, composition over inheritance, feature-first layout, comments only for the why with the ticket linked.

- Cross-service HLD: <link> · Service HLD: `HLD.md`
- Diagrams: `schema.ddb` (drawdb), Mermaid sequences below
- OpenAPI: `<path>` → generated client `packages/api-client/<service>`

## Folder structure (feature-first)

```text
<service>/
├── shared/
└── <feature>/
    ├── api/
    ├── application/
    ├── domain/
    ├── persistence/
    └── tests/
```

## Types and interfaces

<enums, sum types, product types, typed ids, DTOs, error types, ports, as code>

## Classes and interfaces

| Interface / class | Kind (port, adapter, repository, use case, handler) | Depends on | Injected |
|---|---|---|---|

## Data model and migrations

- drawdb file: `schema.ddb`

| Table | Owner | Migration | Rollback |
|---|---|---|---|

## API contracts

| Method | Path | Auth | Request | Response | Errors | Idempotency |
|---|---|---|---|---|---|---|

## State machines

| Entity | States (sum type) | Transition | Guard | Side effect |
|---|---|---|---|---|

## Sequence diagrams (critical paths)

```mermaid
sequenceDiagram
```

## Error handling and resilience

## Observability

- Technical metrics (rate, errors, duration, saturation) per endpoint, job, and external call:
- Product and business metrics from the PRD this service emits:
- Log points (boundaries and state transitions only):

## Testing strategy

| Level | What | Fakes / providers injected |
|---|---|---|

## Patterns and rationale

| Pattern | Where | Problem it solves |
|---|---|---|

## Module details

### <feature or module>

## Open questions
