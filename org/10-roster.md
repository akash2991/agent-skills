## Who you can invoke

One command per role. There is no entry point and no order you must follow: invoke whichever role the work needs, and skip the rest. Each asks for the inputs it needs and returns a structured result.

| Command | Role | Scope | Give it | Get back |
|---|---|---|---|---|
| `/brain-pm` | Product manager | project-wide | a feature request in your words, or a ticket id | a ticket, then whichever of refine, interview, spec, or PRD you choose |
| `/brain-pe-backend` · `/brain-pe-web` · `/brain-pe-mobile` | Principal engineer | project-wide | a PRD | a design: domain model, interfaces, implementation plan |
| `/brain-em` | Engineering manager | one service | an approved design, or a service | milestones, sprints, tickets, service docs |
| `/brain-swe-backend` · `/brain-swe-web` · `/brain-swe-mobile` | Staff engineer | one service | one ticket, a story or a bug | the change, its tests, and a pull request |
| `/brain-review-backend` · `/brain-review-web` · `/brain-review-mobile` | Code reviewer | one change | a pull request | review comments and an approve or reject |
| `/brain-qa` | Test engineer | one story | a story reported done | QA VERIFIED, QA FAILED, or QA BLOCKED |
| `/brain-security` | Security auditor | one change or surface | a change or surface | findings by severity, with mitigations |
| `/brain-webperf` | Web performance auditor | one surface | a route, component, or URL | measured findings, never invented numbers |

Engineers and reviewers are split by discipline: backend, web (React), and mobile (React Native). An engineering manager is not split; one owns a service across all three.

**Firstmate runs the crew.** Each role runs as its own session, dispatched by firstmate into its own pane with the harness, model, and thinking effort chosen for that task. A role never picks its own model and never spawns another role.

**Scope decides who owns which document.** The product manager and the principal engineers see the whole product, so they own the two project pages: `{{ORG_DIR}}/docs/PRD.md` and `{{ORG_DIR}}/docs/ARCHITECTURE.md`, both kept really high level. Engineering managers and staff engineers work inside one service, so the service's `HLD.md` and `LLD.md` belong to its staff engineers, updated in the pull request that changes them. The full table is in `{{ORG_DIR}}/references/documentation-map.md`.

Every role is a persona, installed as a skill in your tool's skills directory (see "Where things live"). Read yours before acting, and use only the skills it lists.
