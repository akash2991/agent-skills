# Explicit user instructions

**An explicit instruction from the user overrides everything in this organization** for the session it is given in: these rules, the conventions, a persona's authorization, a skill's process, any document. Follow it, and record it here.

**This file is a record, not a rule.** Nothing in it binds a later session. An agent does not read this file to find out how to behave, and an entry here never overrides a convention for anyone other than the person who was told. If an instruction should apply from now on, it belongs in `CONVENTIONS.md`, a persona, or a skill, where it is enforced for real. Leaving it here would mean quietly accumulating rules nobody agreed to.

What the record is for is the opposite of enforcement: it shows where the defaults keep being wrong. An instruction the user has to give more than once is a default worth changing, and this is where you would notice.

## Session instructions — AKA-66 (2026-09-14)

- User: “for migration creat a separate migration folde. where all schema and some native code (sql)will sit”; accepted the proposed per-service baseline/up/down SQL layout and selected Sol/high. Implement autonomously in the assigned isolated worktree, create and commit `contentos/migrations/`, preserve the pre-extraction SQL bytes/checksums and migration behavior, run one combined verification pass, and do not access live schema/data, push, merge, deploy, restart, spawn agents, or alter the original checkout. This overrides the default PR/review handoff and incremental per-slice full verification for this bounded extraction; the parent owns integration, review, PR, and cleanup.
- Continuation after pause: continue in the same preserved worktree/session with `openai-codex/gpt-5.6-sol` at high effort; do not repeat completed verification, keep commit-only handoff, and preserve all original checkout edits. No push, merge, deployment, live migration, restart, or additional agents.
- Test-database continuation: user explicitly authorized the already-started isolated PostgreSQL 17.11 test container on its injected private endpoint. Run the one pending full Python suite against that endpoint only, never overwrite it from the original repository `.env` or use localhost:5433, do not restart/remove the container, and rerun only affected tests after genuine failures. Commit after verification; parent owns container cleanup and integration.

## Session instructions — AKA-41 (2026-09-14)

- User authorized implementing the database fix, adding pooling and service-wide PostgreSQL-native persistence, using an isolated worktree, expanding Linear with sub-issues, and delegating read-only audits. Native data types may be converted when needed; do not delete migration code/history or data/backups. Model: Astra/high.
- Final concurrency policy: “Highlight concurrency issues that you think can occur, and solve for the lowest denominator. And in case of any concurrency issue, it's better to error out rather than write illegal values. Once those errors are frequent and we see downtimes because of it, then we will try to solve those issues.” Prefer native constraints/short atomic transactions/conditional version writes, explicit conflict errors and measured conflict rates. No automatic retry loops, queues or speculative coordination. Broader audit hypotheses are not observed production incidents.
- User requested longer suite execution timeout: 900 seconds rather than 240; keep short lock-regression assertions unchanged.
- User: “keep merging in your branch at least” and “dont do peice by peice review. Do the whole thing. Then review at the end”. Accumulate child implementations in the feature integration branch, with tests during integration, and request one review after the entire agreed PostgreSQL-native scope is complete. This explicitly overrides the default per-slice review/PR size workflow for this effort. Do not merge main or deploy; PR #11 stays draft during integration.
- User: “for sub agents use sol”. Use `openai-codex/gpt-5.6-sol` with high thinking for new delegated work from this point. User clarified “from now on” and “dont cancel the ongoing work”. Existing workers continue unchanged; only new sub-agents use Sol/high.
- User: “Don't do testing again. Just land all the changes and then do testing on one pass.” From this instruction, skip further per-slice parent test runs; integrate remaining changes into the feature branch, then perform one combined verification pass. Do not cancel ongoing work or merge main. Existing workers may finish their already-assigned verification; do not duplicate it in the parent. The already-launched ledger worker remains on Astra; parent model remains unchanged.

- User: “claude agent can only be used from claude harness”. For the requested independent final review, invoke Claude through the Claude Code CLI/harness, never as a Claude model in Pi. Keep the review read-only and retain the existing no-main-merge/no-deployment limits.

