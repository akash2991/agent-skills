---
name: git-workflow-and-versioning
description: Rules for commits, branches, pull requests, and merging — always raise a PR and never merge directly, never hold a PR for a security audit, regular merge commit versus squash (conflict flagged), delete remote and local branches, small working commits that never break the app, commit messages carrying model, thinking effort, harness, and ticket id, branch-per-ticket naming, PR template, PR size limits (~400 lines / 10 files), main always releasable, and the changelog line per merged task. Use when you commit, branch, open, update, or merge a PR, or write a commit message — even for a one-line change or "just push it". Use when making any code change, resolving conflicts, splitting uncommitted work in a messy working tree into clean atomic commits, pushing to a remote, or when you need to organize work across multiple parallel streams. Use when cutting, tagging, or versioning a release, choosing a semantic version bump, or writing a changelog.
category: delivery
---

# Git Workflow and Versioning

## Overview

Git is your safety net. Treat commits as save points, branches as sandboxes, and history as documentation. With AI agents generating code at high speed, disciplined version control is the mechanism that keeps changes manageable, reviewable, and reversible.

This skill holds the rules (P1–P16) and the git mechanics. The GitHub calls that carry them out are `github`; what a review produces is `../../references/merge-and-review.md`.

## When to Use

Always. Every code change flows through git. Whenever you commit, branch, open, update, or merge a PR, or write a commit message — even for a one-line change or "just push it".

## Commits

| ID | Rule |
| --- | --- |
| P1 | **Commits are small, working changes; every commit is usable or at least does not break the app.** Best effort: if a commit were pushed to production it should not cause any issue. This might not be true in all cases — sometimes the whole thing is pushed together — but wherever possible, even when not every commit goes to production, follow it at least in spirit. |
| P2 | Commits are small, **reference the tracker ticket**, and leave the repository runnable. **One coherent capability, contract, or verified behavior per commit; never "implement entire X".** |
| P3 | **A commit message carries the model, thinking effort, and harness**, plus the anatomy in `../../references/commit-and-pr.md`. Include the ticket id in the message. |
| P4 | The reasoning behind a change lives in the ticket; the ticket id lives in the code and the commit. |

### Commit early, commit often (P1, P2)

Each successful increment gets its own commit. Don't accumulate large uncommitted changes.

```
Work pattern:
  Implement slice → Test → Verify → Commit → Next slice

Not this:
  Implement everything → Hope it works → Giant commit
```

Commits are save points. If the next change breaks something, you can revert to the last known-good state instantly.

```
# Good: Each commit is self-contained
git log --oneline
a1b2c3d feat(api): add task creation endpoint with validation [PROJ-12]
d4e5f6g feat(web): add task creation form component [PROJ-12]
h7i8j9k feat(web): connect form to API and add loading state [PROJ-12]
m1n2o3p test(tasks): add task creation unit and integration tests [PROJ-12]

# Bad: Everything mixed together
git log --oneline
x1y2z3a Add task feature, fix sidebar, update deps, refactor utils
```

### Keep concerns separate (P2)

Don't combine formatting changes with behavior changes. Don't combine refactors with features. Each type of change should be a separate commit — and ideally a separate PR:

```
# Good: Separate concerns
git commit -m "refactor(validation): extract validation logic to shared utility [PROJ-123]"
git commit -m "feat(registration): add phone number validation [PROJ-124]"

# Bad: Mixed concerns
git commit -m "refactor validation and add phone number field"
# (each real commit also carries the Model, Thinking-effort, and Harness trailers, P3)
```

**Separate refactoring from feature work.** A refactoring change and a feature change are two different changes — submit them separately. This makes each change easier to review, revert, and understand in history. Small cleanups (renaming a variable) can be included in a feature commit at reviewer discretion.

### Message types (P3)

The `<type>` in the anatomy header explains the *why*, not just the *what*:

- `feat` — New feature
- `fix` — Bug fix
- `refactor` — Code change that neither fixes a bug nor adds a feature
- `test` — Adding or updating tests
- `docs` — Documentation only
- `chore` — Tooling, dependencies, config
- `style`, `perf`, `build`, `ci`, `revert` — formatting, performance, build system, CI configuration, and reverts

The scope is optional and lowercase (`a-z`, digits, and `. _ / , -`).

## Branches

| ID | Rule |
| --- | --- |
| P5 | **Branch per ticket named `<ticket>-<slug>`.** |
| P6 | Work in your own git worktree beside the main repository: both directories share one parent, and the worktree is never created inside the repository. Its basename is exactly `<ticket>-<slug>`; the agent's visible name follows `development-setup` DS2. |
| P7 | **Delete the remote and local branch after merge.** |

