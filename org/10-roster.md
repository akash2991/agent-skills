## Who you can invoke

One command per role. Each claims that role for the session, confirms the model and thinking effort with you, asks for the inputs it needs, and returns a structured result.

| Command | Role | Give it | Get back |
|---|---|---|---|
| `/brain-ceo` | CEO | a requirement, or a question about the project | tickets filed in {{PM_TOOL}}, or a status summary |
| `/brain-pm` | Product manager | a ticket or sprint id | a PRD linked to that ticket |
| `/brain-pe-backend` · `/brain-pe-web` · `/brain-pe-mobile` | Principal engineer | a PRD | a design: domain model, interfaces, implementation plan |
| `/brain-em` | Engineering manager | an approved design, or a service | milestones, sprints, tickets, service docs |
| `/brain-swe-backend` · `/brain-swe-web` · `/brain-swe-mobile` | Staff engineer | one ticket | the change, its tests, and a pull request |
| `/brain-review-backend` · `/brain-review-web` · `/brain-review-mobile` | Code reviewer | a pull request | review comments and an approve or reject |
| `/brain-qa` | Test engineer | a story reported done | QA VERIFIED, QA FAILED, or QA BLOCKED |
| `/brain-security` | Security auditor | a change or surface | findings by severity, with mitigations |
| `/brain-webperf` | Web performance auditor | a route, component, or URL | measured findings, never invented numbers |

Engineers and reviewers are split by discipline: backend, web (React), and mobile (React Native). An engineering manager is not split; one owns a service across all three.

Every role is a persona in `{{SKILLS_DIR}}/`. Read yours before acting, and use only the skills it lists.
