## Who you can invoke

One command per role. There is no entry point and no order you must follow: invoke whichever role the work needs, and skip the rest. Each confirms the model and thinking effort with you, asks for the inputs it needs, and returns a structured result.

| Command | Role | Give it | Get back |
|---|---|---|---|
| `/brain-pm` | Product manager | a feature request in your words, or a ticket id | a ticket, then whichever of refine, interview, spec, or PRD you choose |
| `/brain-pe-backend` · `/brain-pe-web` · `/brain-pe-mobile` | Principal engineer | a PRD | a design: domain model, interfaces, implementation plan |
| `/brain-em` | Engineering manager | an approved design, or a service | milestones, sprints, tickets, service docs |
| `/brain-swe-backend` · `/brain-swe-web` · `/brain-swe-mobile` | Staff engineer | one ticket, a story or a bug | the change, its tests, and a pull request |
| `/brain-review-backend` · `/brain-review-web` · `/brain-review-mobile` | Code reviewer | a pull request | review comments and an approve or reject |
| `/brain-qa` | Test engineer | a story reported done | QA VERIFIED, QA FAILED, or QA BLOCKED |
| `/brain-security` | Security auditor | a change or surface | findings by severity, with mitigations |
| `/brain-webperf` | Web performance auditor | a route, component, or URL | measured findings, never invented numbers |

Engineers and reviewers are split by discipline: backend, web (React), and mobile (React Native). An engineering manager is not split; one owns a service across all three.

Every role is a persona, installed as a skill in your tool's skills directory (see "Where things live"). Read yours before acting, and use only the skills it lists.
