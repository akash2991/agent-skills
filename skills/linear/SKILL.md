---
name: linear
description: Operates Linear as the organization's project-management tool through the Linear MCP server: projects for features, milestones, cycles as sprints with sprint records and reviews, structured story, task, and bug issues, structured status updates on every state change, blocker definitions, labels, and comments. Use when any persona needs to create, update, read, query, or reassign tracker items, file a bug, post a status update, or link a registry ticket id to a Linear issue.
category: tools
---

# Linear

## Overview

Linear is the implementation of the project-management interface in `{{ORG_DIR}}/references/project-management-interface.md`. Every milestone, sprint, task, blocker, and report lives there. This skill maps the org's concepts onto Linear objects and gives the exact operations. Swapping the tool means writing another skill against the same interface.

## When to Use

- Creating a feature project, milestone, cycle, story, or task.
- Changing a ticket's state, assignee, labels, or relations.
- Posting a report or a blocker as a comment.
- Reading what is assigned to you or to your service.
- NOT for tracking work anywhere else: no markdown TODO lists or chat threads as a substitute.
- NOT for fabricating identifiers: if the MCP call fails, report the failure.

## Setup

The build emits this server into each tool's repo-level MCP config (`.mcp.json`, `.cursor/mcp.json`, `.gemini/settings.json`, `opencode.json`, `.vscode/mcp.json`) with the tool's own environment-variable syntax. Tools with only a global config (Codex, Kimi, others) and the CLI fallbacks are covered in `../../references/tool-auth.md`. Verify with a read-only call before writing anything.

## Process

1. **Read before write.** Search for the project, milestone, cycle, or issue first. Never create a duplicate.
2. **Pick the operation** from the interface table and map it with the concept table below.
3. **Fill the description template** for issues; add labels; set project, milestone, cycle, and dependencies.
4. **Write, then read back** the created or updated object and quote its identifier in your report and registry row.
5. **Post a structured status update on every state change, reassignment, or re-pointing** (template below); when the new state is `Blocked`, the update contains the blocker block. Attach reports verbatim.
6. **Query by structure.** Because every ticket uses its template and every change has a status update, answer "what was this ticket about" or "what changed" by reading the description and the status-update comments in order; never reconstruct history from chat.

## Concept mapping

| Org concept | Linear object | Notes |
|---|---|---|
| Feature | Project | One per feature; PM's `agent_id` in the description |
| Milestone | Project milestone | Name = usable outcome; description carries the `Verify:` line |
| Sprint | Cycle | Fixed length, points capacity; the sprint record is the cycle description, the sprint review is a comment on it at close |
| Bug | Issue with label `bug` | Uses the bug template; `bug:<type>` and `severity:*` labels; linked to the story it affects |
| Story | Issue (parent) | User-observable outcome; tasks are sub-issues |
| Task | Issue (sub-issue) | Title = one-sentence goal; description = template below |
| Foundation task | Issue with `blocks` relations to every dependent task | Label `foundation` |
| Story state | Workflow state + label | `Backlog`, `Todo` (= Ready), `In Progress`, `In Review` (= PR raised, awaiting the code reviewer), `Approved` (create it, or label `review:approved`), `Merged` (= Engineer Verified; create it, or label `merged`), `QA` (= QA Verifying; create it if the team lacks it), `Done`, `Blocked`, `Canceled`; labels `qa:verified` and `user:verifying` mark the last two gates before `Done` |
| Pull request | Issue attachment / link | Every task issue links its PR; the PR title starts with the issue id so Linear auto-links; review verdicts are mirrored as status updates |
| Story points | Estimate | 1, 2, 3, 5, 8; split anything larger |
| Report | Comment on the issue | The uniform report for the role, verbatim |
| Registry ticket | Issue identifier | e.g. `ENG-42`; `Agent:` line in the description holds the `agent_id` |
| Labels | `role:*`, `tier:*`, `blast:*`, `service:*`, `foundation`, `bug`, `bug:<functional\|regression\|performance\|security\|data\|ux\|flaky-test\|environment>`, `severity:<blocker\|high\|medium\|low>` | Create missing labels once per team |

## Ticket structures

Every ticket has a fixed structure so anyone can query what it is about. Stories, tasks, and bugs use the templates below; every change to a ticket is a structured status update.

### Story description template

```markdown
As a <user>, I want <capability> so that <outcome>.
Epic / milestone: <names>
Points: <sum of tasks>
Acceptance criteria:
- [ ] <criterion>
Services: <service → EM>
PRD: <link>
Tasks: <sub-issue ids>
```

