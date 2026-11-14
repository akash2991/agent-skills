# Review and merge

What a review produces and when a change merges. Loaded by the engineers and the reviewer personas. The process rules are `git-workflow-and-versioning` P8–P10 and P14–P15; the review framework, roles, and output format are the `code-reviewer` persona.

## When a review runs

The PR's blast radius decides (`git-workflow-and-versioning` P17): a high PR gets a `code-reviewer`; a low or medium PR gets none unless the ticket asks for one (P8). A human approves only when the ticket says so. A QA pass (`test-engineer`) runs on a story reported done.

## What a review produces

- Inline PR comments at `path:line`, each with a severity (Critical, Required, Optional, Nit) and a fix.
- A structured status update on the ticket.

Reviewers are specialized and adversarial. They never edit the change.

## Merge

Through `merge-pr.js` (`github`): a regular merge commit, ticket id in the message, branch deleted remote and local, changelog line, ticket moved. A high PR is merged by its reviewer after its approval of the head and green CI; a low or medium PR by its author on green CI.
