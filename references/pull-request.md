# Pull Requests

Every task ships through a pull request. The staff engineer raises it, the discipline's code reviewer reviews it with inline PR comments, the engineer resolves every comment, and the Linear ticket state mirrors each step with a structured status update. The PR is where the code conversation happens; the ticket is where the state lives.

## Size and deployability

A PR carries one ticket and lands while it is still small. The guards:

| Guard | Limit | What to do when you hit it |
|---|---|---|
| Changed lines | ~400 | Split: land the contract, the mechanical rename, or a flagged-off skeleton first |
| Files touched | ~10 | Split along the feature boundary, not the layer boundary |
| Time open | 1 sprint day | Land what is verifiable now and open a follow-up ticket |
| Commits piling up without review | 3 | Request review; a PR nobody has looked at is not progress |

These are guards, not gates: a generated file or a mechanical rename can exceed them with a line in the description saying why. What is never acceptable is holding a PR open to keep adding to it.

Every merged PR must be deployable on its own. If the feature is not finished, the code behind it is behind a flag that defaults off, the migration is backward compatible for one release, and the deploy workflow is green. "Merged but not deployable" is an outage waiting for the next release.

## Rules

- One ticket per PR, one PR per ticket. The PR title starts with the ticket id.
- Open the PR only after the verification commands pass locally; open it as a draft earlier if you want CI feedback.
- The PR description uses the template below; the ticket gets a `PR:` link and a status update the moment the PR opens.
- Reviewed-class PRs need the discipline code reviewer's `Approve`. Small-blast-radius PRs may be merged by the author after CI passes, with the blast-radius criteria stated in the description.
- Every review comment is resolved by a commit or a reply that explains why not, before re-requesting review. Never resolve a comment silently.
- Merge strategy and branch naming follow the service `CONVENTIONS.md`; default is squash-merge with the ticket id in the commit message.
- After merge: delete the branch, add the `CHANGELOG.md` line, move the ticket to `Engineer Verified`, and confirm the deploy workflow for the affected environment is green.

## PR description template

```markdown
Ticket: <LIN-123> — <goal in one sentence>

## What changed
- <path or module> — <what and why>

## Verification
- `<command>` → <result>
- Acceptance criteria: <n>/<m> covered by tests (list the test names)

## Blast radius
small (author-merge; criteria: <list>) | reviewed (reviewer: <discipline>-code-reviewer)

## Instrumentation
- Metrics added: <tech / product / business>
- Log points: <where and why, or none>

## Design
- LLD section: <link>; contracts or schema changed: yes | no

## Not done / follow-ups
- <item or none>
```

## State mapping

| Event | Ticket state | Who moves it |
|---|---|---|
| PR opened | `In Review` (`Implemented` for small-blast-radius author-merge) | staff engineer |
| Reviewer requests changes | `In Progress` with the review summary in the status update | code reviewer |
| Author pushes fixes and re-requests review | `In Review` | staff engineer |
| Reviewer approves | `Approved` (label `review:approved`) | code reviewer |
| Merged | `Engineer Verified` | staff engineer |
| Reviewer blocks | `Blocked` with blocker block; escalated to the EM | code reviewer |
