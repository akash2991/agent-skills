---
name: git-workflow-and-versioning
description: Rules for commits, branches, pull requests, and merging — always raise a PR and never merge directly, never hold a PR for a security audit, regular merge commit versus squash (conflict flagged), delete remote and local branches, small working commits that never break the app, commit messages carrying model, thinking effort, harness, and ticket id, branch-per-ticket naming, PR template, every PR's blast radius deciding its review and who merges, PR size limits (~400 lines / 10 files), main always releasable, and the changelog line per merged task. Use when you commit, branch, open, update, or merge a PR, or write a commit message — even for a one-line change or "just push it". Use when making any code change, resolving conflicts, splitting uncommitted work in a messy working tree into clean atomic commits, pushing to a remote, or when you need to organize work across multiple parallel streams. Use when cutting, tagging, or versioning a release, choosing a semantic version bump, or writing a changelog.
category: delivery
---

# Git Workflow and Versioning

## Overview

Git is your safety net. Treat commits as save points, branches as sandboxes, and history as documentation. With AI agents generating code at high speed, disciplined version control is the mechanism that keeps changes manageable, reviewable, and reversible.

This skill holds the rules (P1–P17) and the git mechanics. The GitHub calls that carry them out are `github`; what a review produces is `../../references/merge-and-review.md`.

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
a1b2c3d Add task creation endpoint with validation
d4e5f6g Add task creation form component
h7i8j9k Connect form to API and add loading state
m1n2o3p Add task creation tests (unit + integration)

# Bad: Everything mixed together
git log --oneline
x1y2z3a Add task feature, fix sidebar, update deps, refactor utils
```

### Keep concerns separate (P2)

Don't combine formatting changes with behavior changes. Don't combine refactors with features. Each type of change should be a separate commit — and ideally a separate PR:

```
# Good: Separate concerns
git commit -m "refactor: extract validation logic to shared utility"
git commit -m "feat: add phone number validation to registration"

# Bad: Mixed concerns
git commit -m "refactor validation and add phone number field"
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
| P8 | **Always raise a PR; never merge directly.** There is no direct-merge exception for small changes. Review follows the PR's blast radius (P17); a ticket may ask for review on any PR. Human approval is never required unless the ticket asks for it. |
| P9 | **Never hold a PR for a security audit; the audit is a later ticket / next requirement.** |
| P10 | **Every task ships through a pull request with the PR template; a reviewed PR merges only on the code reviewer's approval of its head; every review comment is resolved by a commit or an explained reply.** |
| P11 | **A PR is never held open to grow.** Open it ready for review, never as a draft, when the first verifiable slice is ready and you have run it; at roughly **400 changed lines or 10 files, split it** — land the mechanical part, the contract, or the flagged-off skeleton first. A long-lived branch is a merge conflict accruing interest. |
| P12 | **Only a change that is deployable on its own merges**; `main` is always releasable. |
| P13 | **Every merged task adds a changelog line** (global and per service), written in the same change while the impact is fresh. |
| P14 | Reviewers create Linear issues for findings and comment on the PR while it is open. |

- One ticket per PR; the title starts with the ticket id; the PR links the ticket and the ticket links the PR (P2, P4).

## Blast radius

| ID | Rule |
| --- | --- |
| P17 | **Every PR grades its blast radius in the opening block of its body (the `Key: value` lines before the first blank line): exactly one `Blast-radius: <low\|medium\|high> — <reason>`.** The grade decides the review and who merges. When two levels fit, take the higher; when unsure, go up one. The reason names no other grade, in any form (`medium-to-high`, `(high)`, `high-traffic`, `could be high`): write `busy path`, not `high-traffic path`; the script refuses it. |

