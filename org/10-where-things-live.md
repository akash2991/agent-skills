## Where things live

| What | Path |
|---|---|
| This file, templates, references | `{{ORG_DIR}}/` |
| Persona definitions (role, responsibilities, authorization, skills) | {{AGENTS_NOTE}} |
| Skills (process, design, coding, testing, delivery, domain, tools) | `{{SKILLS_DIR}}/` |
| Control plane: sessions, agent registry, events, budgets, audit | `{{ORG_DIR}}/control-plane/` (SQLite; `node {{ORG_DIR}}/control-plane/brain.js`) |
| Session entry command | `/brain` in this harness; claims your role and loads the organization |
| Live view | `node {{ORG_DIR}}/control-plane/brain.js status`, or the UI at `brain.js serve` |
| Global docs (conventions, decisions, changelog) | `{{ORG_DIR}}/docs/` |
| Service docs (one folder per service, owned by its EM) | `{{ORG_DIR}}/services/<service>/` |
| Uniform report templates | `{{ORG_DIR}}/agents-reports/` |
| Project management | {{PM_TOOL}} via the `{{PM_TOOL}}` skill; interface in `{{ORG_DIR}}/references/project-management-interface.md` |

State that changes while agents work lives in the control plane, not in markdown. Documents that humans read and review stay as markdown: this file, `CONVENTIONS.md`, `DECISIONS.md`, and each service's `HLD.md` and `LLD.md`.