- User: “Merge the PR to main. Delete worktrees.” Authorizes merging reviewed PR #11 into remote main and deleting this task’s preserved worktrees. Supersedes the earlier no-main-merge limit for this PR. Preserve unrelated/uncommitted work; no live schema migration or deployment requested.

- User: “close/update linear tickets”. After verifying the merge, close completed AKA-41 scope and update retained optional follow-ups; do not mark deferred, unimplemented work Done.

## Session override — AKA-41 (2026-09-14)

- User: “remove any relic of migration. fix the issue. add connection pooling”. Expands the prior core.db lock fix to PostgreSQL connection pooling and obsolete migration-code cleanup, including necessary dependency, lifecycle, test, and documentation changes. User clarified: “remove any relic of migration i mean...from postgres..remove any decision which got carried over from migration”. This means removing SQLite-era PostgreSQL design compromises, not deleting migration history or files. Final clarification: “you dont need to delete any migration code. you need to fix db”. Scope is the AKA-41 schema initialization fix plus bounded pooling and the caller lifecycle changes needed to use it safely; no migration-code deletion or storage-type conversion. Existing write-serialization correctness is preserved. Historical database files/backups are not authorized for deletion. Model remains Astra/high. No deployment or merge requested.

- User confirmed "yes" to deleting the remaining AKA-41 local and remote feature branches after PR #11 was merged. Delete only task-related branches whose tips are preserved in main; retain unrelated branches and existing local edits.

- AKA-66: User requested a dedicated migration folder containing schema and migration SQL, then selected "use sol high. create linear". Use openai-codex/gpt-5.6-sol/high for the bounded extraction in an isolated worktree; preserve SQL bytes/checksums/history, keep runtime queries in stores, and do not restart services or migrate live data.

- AKA-66: User: "can you pause subagent. i will resume later". Interrupt sql-files-api, retain its session/worktree and any partial work, and do not resume or launch replacement work until the user asks.

- AKA-66: User: "conitnue." Resumes sql-files-api after the requested pause, with the same Sol/high model, isolated worktree and previously agreed scope/safety limits.

- AKA-66: User: "yes. i have started docker" in response to the proposal for an isolated disposable PostgreSQL test instance. Authorizes starting a separate test database container and resuming verification; do not restart app services, reuse production data volumes, or migrate the existing application database.

- AKA-66: User: "ask a reviewer then and merge PR if things looks good". Authorizes an independent review of PR #12 and merge into main only if no blocking findings remain and merge checks allow it. Claude review must use the Claude Code harness. No application restart, live migration or deployment authorized.

- User: “docker is runnig. rebuild and redoply”. Authorizes rebuilding/redeploying the local Docker application stack, including required schema bootstrap on the existing local database after a verified backup/rehearsal. Preserve database/media volumes and backups; do not enable unattended publishing or deploy remotely. Supersedes the previous no-local-restart/deployment limit for this requested refresh.

## How to log one

**Write the entry before you carry on.** You, the agent that received it. Not later, not at the end of the run.

Record what the instruction actually was, not your interpretation of it. If you are unsure whether something was an override or a passing preference, ask, then write down the answer.

If you notice the same instruction already in the table below, say so to the user and name the convention, persona, or skill that should absorb it. That is a suggestion, not a change you make on your own.

## Log

- 2026-09-14, close refactor and merge: "align contracts. why is there a contract drift in the first place? isnt FE using typed client of BE? close all open points. review and merge" — authorizes contract alignment, correction and verification of the current refactor's open review findings, and reviewed integration/merge. Preserve unrelated dirty files and production data. No push/deployment requested. Coordinator explained that broader unimplemented historical drift categories are not claimed resolved.

- 2026-09-14, canvas-position behavior: "terminology is fine. Then coordinates cannt be null. FE should automatically add some random coordinates. User can modify them later." — establishes non-null numeric coordinates in the frontend editor model; frontend supplies random initial coordinates for missing/null incoming positions, editable afterward. Supersedes treating nullable wire coordinates as nullable editor-domain state; no backend schema migration or metadata-policy change was requested.