| Level | The change | Review | Who merges |
| --- | --- | --- | --- |
| **high** | touches auth, payments, personal data, or permissions; a migration that drops, rewrites, or backfills data; a breaking change to a published contract (API, event, schema); CI/CD, deploy, infrastructure, or secrets; a shared kernel or more than one service; anything one revert does not undo; a security boundary in `security-and-hardening` § High Blast Radius | `code-reviewer` | the reviewer, on its approval of the head and green CI |
| **medium** | behavior a user or another service can reach, inside one service, undone by one revert; an additive contract or migration | none unless the ticket asks | the author, on green CI |
| **low** | nothing reachable changes: docs, tests, a refactor under passing tests, code behind a flag that is off or with no entry point | none unless the ticket asks | the author, on green CI |

- **The authoring agent never reviews its own PR**: it posts no verdict on it and never switches persona to approve it. A separate `code-reviewer` agent reviews and merges.
- **A shared GitHub account:** GitHub refuses an approval from the PR's own account, so the reviewer posts its verdict as a comment review that opens with `Reviewer: <its assignment name>` and `Verdict: APPROVE | REQUEST CHANGES` on consecutive lines; its prose follows after a blank line and is never read as a verdict. Only that opening `Verdict: APPROVE` approves. A review without an opening verdict that mentions a verdict or requested changes anywhere counts as a change request. **Only the agent that posted a review repairs it** (or a replacement under the same assignment name), keeping the verdict it meant (`github`); a real change request is resolved by that assignment approving the current head, never by relabeling it. The authoring agent never edits, rewrites, or dismisses another agent's verdict; it may only correct its own reply that tripped the fallback, and that never approves. A replacement reviewer takes over by using the same name. `merge-pr.js` prints which review passed the gate and warns that a shared account cannot prove the reviewer's independence.
- **An outstanding change request blocks a merge at every level** until the same reviewer approves the head.
- **A ticket that asks for review** on a low or medium PR: the `code-reviewer` reviews it and merges with `merge-pr.js --require-review`.
- **A ticket that asks for human approval or testing:** record the human's go-ahead on the ticket before anyone merges; no agent verdict stands in for it. Otherwise no human approves at any level.

## Merge

| ID | Rule |
| --- | --- |
| P15 | **Merge with a regular merge commit, not a squash**, so commit ids quoted in review threads stay findable. Never squash. Put the ticket id in the merge commit message. |
| P16 | Branching/merge defaults may be overridden when the service has a recorded reason (for example release branches). |

## Enforced by script

P2, P3, P5, P10, P11, P13, and P17 are checked by `scripts/brain-git-check.js` instead of by memory; P7, P8, P10, P11, P12, P15, and P17 are carried out by `scripts/merge-pr.js`, which refuses a draft, reads the blast radius from the PR body, and requires an approval of the head only for a high PR or with `--require-review`. Run this skill's `scripts/install-hooks.js` once per clone for the `commit-msg` and `pre-push` hooks, and copy `templates/pr-rules.yml` to the project's `.github/workflows/` so CI runs the same checks. A PR over the size limit records `Size-exception: <reason>` in its body rather than growing silently. The script cannot judge whether a commit is one coherent capability (P2) or whether a PR is deployable on its own (P12), nor whether its blast radius is graded right (P17); that stays with the author and the reviewer.

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

