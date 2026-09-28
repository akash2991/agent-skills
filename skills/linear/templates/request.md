# Request

The intake issue: the user's words before classification. It lands in `Triage`; fill what is known. Apply `planning-and-task-breakdown` to decide scope and design readiness, then the `linear` workflow to advance this issue; never delete the original request.

```markdown
Kind: feature | product change | tech improvement | chore | question
Requested by: <user or persona> on <date>
User prompt (verbatim): "<...>"
Goal: <what should be true afterwards, in one sentence>
Why now: <the trigger: a user need, an incident, a deadline, a cost, or "none stated">
Affects: <services, screens, or docs, if known>
Size (triage): small (an issue) | large (a project) | unknown
Scope boundaries: <included outcomes and explicit exclusions>
Design readiness: <current reviewed HLD/LLD links, missing design, or not applicable with reason>
Scope class (triage): MVP | MVP blocker | later
Persona (triage): <who takes it first>
Becomes: <project id or issue id, once classified>
```

Kinds:

- **feature**: new user-visible capability. Large ones become a project with a PRD (`Spec`); small ones an issue.
- **product change**: a change to what the product does or for whom; always through the PM and the project PRD.
- **tech improvement**: refactor, upgrade, performance, observability, or convention conformance with no user-visible change; states the measurable outcome and risk.
- **chore**: housekeeping with no design: a dependency bump, a config change, a doc move; goes straight to `Todo`.
- **question**: needs an answer, not work; closed with the answer as a comment, or converted.
