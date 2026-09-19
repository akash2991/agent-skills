# Blast radius, merging, and review

When a change may be merged by its author and when it needs a reviewer. Loaded by EMs, staff engineers, and code reviewers.

A change is **small / low blast radius** and may be merged by its author when all of these hold:

- touches one service and only the author's owned paths;
- no change to a public API contract, database schema, migration, auth, permissions, payments, data deletion, or infrastructure;
- no new dependency;
- fully covered by tests that pass locally and in CI;
- trivially reversible by a single revert.

Every task ships through a pull request raised by its staff engineer (`{{ORG_DIR}}/references/pull-request.md`). Small changes merge after CI passes with the criteria stated in the PR. Everything else is **reviewed**: the code reviewer of the change's discipline reviews the PR with inline comments, the engineer resolves every comment, and the reviewer's `Approve` is the merge gate; the reviewer summarizes with `{{ORG_DIR}}/agents-reports/merge-review.md` across the five axes (correctness, readability, architecture, security, performance) and must `APPROVE` before merge. T3 changes that touch auth, payments, data handling, or external input also get a `security-auditor` pass; a web milestone gets a `web-performance-auditor` pass before it ships. The EM may raise (never lower) the bar for a service.