### Trunk-based development (P5, P7)

Work in short-lived branches off `main` (or the team's default branch), one per ticket, that merge back within 1-3 days. Long-lived development branches are hidden costs — they diverge, create merge conflicts, and delay integration. DORA research consistently shows trunk-based development correlates with high-performing engineering teams.

```
main ──●──●──●──●──●──●──●──●──●──  (always deployable)
        ╲      ╱  ╲    ╱
         ●──●─╱    ●──╱    ← PROJ-123-task-creation, PROJ-124-user-settings (1-3 days)
```

- **Dev branches are costs.** Every day a branch lives, it accumulates merge risk.
- **Release branches are acceptable** when you need to stabilize a release while main moves forward (P16).
- **Feature flags > long branches.** Prefer deploying incomplete work behind flags rather than keeping it on a branch for weeks.
- **One worktree per ticket** (P6) is how parallel agents work on one repository without switching branches.

## Pull requests

| ID | Rule |
| --- | --- |
| P8 | **Always raise a PR; never merge directly. Review may be made optional on the ticket.** There is no direct-merge exception for small changes. |
| P9 | **Never hold a PR for a security audit; the audit is a later ticket / next requirement.** |
| P10 | **Every task ships through a pull request with the PR template; reviewed-class PRs merge only on the discipline code reviewer's approval; every review comment is resolved by a commit or an explained reply.** |
| P11 | **A PR is never held open to grow.** Open it when the first verifiable slice is ready; at roughly **400 changed lines or 10 files, split it** — land the mechanical part, the contract, or the flagged-off skeleton first. A PR stays over the limit only when the user says so, recorded as a `Size-exception: <reason>` line in its body. A long-lived branch is a merge conflict accruing interest. |
| P12 | **Only a change that is deployable on its own merges**; `main` is always releasable. |
| P13 | **Every merged task adds a changelog line** (global and per service), written in the same change while the impact is fresh. |
| P14 | Reviewers create Linear issues for findings and comment on the PR while it is open. |

- One ticket per PR; the title is `<ticket>: <goal>`; the PR links the ticket and the ticket links the PR (P2, P4).

## Merge

| ID | Rule |
| --- | --- |
| P15 | **Merge with a regular merge commit, not a squash**, so commit ids quoted in review threads stay findable. Never squash. Put the ticket id in the merge commit message. |
| P16 | Branching/merge defaults may be overridden when the service has a recorded reason (for example release branches). |

## Enforced by script

Paths are as installed by `agent-brain pull` (`.agents/skills/…`; Claude's copy is under `.claude/skills/…`), run from the project root; `scripts/` below means `.agents/skills/git-workflow-and-versioning/scripts/`.

**What checks what.**
- `scripts/brain-git-check.js` checks P2–P5, P8 (no direct push to, or deletion of, `main` or the remote's default branch; no deletion of a long-lived branch), one ticket across the branch, the title `<ticket>: <goal>`, and the commits (P2, P4), P11, and P13. It runs as the `commit-msg` and `pre-push` hooks and in CI.
- `scripts/merge-pr.js` carries out the merge conditions of P10 (approval of the current head by someone with write access, no unresolved review thread), P7, P12's green-CI condition, and P15.
- Neither can judge whether a commit is one coherent capability (P2), whether a PR is deployable on its own (P12), or whether the approving writer is the discipline's code reviewer (P10); that stays with the author and the reviewer.

**Set up, once per project.**
- Run `scripts/install-hooks.js` once per clone, and once per worktree when `core.hooksPath` is relative (it says so). It refuses a hook directory outside the repository, never writes through a symlinked hook file, and makes the hooks executable. With husky, which owns `core.hooksPath`, call the checker from husky's hooks instead: `.husky/commit-msg` runs `node .agents/skills/git-workflow-and-versioning/scripts/brain-git-check.js commit-msg "$1"` and `.husky/pre-push` runs `… brain-git-check.js push "$@"`.
- Copy `.agents/skills/git-workflow-and-versioning/templates/pr-rules.yml` to `.github/workflows/` so CI runs the same checks. It reads the checker from the base branch, so merge the brain into that branch first.
- Set `LINEAR_TEAM` (one Linear team key, or several separated by commas) and `BRAIN_LONG_LIVED` (left unset in `.env`, merge-pr reads the repository variable; set empty, it means none and overrides that variable) as repository variables for CI and in `.env` for the hooks. The hooks look in the environment, the worktree's `.env`, then the main checkout's `.env`; the first that defines a key wins (an empty `LINEAR_TEAM` counts as unset, an empty `BRAIN_LONG_LIVED` as no extra branches). merge-pr reads the same places and then the repository variable. Without `LINEAR_TEAM`, CI and merge-pr refuse, since the generic ticket pattern also matches tokens such as `UTF-8`.
- Protect the default branch on GitHub with a ruleset that blocks direct pushes and deletion and requires status checks (at least `pr-rules` and the CI jobs, so a check that reports late still gates the merge): the pre-push hook is local and `--no-verify` skips it, so it is a guard against mistakes, not the enforcement of P8.
- Approval must come from a GitHub identity other than the PR author's, with write access: GitHub refuses a self-approval, so a reviewer agent signs in as its own account.

**Merge.** Run merge-pr from an up-to-date checkout of the base branch (the main checkout), never from the ticket's worktree, so the PR's own copy of the scripts never judges it: `scripts/merge-pr.js <n> --model <m> --effort <e> --harness <h>`, adding `--review-optional` only when the ticket made review optional (P8); the merge commit then carries `Review: optional`. It puts the P3 trailers on the merge commit and exits 0 when merged and cleaned up, 1 when it did not merge, 3 when it merged but left P7 cleanup to do, and 4 when it cannot tell whether the merge happened (nothing is deleted; run it again: on a merged PR it verifies the merge commit, then cleans up).
- The merge is pinned to the inspected head, and every gate input (base, title, body, reviews, threads, CI) is read and judged again just before merging: a PR retargeted, edited, reviewed, or with new CI results since its checks is refused. GitHub cannot pin them, so a retarget or edit in the moment between that read and the merge is caught after it: the merge is reported (exit 3) and both branches are kept.
- It requires a green `pr-rules` run of this PR at its head (the run names its PR: the template's `run-name` is `pr-rules #<number>`, since GitHub's list of PRs on a run holds every open PR from that branch), verified through the Actions job record (a job named `pr-rules` in that run, on this head, that succeeded), not the check's own details URL, run after the PR's last title, body, or base change, and checks the one-ticket rule again itself. A run of another PR or ref neither passes nor supersedes.
- Branches are deleted only after the merge commit is verified as a merge of the inspected head with the ticket and trailers: the remote branch only while it still points at that head, the local one only when no worktree has it checked out (remove the ticket's worktree first) and it is not a symbolic ref.
- It deletes only `<ticket>-<slug>` branches, never a fork's, and keeps `main`, the default branch, `release/*`, protected branches, and any branch `BRAIN_LONG_LIVED` matches, even one shaped like a ticket branch; when it cannot read the variable it keeps the head.

**Merged by hand, not by merge-pr.**
- A base with a merge queue.
- A fork's PR: its runs carry no PR link.
- A PR whose head branch has another open PR (a backport from the same branch): their CI runs cannot be told apart.
- A PR that changes `.github/workflows/`, which could change its own checks.
- A PR that changes the git-workflow scripts (merge-pr, brain-git-check), which could change its own checks.
- A promotion whose history holds commits merged by hand without the P3 anatomy (a dependency bot's): `pr-rules` cannot pass on history, so a reviewer checks it and merges it by hand.
- Dependency-bot PRs, which skip `pr-rules` and merge through their own tooling.

**Limits to know.**
- `BRAIN_LONG_LIVED` must match a whole branch name (`staging|develop` matches `staging` but not `ENG-12-develop-login`); an invalid pattern stops every check except `commit-msg`, and merge-pr.
- A promotion PR (a long-lived head into the default branch) is checked like any other: every commit it brings must meet P3, and a promotion over the P11 limits needs the user's `Size-exception:`. The size check needs git 2.41 or later and fails, rather than counting wrong, on older git.
- `release/*` and branches matching `BRAIN_LONG_LIVED` are trusted by name: pushes to them are not refused, and as a PR head they promote several tickets under one title. Creating one, or widening the pattern, is a reviewer-visible decision (P16).
- The pre-push hook refuses a push to `main` or the remote's default branch on every remote, a deploy remote (Heroku, Dokku) included: push a deploy with `--no-verify`, or deploy from CI.
- The `commit-msg` hook recognises an amended merge only while its subject is unchanged. To reword a merge's subject, amend with `--no-verify`, then run `brain-git-check.js commits --base origin/<base>` to check the stored merge as CI will (by its parents).
- `git revert`, `git cherry-pick`, and a non-interactive rebase do not run the `commit-msg` hook, and pre-push checks branch names, not commits: add the trailers with `git commit --amend` (or `git rebase -i` with `reword`) and check with `scripts/brain-git-check.js commits --base origin/<base>` before pushing, or `pr-rules` refuses them.
- Commits GitHub's web UI writes ("Update branch" merges, committed review suggestions) carry no trailers and fail `pr-rules`: update the branch locally or with the rebase variant of Update branch, and edit a suggestion's commit message before committing it.

## The Save Point Pattern

```
Agent starts work
    │
    ├── Makes a change
    │   ├── Test passes? → Commit → Continue
    │   └── Test fails? → Revert to last commit → Investigate
    │
    ├── Makes another change
    │   ├── Test passes? → Commit → Continue
    │   └── Test fails? → Revert to last commit → Investigate
    │
    └── Feature complete → All commits form a clean history
```

This pattern means you never lose more than one increment of work. If an agent goes off the rails, `git reset --hard HEAD` takes you back to the last successful state.

## Change Summaries

After any modification, provide a structured summary. This makes review easier, documents scope discipline, and surfaces unintended changes:

```
CHANGES MADE:
- src/routes/tasks.ts: Added validation middleware to POST endpoint
- src/lib/validation.ts: Added TaskCreateSchema using Zod

THINGS I DIDN'T TOUCH (intentionally):
- src/routes/auth.ts: Has similar validation gap but out of scope
- src/middleware/error.ts: Error format could be improved (separate task)

POTENTIAL CONCERNS:
- The Zod schema is strict — rejects extra fields. Confirm this is desired.
- Added zod as a dependency (72KB gzipped) — already in package.json
```

This pattern catches wrong assumptions early and gives reviewers a clear map of the change. The "DIDN'T TOUCH" section is especially important — it shows you exercised scope discipline and didn't go on an unsolicited renovation.

## Pre-Commit Hygiene

Before every commit:

```bash
# 1. Check what you're about to commit
git diff --staged

# 2. Ensure no secrets
git diff --staged | grep -i "password\|secret\|api_key\|token"

# 3. Run tests
npm test

# 4. Run linting
npm run lint

# 5. Run type checking
npx tsc --noEmit
```

Automate this with git hooks:

```json
// package.json (using lint-staged + husky)
{
  "lint-staged": {
    "*.{ts,tsx}": ["eslint --fix", "prettier --write"],
    "*.{json,md}": ["prettier --write"]
  }
}
```

## Handling Generated Files

- **Commit generated files** only if the project expects them (e.g., `package-lock.json`, Prisma migrations)
- **Don't commit** build output (`dist/`, `.next/`), environment files (`.env`), or IDE config (`.vscode/settings.json` unless shared)
- **Have a `.gitignore`** that covers: `node_modules/`, `dist/`, `.env`, `.env.local`, `*.pem`

## Using Git for Debugging

```bash
# Find which commit introduced a bug
git bisect start
git bisect bad HEAD
git bisect good <known-good-commit>
# Git checkouts midpoints; run your test at each to narrow down

# View what changed recently
git log --oneline -20
git diff HEAD~5..HEAD -- src/

# Find who last changed a specific line
git blame src/services/task.ts

# Search commit messages for a keyword
git log --grep="validation" --oneline
```

## Release & Versioning

Releases follow semver and add a `CHANGELOG.md` entry listing the tickets. Commits are how *you* track change; a **version** is how your *consumers* track it. The moment anything else depends on your code — another team, a published package, a deployed client — "latest on main" stops being a sufficient answer to "what am I running, and is it safe to upgrade?" A version number and a changelog are the contract that answers it.

### Semantic Versioning

For anything with consumers, version `MAJOR.MINOR.PATCH` and let the number carry meaning:

```
  MAJOR  breaking change — consumers must change their code to upgrade
  MINOR  new functionality, backward-compatible — safe to upgrade
  PATCH  bug fix, backward-compatible — safe to upgrade
```

The number is a promise, so make the code match it. A "patch" that changes behavior consumers relied on is a major change wearing a disguise (Hyrum's Law; see `api-and-interface-design`). When unsure whether a change is breaking, assume it is; a surprise major is far cheaper than a broken consumer.

### Tag the release, and let the tag be the source of truth

A release is an immutable point in history, not a moving branch. Tag it so it can always be reproduced:

```bash
git tag -a v1.4.0 -m "Release 1.4.0"
git push origin v1.4.0
```

Derive the version from the tag rather than hand-editing it in scattered files, so the artifact, the tag, and the changelog can never disagree.

### Keep a changelog written for humans (P13)

A changelog is not `git log`. It's the curated, consumer-facing answer to "what changed and do I care?" — grouped by `Added / Changed / Fixed / Deprecated / Removed / Security`, newest on top, every entry phrased around user impact, not internal mechanics.

```markdown
## [1.4.0] - 2025-06-12
### Added
- Bulk task import via CSV
### Fixed
- Timezone drift in recurring task due dates
### Deprecated
- `GET /v1/tasks/all` — use the paginated `GET /v1/tasks` (removal in 2.0)
```

Write the entry in the same change that makes the change, while the impact is fresh — not reconstructed from commit archaeology at release time. Breaking changes get a migration note and a deprecation window; this section is the versioning contract that shipping consumes.

## Interaction with other skills

- `github` carries the GitHub calls for the PR, review, merge, and release rules here; `development-setup` carries the worktree procedure behind P6.
- `continuous-delivery` owns releasability and the changelog rule that P12 and P13 serve; `deprecation-and-migration` owns the migration window a breaking change needs; `shipping-and-launch` ships the release this section versions.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "I'll commit when the feature is done" | One giant commit is impossible to review, debug, or revert. Commit each slice (P1, P2). |
| "It's a one-line change, I'll merge it directly" | Always raise a PR; there is no direct-merge exception for small changes (P8). |
| "Let's hold the PR until the security audit is done" | Never hold a PR for a security audit; the audit is a later ticket (P9). |
| "I'll open the PR once there's enough to review" | A PR is never held open to grow; open it at the first verifiable slice and split at ~400 lines / 10 files (P11). |
| "Model, effort and harness lines are noise in a commit message" | The message carries the model, thinking effort, harness, and ticket id (P3); reviewers and future agents need them. |
| "The message doesn't matter" | Messages are documentation. Future you (and future agents) will need to understand what changed and why. |
| "I'll squash it all later" | Never squash: commit ids quoted in review threads must stay findable (P15). Squashing also destroys the development narrative. |
| "Branches add overhead" | Short-lived branches are free and prevent conflicting work from colliding. Long-lived branches are the problem — merge within 1-3 days. |
| "I'll split this change later" | Large changes are harder to review, riskier to deploy, and harder to revert. Split before submitting, not after (P11). |
| "I'll delete the branch some other time" | Delete the remote and local branch after merge (P7). |
| "I don't need a .gitignore" | Until `.env` with production secrets gets committed. Set it up immediately. |
| "It's just a small fix, bump the patch" | Check what consumers can observe. A behavior change they relied on is a major, whatever the diff size. |
| "The changelog is just the commit log" | Commits are for you; the changelog is for consumers, curated by impact. Generating one from raw commits buries what matters. |
| "We'll write the changelog at release time" | By then the impact is reconstructed from memory and half of it is missing. Every merged task adds its changelog line (P13). |

## Red Flags

- A change merged to `main` without a PR (P8)
- A PR waiting on a security audit (P9)
- A PR past ~400 changed lines or 10 files that has not been split (P11)
- A commit message without the ticket id, model, thinking effort, or harness (P3)
- A branch not named `<ticket>-<slug>`, or work done outside your own worktree (P5, P6)
- A squash merge, or a merge commit without the ticket id (P15)
- A branch left on the remote or locally after merge (P7)
- A merged task with no changelog line (P13)
- Large uncommitted changes accumulating
- Commit messages like "fix", "update", "misc"
- Formatting changes mixed with behavior changes
- No `.gitignore` in the project
- Committing `node_modules/`, `.env`, or build artifacts
- Long-lived branches that diverge significantly from main
- Force-pushing to shared branches
- A breaking change shipped under a minor or patch version bump
- A release with no tag, or a version number hand-edited out of sync with the tag
- A user-facing release with no changelog entry, or a changelog that's just dumped commit messages

## Verification

Before you push — checklist:

1. Does the app still run after this commit alone? (P1, P2, P12)
2. Is the diff one capability, under ~400 lines / 10 files? If not, split. (P2, P11)
3. Message has ticket id, model, thinking effort, harness. (P3, P2)
4. Unfinished paths behind a flag defaulting off or without an entry point. (P12)
5. Changelog line added. (P13)
6. PR opened from `<ticket>-<slug>` with the template; review required or explicitly optional per the ticket. (P5, P10, P8)
7. Never wait for a security audit. (P9)
8. On merge: regular merge commit with the ticket id; delete remote and local branch. (P15, P16)

For every commit, also:

- [ ] Tests pass before committing
- [ ] No secrets in the diff
- [ ] No formatting-only changes mixed with behavior changes
- [ ] `.gitignore` covers standard exclusions

For every release (anything with consumers):

- [ ] The version bump matches the change: breaking → major, additive → minor, fix → patch
- [ ] The release is tagged, and the version is derived from the tag, not hand-edited out of sync
- [ ] The changelog has a curated, human-readable entry grouped by impact for this version