- 2026-09-14, refactor review: "yeah..do review. using astra. high." — authorizes review of the refactor using Astra/high. Parent performs same-model review; this does not satisfy the independent cross-family reviewer requirement and does not authorize merging. Overrides the coordinator persona's default hand-back-only review routing for this session.

- 2026-09-14, convention-drift refactoring confirmation: "same model and effort (Astra and high). external inputs need to be typed at the edges." — use `openai-codex/gpt-6-astra` with high thinking for staff subagents; parse and validate external inputs into explicit types at I/O boundaries.

- 2026-09-14, convention-drift refactoring: "there are convention-drift reports in agent-repots. spawn staff subagents to refactor the code according to the findings. I am not sure if tis there in the drfit or not, but no strings, no opaque objects. Everything should be typed so that we get issues at compile time instead of run time" — authorizes staff subagents and report-driven refactoring, overriding the default prohibition on invoking other personas; explicitly requests compile-time type safety beyond reported findings.

- 2026-09-14, independent review: "yeah. but the subagent should be gpt sol. with high" — explicitly authorizes a fresh backend-reviewer subagent using `openai-codex/gpt-5.6-sol:high`; overrides the default no-subagent/no-other-persona restriction. Review the committed PostgreSQL work locally without a PR/ticket; do not edit the implementation.

- 2026-09-14, PostgreSQL-only cleanup: "yeah. dont keep any old relic. it is postgres support from now on. we will just keep data for any issue." — remove SQLite support, completed importers and legacy v1 migration tools; preserve SQLite files/backups and database data for investigation. Supersedes keeping migration tooling for rollback/reuse.

- 2026-09-14, PostgreSQL documentation follow-up: "dont revert the HLD and LLD changes..if you done it already" — retain the completed HLD/LLD updates; restore their saved patch after the prior reversal. This supersedes the previous documentation-reversal instruction for this session.

- 2026-09-14, PostgreSQL follow-up: User reported "no data is visible on FE" and objected "who asked you to uopdate the HLD and LLD docs of all services." Reopen verification, test the running UI/API path, and remove this session's service HLD/LLD edits rather than following automatic documentation-update defaults.

Newest first. One row per explicit instruction.

