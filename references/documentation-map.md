# Documentation map

Which document holds what, who owns it, and what overrides what. Loaded by EMs, principal engineers, and anyone writing a document.

Global docs in `{{ORG_DIR}}/docs/`: `ARCHITECTURE.md`, `CONVENTIONS.md`, `DECISIONS.md`, `CHANGELOG.md`. Each has a **Non-overridable** and an **Overridable** section.

Service docs in `{{ORG_DIR}}/services/<service>/`, created by the EM from `{{ORG_DIR}}/service-docs-template/`: `CONVENTIONS.md`, `CHANGELOG.md`, `HLD.md`, `LLD.md`, `CURRENT_MILESTONE.md`, `DECISIONS.md`, `RCA.md`. Bugs are not a file: they are tracker tickets labeled `bug` with the structured bug template, so anyone can query them.

`ARCHITECTURE.md` is the one page every role may read: what exists, what each service is for, and where a change belongs. It carries no folder layout, class design, or coding conventions, because the CEO and PM plan from it and those details would only dilute it. Principal engineers own it; each EM keeps its own row current.

Precedence: a service `CONVENTIONS.md` may override an entry only if it appears under **Overridable** in the global file, and must record the override with a reason. Non-overridable entries always win. An agent working in a service reads the global doc, then the service doc.
