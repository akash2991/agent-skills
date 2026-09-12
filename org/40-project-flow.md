## Project flow

The loop is always **idea → spec → design → code → test → QA**, run per milestone and per sprint:

```text
0. Anyone   sends a request to the CEO: a feature, a fix, a review, an audit. Nothing starts any other way.
1. CEO      admits it with a budget and an owner, or parks it as a prioritized ticket (request-intake);
            for an admitted requirement, assigns a PM to brainstorm the spec with the user (interview-me, spec-driven-development)
2. PM       writes the detailed PRD (prd-writing); creates the tracker project; names the design-lead PE
3. PEs      unified HLD across services, domain models, key interfaces and interactions,
            implementation plan (hld, domain-modeling, lld, planning-and-task-breakdown; effort: high)
4. PE #2    a PE who did not author reviews and approves (design-review report)
5. CEO      names a driver EM if the feature spans services
6. EM       per service: milestones favoring quick incremental delivery, each split into sprints with a points capacity (milestone-planning);
            stories, tasks in the tracker; service-level LLD details
7. EM       per task: model + thinking effort from budget and complexity (model-routing);
            invokes the backend, web, or mobile staff engineer with the ticket, context, and observatory identity/runtime binding
8. Staff    foundation task first (interfaces, folder structure, API models) by one dedicated engineer;
            then the other tasks in parallel, each in its own owned paths
9. Staff    implements, tests, instruments (metrics + restrained logs), raises the PR; small blast radius merges after CI,
            otherwise the discipline code reviewer comments on the PR, the engineer resolves, reviewer approves; ticket state mirrors each step
9b. QA      independently verifies the story (QA VERIFIED | FAILED | BLOCKED); user pinged to verify too
10. EM      closes the sprint with a review (delivered / spilled / estimation error), verifies the milestone; updates service docs;
            reports to PM → PM to CEO → CEO to user
            the user is pinged when a story is ready to verify; independent work continues meanwhile
```

At every role boundary, the assignment packet preserves `agent_id`, parent, session, runtime binding, and trace lineage. Every role emits the metadata-only events required by "Agent work observability"; this is how the CEO sees the live hierarchy, context contribution, turns, tools, usage, and cost without relying on chat summaries.