### Task description template

```markdown
Goal: <one sentence>
Epic / milestone: <names>
Points: <1|2|3|5|8>
Agent: <agent_id or unassigned>
Tier / model / effort: T1 / medium / medium
Review path: direct | peer | peer + PE
Owned paths:
- <path>
Acceptance criteria:
- [ ] <criterion>
Interfaces consumed: <contracts>
Interfaces provided: <contracts>
Verification: `<command>`
Design: <link to HLD/LLD section>
Depends on: <issue ids>
PR: <url once raised>
Metrics: <tech / product / business metrics this task emits, from the LLD and PRD>
```

### Bug description template

```markdown
Summary: <one sentence, observable>
Bug type: functional | regression | performance | security | data | ux | flaky-test | environment
Severity: blocker | high | medium | low
Discovered by: <agent_id or user> via <QA verification | end-to-end test | user report | monitoring | code review>
Discovered on: <date> at <commit or environment>
Affects: <story or feature issue ids>, service <name>
Reproduction:
1. <step>
Expected: <behavior>
Actual: <behavior>
Evidence: <log, screenshot, test output>
Suspected cause: <or unknown>
Fix owner: <agent_id or unassigned>
RCA required: yes | no (yes when it reached a milestone verification, review, or the user)
```

### Status update comment (on every state change, reassignment, or re-pointing)

```markdown
### Status update
- By: <agent_id> (<role>)
- Change: <field> <old> → <new>   (state, assignee, points, sprint, milestone)
- PR: <url, or n/a> — review: <opened | changes requested (n comments) | approved | merged>
- Reason: <one or two sentences>
- Evidence: <command → result, commit, report link, or n/a>
- Next action: <what happens next and who does it>
- Blocker (only when the new state is Blocked):
  - Type: product ambiguity | technical decision | dependency | environment/tooling | ownership conflict | external service | missing access
  - Dependency: <ticket, contract, service, or person this waits on>
  - Requirement: <what must be true or decided for work to continue>
  - Owner: <who resolves it>
  - Escalated to: <role> as Q-<ticket>-<n>
  - Expected by: <time/event, or unknown>
```

### Sprint record (cycle description) and sprint review (comment at close)

```markdown
## Sprint <n> — <start> → <end> — milestone <name>
- Goal: <what is usable at the end>
- Capacity: <points> (basis)
- Planned: <points> across <n> tickets

### Sprint review
- Delivered: <points> (<n> tickets)
- Spilled over: <points> — <ticket: reason, re-pointed to n>
- Estimation error: <ticket: estimated n, actual m, cause>
- Unplanned work: <ticket: points, why>
- Blockers hit: <ticket: type, resolution>
- Next sprint capacity: <points> (basis)
```

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "I'll create the issue after the code is done." | Then nobody could see the work in progress, and the routing record never existed. |
| "The comment is long, I'll summarize the report." | The receiver verifies the report. A summary hides what they need to check. |
| "I'll track this small thing in the PR description." | The tracker is the single place. Small things that live elsewhere get lost. |
| "The MCP call failed, I'll note the id I expected." | A guessed identifier corrupts the registry. Report the failure and retry once. |
| "A one-line comment is enough for this state change." | Without the structured update nobody can later tell why the ticket moved or what blocked it. |
| "I'll keep the bug in a notes file for now." | Bugs live only as `bug` tickets. A file cannot be queried, assigned, or linked to the story. |

## Red Flags

- Two issues with the same goal.
- A `Blocked` issue with no status update carrying the blocker block, or no `blocked by` relation.
- A state change, reassignment, or re-pointing without a structured status update.
- A bug reported outside the tracker, or a `bug` issue missing type, severity, discovery, or reproduction.
- A cycle closed without a sprint review comment.
- A ticket in `In Review` or `Approved` with no PR link, or a merged PR whose ticket is not `Merged`/`Engineer Verified`.
- An issue closed without a report comment.
- A registry row whose ticket does not exist in Linear.
- Labels missing on a task that has a routing record.

## Verification

- [ ] The object exists in Linear and its identifier is quoted in the report and registry.
- [ ] Every task has the description template filled, labels, project, milestone, and dependencies.
- [ ] Every state change, reassignment, or re-pointing has a structured status update; `Blocked` updates carry the blocker block; reports are attached verbatim.
- [ ] Every bug is a `bug` issue with the full template and labels.
- [ ] Every cycle has a sprint record and, when closed, a sprint review.
- [ ] No duplicate project, milestone, or issue was created.
