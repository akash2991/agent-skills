# Architecture

The highest-level map of this product. One page, kept short on purpose.

Its job is to let anyone, in any role, understand **what exists, what each part is for, and where a change belongs**, without reading code. The CEO and the PM should be able to plan from this page alone. Engineers start here and then go to the service documents for anything deeper.

Owned by the principal engineers, kept current by the EM of each service for its own row. Updated when a service is added, removed, renamed, or changes responsibility, and at every milestone close.

## What this product is

<Two or three sentences. What a user can do with it, and for whom. No technology.>

## Services

One row per service. If a row needs a paragraph, the paragraph belongs in that service's own documents, not here.

| Service | Responsible for | Not responsible for | Owner (EM) | Docs |
|---|---|---|---|---|
| `<name>` | <the one thing it owns> | <the nearest thing people assume it owns> | <em> | `{{ORG_DIR}}/services/<name>/` |

## How they fit together

```mermaid
flowchart LR
  user([User]) --> web[Web]
  web --> api[API service]
  api --> db[(Store)]
```

<Keep the diagram to services and the direction of dependence. No classes, no functions, no folder layout.>

## Surfaces

| Surface | Who uses it | Built with | Owner |
|---|---|---|---|
| Web | | | |
| Mobile | | | |
| Public API | | | |

## Where a change belongs

The routing table a PM or CEO uses to name an owner without asking an engineer.

| If the change is about... | It belongs to |
|---|---|
| <user-visible behaviour on the web> | <service> |
| <business rule or pricing> | <service> |
| <who can see what> | <service> |

## Cross-cutting decisions

Only the ones that change how a feature is planned. The full list lives in `DECISIONS.md`.

| Decision | Consequence for planning | Where it is recorded |
|---|---|---|
| <e.g. one shared identity service> | <every feature touching login needs that team> | `DECISIONS.md#D-n` |

## What is deliberately not here

Folder structure, class and function design, coding conventions, test strategy, schema detail, and API contracts. Those live in each service's `LLD.md` and in `CONVENTIONS.md`, and putting them here would make this page something nobody reads.