Releases follow semver and add an entry to the project changelog, `docs/CHANGELOG.md` (the brain's documentation map), listing the tickets. Commits are how *you* track change; a **version** is how your *consumers* track it: users on an installed app, clients of an API, people on a web deploy. "Latest on main" is never a sufficient answer to "what am I running, and is it safe to upgrade?" A version number and a changelog are the contract that answers it.

### Semantic Versioning

Which surfaces carry a version is `continuous-delivery` L1. Let each number carry meaning against what that surface promises: an API's contract to its clients, an app's capabilities to its users.

```
  MAJOR  breaking change — clients must change their code, or users lose a capability they relied on
  MINOR  new functionality, backward-compatible — safe to upgrade
  PATCH  bug fix, backward-compatible — safe to upgrade
```

The number is a promise, so make the code match it. A "patch" that changes behavior consumers relied on is a major change wearing a disguise (Hyrum's Law; see `api-and-interface-design`). When unsure whether a change is breaking, assume it is; a surprise major is far cheaper than a broken consumer.

### Tag the release, and let the tag be the source of truth

A release is an immutable point in history, not a moving branch. Tag it `<surface>-vX.Y.Z` (`continuous-delivery` L1) so it can always be reproduced:

```bash
git tag -a web-v1.4.0 -m "Web 1.4.0"
git push origin web-v1.4.0
```

Derive the version from the tag rather than hand-editing it in scattered files, so the artifact, the tag, and the changelog can never disagree.

A mobile app carries two numbers. The semver is the store version (`expo.version`; `versionName` on Android, `CFBundleShortVersionString` on iOS), taken from the `mobile-v` tag. Set the next version before its first candidate build is uploaded: App Store Connect refuses new builds under a version already approved. The build number (`versionCode`, `CFBundleVersion`) is an integer that increases on every build uploaded to a store or test track, including rebuilds of the same version. Whatever path builds the app (`development-setup` DS16, or CI) allocates it automatically, for example EAS's remote version source with `autoIncrement`; it is never edited by hand.

### Keep a changelog written for humans (P13)

A changelog is not `git log`. It's the curated, consumer-facing answer to "what changed and do I care?" — grouped by `Added / Changed / Fixed / Deprecated / Removed / Security`, newest on top, every entry phrased around user impact, not internal mechanics.

```markdown
## Backend
### 1.4.0 - 2025-06-12
#### Added
- FAC-41 — Bulk task import via CSV
#### Fixed
- FAC-44 — Timezone drift in recurring task due dates
#### Deprecated
- FAC-45 — `GET /v1/tasks/all`: use the paginated `GET /v1/tasks` (removal in 2.0)
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
| "I'll open it as a draft and let the user take it from there" | Open it ready for review; a low or medium PR is yours to merge on green CI, a high one the reviewer's (P11, P17). |
| "This one is probably low; the reviewer would slow it down" | When two levels fit, take the higher. A wrong low grade skips the only review the change gets (P17). |
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
- A draft PR, or a PR waiting on the user when the ticket never asked for their approval (P8, P11)
- A PR whose opening block lacks exactly one `Blast-radius:` line, or graded low while it touches auth, data, contracts, or deploy (P17)
- A verdict posted by the authoring agent on its own PR (P17)
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
- A surface with no version, or one version shared across backend, web, and mobile (`continuous-delivery` L1)
- A mobile build uploaded with a build number that is not higher than the last one
- A user-facing release with no changelog entry, or a changelog that's just dumped commit messages

## Verification

Before you push — checklist:

1. Does the app still run after this commit alone? (P1, P2, P12)
2. Is the diff one capability, under ~400 lines / 10 files? If not, split. (P2, P11)
3. Message has ticket id, model, thinking effort, harness. (P3, P2)
4. Unfinished paths behind a flag defaulting off or without an entry point. (P12)
5. Changelog line added. (P13)
6. PR opened ready from `<ticket>-<slug>` with the template and its blast radius; high goes to `code-reviewer`, low and medium you merge on green CI. (P5, P8, P10, P11, P17)
7. Never wait for a security audit. (P9)
8. On merge: regular merge commit with the ticket id; delete remote and local branch. (P15, P16)

For every commit, also:

- [ ] Tests pass before committing
- [ ] No secrets in the diff
- [ ] No formatting-only changes mixed with behavior changes
- [ ] `.gitignore` covers standard exclusions

For every release of a surface:

- [ ] The version bump matches the change: breaking → major, additive → minor, fix → patch
- [ ] The release is tagged `<surface>-vX.Y.Z`, and the version is derived from the tag, not hand-edited out of sync
- [ ] For mobile, the build number is higher than every build already uploaded
- [ ] The changelog has a curated, human-readable entry grouped by impact for this version
