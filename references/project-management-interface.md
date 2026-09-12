# Project Management Interface

The organization needs these operations from a project-management tool. The current tool is set by `projectManagement` in `manifest.json` and implemented by the tool skill of the same name (for Linear: the `linear` skill). Swapping the tool means adding a new tool skill that implements this same interface; nothing else in the org changes.

## Operations the org requires

| Operation | Who calls it | Meaning |
|---|---|---|
| Create project for a feature | CEO or PM | One container per feature, owned by a PM |
| Create milestone | EM | A delivery step with one usable outcome and a budget |
| Create sprint | EM | A fixed-length time box under a milestone with a points capacity and a sprint record; closed with a sprint review (delivered, spilled over, estimation error, unplanned work) |
| Create bug | Anyone | A ticket labeled `bug` with the structured bug template: type, severity, discovery, reproduction, expected/actual, evidence, affected story, fix owner |
| Post status update | Owner | A structured comment on every state change, reassignment, or re-pointing: by, change, reason, evidence, next action, and the blocker block when the state is `Blocked` |
| Create task | PM, EM, PE | One goal, acceptance criteria, owner, tier, owned paths |
| Set story/task state | Owner | `Backlog`, `Ready`, `In Progress`, `In Review` (PR raised), `Approved`, `Engineer Verified` (merged), `QA Verifying`, `QA Verified`, `User Verifying`, `Done`, `Blocked`, `Cancelled` (tools may collapse states and use labels; the skill documents the mapping) |
| Link pull request | Staff engineer | The task carries its PR link; review verdicts (changes requested, approved, merged) are mirrored as structured status updates |
| Mark blocker | Anyone | Task state `blocked` plus a "blocked by" relation, a status update whose blocker block defines type, dependency, requirement, owner, and escalation, and the Escalation block as a comment |
| Comment | Anyone | All reports and escalations are posted as comments on the task |
| Link agent | Owner | The task carries the `agent_id` of whoever is on it, matching the registry |

## Mapping conventions

- Task title: `<goal in one sentence>`.
- Task description: goal, epic and milestone, points (1, 2, 3, 5, 8), acceptance criteria, owned paths, interfaces consumed and provided, verification command, tier/model/effort, review path, links to HLD/LLD, dependencies.
- Labels: `role:<role>`, `tier:T0..T3`, `blast:small|reviewed`, `service:<name>`.
- Registry `ticket` = the tracker's issue identifier.

## Structure

Every ticket has a fixed structure (story, task, or bug template) and every change to it is a structured status update, so anyone can query what a ticket is about and what happened to it without reading chat. The tool skill defines the exact templates; they must carry at least the fields named in this interface.

## Anti-rules

- Do not track work in chat, in markdown TODO lists, or in commit messages instead of the tool.
- Do not create tasks without a goal and acceptance criteria.
- Do not close a task without the uniform report attached as a comment.
- Do not track bugs in files; a bug is a ticket.
- Do not carry unfinished work into the next sprint without a sprint review that records it as spillover.