| Date | Session or ticket | The instruction, in the user's words | What it overrode |
|---|---|---|---|
| 2026-09-14 | AKA-28 — PR #8 review scope | "accebility issue is fine . file it in the bug on linear." · (on the remaining non-accessibility web findings) "fine" | merge-and-review: every Required review finding is resolved in the PR before approval. The web reviewer's two Required accessibility findings (drawer focus/Escape, Start run dialog focus trap) and three Optional/Nit accessibility findings were deferred to bug AKA-38 instead of fixed in PR #8; the web reviewer accepted the deferral and approved at 540732f. |
| 2026-09-14 | AKA-28 — PR for runtime definitions | "create a PR. and ask backend and web subagents to review it and put PR comments. QA can also check parallely" | ORG rule 3 (never invoke another persona): the EM opens the PR and spawns the backend code reviewer, web code reviewer and test engineer as parallel subagents. pull-request.md "one ticket per PR" and the ~400-line / ~10-file guards: one story-level PR carries AKA-29 + AKA-30 (the size is mostly generated contracts, web mirrors and tests). The PR author and reviewers share one GitHub account, so verdicts are comment-type reviews, as on PRs #3 and #4. |
| 2026-09-14 | AKA-28 — Workflow runtime definitions | "do it in a worktree. add metrics (tech, product). spwan subagents. ask PM for pridcut and buisness metric." · "you are the EM" · "you will take help of staff and PM" | ORG rule 3 (never invoke another persona) and EM "Subagents: none by default": the EM spawns the product manager (metrics) and backend + web staff engineers as subagents. EM "never start implementation before a different PE approved the design": no PE pass; the EM fixed the contract in `services/workflows/design/runtime-definitions.md` before parallel work. Rule 1: model/effort not asked (session Opus 5 inherited). |
| 2026-09-14 | AKA-25 PRs #5–#7, AKA-26 PR #4 | "merge the PR aftter review. Security pass can happen after it and its findings can be taken up as folloup" | merge-and-review: a T3 change touching auth, secrets and external input gets a `security-auditor` pass before merge. Security audit runs in parallel; its findings are filed as follow-up tickets, not merge gates. |
| 2026-09-14 | AKA-24 — PR #4 (web) and the backend PR | "you can raise a PR and approve it using my creds" · "other agents have merged the PR. check how they did it." | merge-and-review / G-16: the reviewer's formal APPROVE is the merge gate. GitHub refuses a formal Approve from the PR author's own account, so the discipline reviewer's verdict is a comment-type review and the EM merges on it with the user's gh login, as PR #3 was merged (merge commit ea94be5, reviews COMMENTED). Session-scoped authorization for the AKA-24 PRs. |
| 2026-09-14 | Observability PR #3 merge | "is re-review required? it is a greenfeild code..adding metrics. What is so complicated?" then "wrap it on priority. dont increase scope" | merge-and-review: user asked to merge at dcb1839 on the fix engineer's green run (353 tests, mypy x3) and the security PASS without waiting for the code reviewer's formal APPROVE after its REJECT (reviewer had confirmed all three required items resolved in source; its own pytest run was still in progress). |
| 2026-09-14 | Observability stack — review and merge (AKA-22, AKA-23) | "assing agents for review and merge the PR." | ORG rule 3 (never invoke another persona): the EM spawns the backend code reviewer, security auditor and test engineer as subagents and merges on their verdicts instead of handing back for the user to invoke `/brain-review-backend`, `/brain-security`, `/brain-qa`. |
| 2026-09-14 | AKA-24 — Link social accounts (OAuth) | "You are an EM. spawn PE subaagents to draft the HLD and LLD. And then spawn fe staff and be staff to implement parallely. do it in git worktree. Decide on api contracts before parallizing work" · "all details should saved hashed + salt" | ORG rule 3 (never invoke another persona), rule 4 (ask before spawning), EM persona "Subagents: none by default" and "Confirm the run before working" (no model/effort confirmation asked; session default Fable 5.1 inherited by subagents). No PM ticket/PRD: EM filed AKA-24 directly. "Hashed + salt" is applied as encryption-at-rest with per-record salt plus a salted fingerprint, because OAuth tokens must be presented to the provider and cannot be one-way hashed; recorded in DECISIONS.md. |
| 2026-09-14 | Observability stack (Prom + Grafana + Loki) | "You are an EM · Use subagents (PM and Staff) to prallize · For prodcut and business metrics ask PM · For tech metrics ask staff · Prom + grafana + loki · Dashboard as code · Setup on docker · Add important metrics to begin with." | ORG rule 3 (never invoke another persona) and rule 4 (ask before spawning subagents); EM persona "Subagents: none by default" and "Confirm the run before working" (no model/effort confirmation asked; running the session default, Fable 5.1). No approved PE design exists for this work; EM is authorising it on the user's instruction. |
| 2026-09-14 | Login feature — PR and merge | "raise a pr to main and merge" | G-16 / merge-and-review: a reviewed-class (auth, migration, public contract; T3) PR merges only on the discipline code reviewer's APPROVE plus security pass; staff engineer "Never merge a reviewed-class change without the code reviewer's APPROVE". Merged without /brain-security or /brain-review-* on the user's instruction. |
| 2026-09-14 | Login feature — frontend subagent and docs | "why didnt tou spawn two agents for this? one for be one for fe?" then approved "Yes, spawn web subagent"; docs: "Update LLD and HLD" | Staff-engineer "No subagent spawning" and the rule that agents do not invoke another persona; the earlier-this-session objection to unrequested HLD/LLD edits (now explicitly requested for core and api). |
| 2026-09-14 | Login feature (username/password) | "create login feature. as of now username password. We will add social media login later. create admin user AkashAdmin with password AkashAdmin345@. And attach the current data to this profile" — then chose "Build it now (override)" | PM ticket/PRD → design → EM ticket flow; staff-engineer ticket requirement; auth/migration T3 review path before build (review still to be requested); no-ticket commits. Password is kept out of source (G-4): seeded from an env var, stored hashed. |
| 2026-09-14 | Persist independent convention-drift reports | "write independent reports in code" | Prior read-only audit constraint and engineering-manager repository edit scope; persist each staff report separately without synthesis. |
| 2026-09-14 | Whole frontend/backend convention-drift audit correction | "you werent asked to synthesize." | Default coordinator behavior of integrating child outputs; limit the handoff to the individual staff-agent reports unless synthesis is explicitly requested. |
| 2026-09-14 | Whole frontend/backend convention-drift audit | "model and effort is the same as selected. whole fe and be needs to be audited. Dont require ticket for this. keep max cocurrency of 3." Together with: "spaen multiple staff backend and froentend subagents" and "Nothing in the conventions is overridable." | Ticket requirement; prohibition on invoking other personas; default subagent concurrency; authorization to override conventions. |
| 2026-09-14 | SQLite → PostgreSQL | "whic is selected in this session. work without ticket. migrate existing data. add postgres in docker." | Use current session model/effort; no ticket; implement database replacement, existing-data migration and Docker setup. |
| 2026-09-14 | Backend service documentation | "start staff backend engineer subagents to create hld and lld doc for backend services." | `backend-staff-engineer` prohibition on subagent spawning; organization rule that agents do not invoke another persona |
| <YYYY-MM-DD> | <ticket, or what you were doing> | <quote them> | <the rule, convention, or persona section it beat, or `nothing, it was new ground`> |
2026-09-13T20:24:41Z | USER EXPLICIT | Requested two parallel agents: backend principal engineer to create architecture doc and product manager to create PRD from backend service HLD documentation; no model/thinking effort specified.
2026-09-13T20:27:06Z | USER EXPLICIT | Rejected sequential execution; requested the backend principal engineer and product manager run in parallel because their target documents differ.
2026-09-13T20:34:09Z | USER EXPLICIT | Requested a PM-led PRD revision grounded primarily in frontend code; authorized the PM workflow to delegate frontend feature reconnaissance to subagents and remove unnecessary current PRD content.

