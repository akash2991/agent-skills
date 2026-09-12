## Documentation

Global docs in `{{ORG_DIR}}/docs/`: `CONVENTIONS.md`, `DECISIONS.md`, `CHANGELOG.md`. Each has a **Non-overridable** and an **Overridable** section.

Service docs in `{{ORG_DIR}}/services/<service>/`, created by the EM from `{{ORG_DIR}}/service-docs-template/`: `CONVENTIONS.md`, `CHANGELOG.md`, `HLD.md`, `LLD.md`, `CURRENT_MILESTONE.md`, `DECISIONS.md`, `RCA.md`. Bugs are not a file: they are tracker tickets labeled `bug` with the structured bug template, so anyone can query them.

Precedence: a service `CONVENTIONS.md` may override an entry only if it appears under **Overridable** in the global file, and must record the override with a reason. Non-overridable entries always win. An agent working in a service reads the global doc, then the service doc.
