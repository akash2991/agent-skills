# Issue

The body of every issue, using the scope and readiness decisions from `planning-and-task-breakdown`. Fill applicable fields and explain omissions. Estimate and cycle below mirror the native Linear fields; they do not replace them.

```markdown
User prompt (verbatim, when direct): "<...>"
Outcome: <one observable deliverable that is true when done>
Out of scope: <explicit exclusions>
Readiness: actionable | provisional (blocked on design issue <id>)
Estimate: <value and team scale; set native field, or unestimated while provisional>
Cycle: <native cycle id when committed; none while provisional>
Story: <the PRD story this delivers, or n/a>
Acceptance criteria:
- [ ] <criterion>
Scope class: MVP | MVP blocker | later
Success target: <from the PRD, when it delivers a story>
Verification surface: <test, benchmark, command output, artifact, or source that proves it>
Constraints: <what must not regress>
Boundaries: <files, tools, data, repositories the agent may use>
Owned paths: <disjoint from every in-flight issue>
Iteration policy: <how to decide what to try next after each attempt>
Blocked stop condition: <when to stop and report that no defensible path remains>
Workflow states skipped / overrides: <state: reason, or none>
Persona: <who works it>
Blocked by: <issue ids>
Design: <reviewed HLD/LLD section and review evidence; for a design issue, required inputs and artifact to produce; for nontechnical work, why not applicable>
PR: <url once raised>
```
