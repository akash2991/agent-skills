# Documentation map

Which document holds what, who owns it, and what overrides what.

Scope is what decides ownership. The product manager and the principal engineers are **project-wide**, so they own the two pages that describe the whole product. Engineering managers and staff engineers are scoped to **one service**, so the service's own documents belong to the people working in it.

| Document | Holds | Owner | Altitude |
|---|---|---|---|
| `{{ORG_DIR}}/docs/PRD.md` | what the product is, who it is for, the capabilities it must have, what it is deliberately not | product manager | really high level; feature detail lives in the ticket |
| `{{ORG_DIR}}/docs/ARCHITECTURE.md` | the services, what each is for, the contracts between them, where a change belongs | principal engineers | really high level; no service internals |
| `{{ORG_DIR}}/docs/CONVENTIONS.md` | the stack and the rules every service follows | the user, with the principal engineers | non-overridable and overridable sections |
| `{{ORG_DIR}}/docs/DECISIONS.md` | decisions that apply across services | whoever made the decision | append only |
| `{{ORG_DIR}}/docs/CHANGELOG.md` | what shipped, by release | whoever released | append only |
| `{{ORG_DIR}}/services/<s>/HLD.md` | that service's modules, its contracts, its data model | its staff engineers | high level; the code is the detail |
| `{{ORG_DIR}}/services/<s>/LLD.md` | that service's types, schema, and internal design | its staff engineers | high level; the code is the detail |
| `{{ORG_DIR}}/services/<s>/CONVENTIONS.md` | what this service does differently, and why | its engineering manager | overrides only what the global file marks overridable |
| `{{ORG_DIR}}/services/<s>/CURRENT_MILESTONE.md` | what is in flight in this service | its engineering manager | |
| `{{ORG_DIR}}/services/<s>/DECISIONS.md`, `CHANGELOG.md`, `RCA.md` | service-scoped decisions, changes, and incident write-ups | its engineering manager | append only |

Service documents are created from `{{ORG_DIR}}/service-docs-template/`.

Two rules keep these honest:

1. **A document is updated in the pull request that makes it wrong.** A service `HLD.md` describing modules that no longer exist is worse than no document, because the next person believes it. The engineering manager checks this before merging rather than writing it afterwards.
2. **One altitude per document.** When a project page starts describing how one service works, that text belongs in the service's own page. When a service page starts describing the whole system, it belongs in `ARCHITECTURE.md`. Both mistakes end the same way: nobody reads either.

Bugs are not a file. They are tracker tickets labelled `bug`, so anyone can query them.

Precedence: a service `CONVENTIONS.md` may override an entry only if it appears under **Overridable** in the global file, and must record the override with a reason. Non-overridable entries always win. An agent working in a service reads the global document, then the service one.