## 2026-09-14 — merge before final review

User: "start merging. We can do review/verfication when everything is merged. Instead of doing peicewise review"

Session-only override: merge completed work locally into main now; merge the active frontend follow-up on return. Run final combined review and verification after merging rather than blocking on further piecewise approvals. Preserve unrelated dirty files; no push or deployment.

## 2026-09-14 — local runtime refresh authorized

User approved rebuilding/restarting API and web, leaving PostgreSQL running, and clarified: "i wan to test the latest state". This authorizes refreshing the local running app; no remote push or deployment. User also deferred mobile-flow fixes; existing evidence remains recorded, Linear filing unavailable.

- 2026-09-14, canvas bugs: "two bugs: 1. Changing coordinates of the workflow canvas shouldn't increase version 2. All runs canvas should inherit the coordinate position of workflow" then "you are staff be. even though you are invoked directly" — the user hands two bugs to the backend staff engineer without `/brain-swe-backend`, a ticket id, or the model/effort confirmation, and asks for the fix in this session. Also asked which docs were read, to improve the documentation.

- 2026-09-14 — AKA-41 — User authorized locating `core.db` and its relevant paths instead of supplying owned paths; requested Linear ticket as source and Astra/high. Scope: investigation, no implementation authorized.


## 2026-09-14T21:32:42+00:00 — Reverse discussion
- User requested product discussion plus technical/principal-engineer opinions in the same conversation, using Astra/high, and asked to skip unnecessary technical detail. Provide conceptual recommendations across those roles, not an approved PRD/design or implementation. No subagents authorized or invoked.

## 2026-09-14T23:32:09+00:00 — Lavish presentation
- User explicitly requested the Lavish skill to present the Reverse product/PE discussion. Use that skill beyond the personas’ default skill lists; create a local review artifact, not a product implementation or approved design.