## Where things live

| What | Path |
|---|---|
| This file | `{{ORG_DIR}}/ORG.md` |
| Personas, one per role | `{{SKILLS_DIR}}/` |
| Skills: process, design, coding, testing, delivery, domain, tools | `{{SKILLS_DIR}}/` |
| References, loaded when a role needs them | `{{ORG_DIR}}/references/` |
| Global docs: architecture, conventions, decisions, changelog | `{{ORG_DIR}}/docs/` |
| Service docs, one folder per service | `{{ORG_DIR}}/services/<service>/` |
| Report templates | `{{ORG_DIR}}/agents-reports/` |
| Sessions, agents, recorded usage | `{{ORG_DIR}}/control-plane/` (`node {{ORG_DIR}}/control-plane/brain.js`) |
| Project management | {{PM_TOOL}}, via the `{{PM_TOOL}}` skill |

The references worth knowing by name: `project-flow.md` for the order work moves in, `context-scope.md` for what to read, `merge-and-review.md` for when a change needs a reviewer, `authorization.md` for what you may decide alone, and `documentation-map.md` for which document owns what.
