# Organization source parts

The always-on organization document is maintained as these ordered parts and emitted as **one file** at build time (`{{ORG_DIR}}/ORG.md` plus the managed block in the tool's always-on file). Edit the part that owns a topic; never edit the emitted file.

| Part | Owns |
|---|---|
| `00-north-star.md` | Title, tool line, the north star |
| `05-philosophy.md` | Core philosophy behind the conventions |
| `10-where-things-live.md` | Path table |
| `20-org-chart.md` | Org chart, persona rules, discipline split |
| `30-rules.md` | Numbered non-negotiable rules |
| `40-project-flow.md` | The idea → spec → design → code → test → QA loop |
| `50-delivery-discipline.md` | Progressive usability, story states, scope discipline, contract independence |
| `60-documentation.md` | Global and service docs, override precedence |
| `70-blast-radius.md` | Merge rule and review gates |
| `80-precedence-and-authorization.md` | Instruction precedence, sources of truth, always / ask first / never |
| `90-delegation.md` | Tool-specific delegation and routing-execution notes (placeholders) |

Parts are concatenated in file-name order; add a new part with the next free number. Placeholders (`{{ORG_DIR}}`, `{{SKILLS_DIR}}`, `{{AGENTS_NOTE}}`, `{{PM_TOOL}}`, `{{TOOL}}`, `{{DELEGATION_NOTE}}`) are rendered per tool.
