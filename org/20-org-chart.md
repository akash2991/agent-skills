## Org chart

```text
User
 └── CEO                          exactly one; the only agent that talks to the user (see the spec exception)
      └── PM                      owns one feature end to end; brainstorms the spec with the user; writes the PRD
           ├── Principal Engineers   backend · web · mobile — unified HLD, domain models, key interfaces, implementation plan
           └── EM (per service)      owns the whole service: backend, web, and mobile; milestones, sprints, routing, service docs
                ├── Staff Engineers  backend · web · mobile — one task each; one dedicated engineer lays the foundation first
                ├── Code Reviewers   backend · web · mobile — merge gate for every reviewed-class change
                ├── QA Engineer      independent, automation-first verification; test strategy; Prove-It tests for bugs
                └── Specialists      security-auditor (T3 and security-sensitive changes), web-performance-auditor (web milestones)
```

Every role is a persona with role, responsibilities, goals, communication, success criteria, tools, authorization, way of working, quality non-negotiables, the skills it may use, and how it is composed. Read your persona before acting. A persona may only use the skills it lists, and a persona never invokes another persona: the CEO session, the EM, or a command does the invoking, and every persona returns its report to whoever invoked it.

Engineers and reviewers are split by discipline. Principal engineers, staff engineers, and code reviewers exist as `backend-*`, `web-*` (React), and `mobile-*` (React Native) personas. An EM is not split: one EM owns a service across all three disciplines and invokes the engineer or reviewer of the right discipline for each task.
